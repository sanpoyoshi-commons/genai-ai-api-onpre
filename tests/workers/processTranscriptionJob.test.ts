import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReceivedJob } from '../../src/lib/queue/exAppQueue.js';
import { encodeTranscriptionJobMessage } from '../../src/lib/transcription/jobMessage.js';
import type { TranscriptionJobRecord } from '../../src/repositories/transcriptionJobRepository.js';
import type { TranscriptionAdapter } from '../../src/transcription/adapters/base.js';
import { TranscriptionError } from '../../src/transcription/errors.js';
import type { TranscribeResult } from '../../src/transcription/types.js';
import { createTranscriptionJobProcessor } from '../../src/workers/processTranscriptionJob.js';

function jobFor(jobName: string, receiveCount = 1): ReceivedJob {
  return {
    messageId: 'm-1',
    receiptHandle: 'r-1',
    body: encodeTranscriptionJobMessage({ jobName }),
    receiveCount,
  };
}

interface FakeRepoState {
  rows: Map<string, TranscriptionJobRecord>;
  inProgress: string[];
  completed: { jobName: string; languageCode: string; transcripts: unknown }[];
  failed: { jobName: string; error: string }[];
}

function fakeRepo(initial?: TranscriptionJobRecord) {
  const state: FakeRepoState = {
    rows: new Map(initial ? [[initial.jobName, initial]] : []),
    inProgress: [],
    completed: [],
    failed: [],
  };
  const repo = {
    state,
    async findByJobName(jobName: string) {
      return state.rows.get(jobName) ?? null;
    },
    async markInProgress(jobName: string) {
      state.inProgress.push(jobName);
    },
    async markCompleted(jobName: string, languageCode: string, transcripts: unknown) {
      state.completed.push({ jobName, languageCode, transcripts });
    },
    async markFailed(jobName: string, error: string) {
      state.failed.push({ jobName, error });
    },
  };
  return repo;
}

const fakeStorage = (audio = new Uint8Array([1, 2, 3])) => ({
  async getObject() {
    return audio;
  },
});

function fakeAdapter(result: TranscribeResult | (() => Promise<TranscribeResult>)): TranscriptionAdapter {
  return {
    backend: 'fake',
    async transcribe() {
      return typeof result === 'function' ? result() : result;
    },
  };
}

const queuedRecord = (jobName = 'job-1'): TranscriptionJobRecord => ({
  jobName,
  ownerUserId: 'u1',
  audioKey: 'u1/x/a.mp3',
  status: 'QUEUED',
  speakerLabel: false,
  maxSpeakers: 1,
  languageCode: null,
  transcripts: null,
});

test('happy path: IN_PROGRESS→正規化→COMPLETED 書き戻し・completed:true', async () => {
  const repo = fakeRepo(queuedRecord());
  const processJob = createTranscriptionJobProcessor({
    repo,
    storage: fakeStorage(),
    adapter: fakeAdapter({ language: 'ja', text: '', segments: [{ text: '今日 は 晴れ' }] }),
    audioBucket: 'audio',
  });

  const result = await processJob(jobFor('job-1'));
  assert.deepEqual(result, { completed: true });
  assert.deepEqual(repo.state.inProgress, ['job-1']);
  assert.equal(repo.state.completed.length, 1);
  assert.equal(repo.state.completed[0]?.languageCode, 'ja-JP');
  assert.deepEqual(repo.state.completed[0]?.transcripts, [{ transcript: '今日は晴れ' }]);
});

test('冪等: 行不在は再処理せず completed:true', async () => {
  const repo = fakeRepo(); // 行なし
  const processJob = createTranscriptionJobProcessor({
    repo,
    storage: fakeStorage(),
    adapter: fakeAdapter({ language: 'ja', text: '', segments: [] }),
    audioBucket: 'audio',
  });
  const result = await processJob(jobFor('missing'));
  assert.deepEqual(result, { completed: true });
  assert.equal(repo.state.inProgress.length, 0);
});

test('冪等: 既 COMPLETED は再処理しない', async () => {
  const repo = fakeRepo({ ...queuedRecord(), status: 'COMPLETED' });
  const processJob = createTranscriptionJobProcessor({
    repo,
    storage: fakeStorage(),
    adapter: fakeAdapter({ language: 'ja', text: '', segments: [] }),
    audioBucket: 'audio',
  });
  const result = await processJob(jobFor('job-1'));
  assert.deepEqual(result, { completed: true });
  assert.equal(repo.state.inProgress.length, 0);
  assert.equal(repo.state.completed.length, 0);
});

test('一過性エラー（retryable）は throw して再配信に委ねる（FAILED にしない）', async () => {
  const repo = fakeRepo(queuedRecord());
  const processJob = createTranscriptionJobProcessor({
    repo,
    storage: fakeStorage(),
    adapter: fakeAdapter(() =>
      Promise.reject(new TranscriptionError({ code: 'NETWORK', backend: 'fake', message: 'down', retryable: true })),
    ),
    audioBucket: 'audio',
  });
  await assert.rejects(() => processJob(jobFor('job-1')), TranscriptionError);
  assert.deepEqual(repo.state.inProgress, ['job-1']);
  assert.equal(repo.state.failed.length, 0);
});

test('恒久エラー（非 retryable）は FAILED 確定・completed:true（無限リトライ回避）', async () => {
  const repo = fakeRepo(queuedRecord());
  const processJob = createTranscriptionJobProcessor({
    repo,
    storage: fakeStorage(),
    adapter: fakeAdapter(() =>
      Promise.reject(
        new TranscriptionError({ code: 'INVALID_AUDIO', backend: 'fake', message: 'bad audio', retryable: false }),
      ),
    ),
    audioBucket: 'audio',
  });
  const result = await processJob(jobFor('job-1'));
  assert.deepEqual(result, { completed: true });
  assert.equal(repo.state.failed.length, 1);
  assert.equal(repo.state.failed[0]?.error, 'bad audio');
});
