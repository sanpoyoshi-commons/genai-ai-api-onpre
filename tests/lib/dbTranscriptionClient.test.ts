import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DbTranscriptionClient } from '../../src/lib/transcription/dbTranscriptionClient.js';
import { decodeTranscriptionJobMessage } from '../../src/lib/transcription/jobMessage.js';
import type {
  CreateTranscriptionJobInput,
  TranscriptionJobRecord,
  TranscriptionJobRepository,
} from '../../src/repositories/transcriptionJobRepository.js';

function fakeQueue() {
  const enqueued: string[] = [];
  return {
    enqueued,
    async enqueueJob(body: string) {
      enqueued.push(body);
    },
  };
}

function fakeRepo(row?: TranscriptionJobRecord) {
  const created: CreateTranscriptionJobInput[] = [];
  const deleted: string[] = [];
  const repo = {
    created,
    deleted,
    async create(input: CreateTranscriptionJobInput) {
      created.push(input);
    },
    async findByJobName(_jobName: string) {
      return row ?? null;
    },
    async deleteByJobName(jobName: string) {
      deleted.push(jobName);
    },
  };
  return repo as unknown as TranscriptionJobRepository & {
    created: CreateTranscriptionJobInput[];
    deleted: string[];
  };
}

test('startJob: QUEUED 行を作成し jobName をキューへ投入して返す', async () => {
  const queue = fakeQueue();
  const repo = fakeRepo();
  const client = new DbTranscriptionClient({ queue, repo });

  const { jobName } = await client.startJob({
    audioKey: 'u1/x/a.mp3',
    speakerLabel: true,
    maxSpeakers: 2,
    userId: 'u1',
  });

  assert.ok(jobName.length > 0);
  assert.equal(repo.created.length, 1);
  assert.equal(repo.created[0]?.ownerUserId, 'u1');
  assert.equal(repo.created[0]?.audioKey, 'u1/x/a.mp3');
  assert.equal(repo.created[0]?.jobName, jobName);
  // キューにはトリガとして jobName のみが載る。
  assert.equal(queue.enqueued.length, 1);
  assert.deepEqual(decodeTranscriptionJobMessage(queue.enqueued[0] ?? ''), { jobName });
});

test('startJob: enqueue 失敗時は QUEUED 起票を補償削除し元例外を再送出（孤児行を残さない・項④）', async () => {
  const repo = fakeRepo();
  const boom = new Error('queue down');
  const queue = {
    async enqueueJob(_body: string) {
      throw boom;
    },
  };
  const client = new DbTranscriptionClient({ queue, repo });

  await assert.rejects(
    () =>
      client.startJob({ audioKey: 'u1/x/a.mp3', speakerLabel: false, maxSpeakers: 1, userId: 'u1' }),
    (e: unknown) => e === boom, // 元例外をそのまま伝播（握りつぶさない）
  );
  // 起票した行はちょうど補償削除されている。
  assert.equal(repo.created.length, 1);
  assert.deepEqual(repo.deleted, [repo.created[0]?.jobName]);
});

test('getJob: COMPLETED は languageCode＋transcripts を同梱', async () => {
  const queue = fakeQueue();
  const repo = fakeRepo({
    jobName: 'job-1',
    ownerUserId: 'u1',
    audioKey: 'u1/x/a.mp3',
    status: 'COMPLETED',
    speakerLabel: false,
    maxSpeakers: 1,
    languageCode: 'ja-JP',
    transcripts: [{ transcript: 'こんにちは' }],
  });
  const client = new DbTranscriptionClient({ queue, repo });

  const job = await client.getJob('job-1');
  assert.deepEqual(job, {
    jobName: 'job-1',
    ownerUserId: 'u1',
    status: 'COMPLETED',
    languageCode: 'ja-JP',
    transcripts: [{ transcript: 'こんにちは' }],
  });
});

test('getJob: IN_PROGRESS は status のみ（transcripts/languageCode を省く）', async () => {
  const queue = fakeQueue();
  const repo = fakeRepo({
    jobName: 'job-1',
    ownerUserId: 'u1',
    audioKey: 'u1/x/a.mp3',
    status: 'IN_PROGRESS',
    speakerLabel: false,
    maxSpeakers: 1,
    languageCode: null,
    transcripts: null,
  });
  const client = new DbTranscriptionClient({ queue, repo });

  const job = await client.getJob('job-1');
  assert.deepEqual(job, { jobName: 'job-1', ownerUserId: 'u1', status: 'IN_PROGRESS' });
});

test('getJob: 不在は null', async () => {
  const client = new DbTranscriptionClient({ queue: fakeQueue(), repo: fakeRepo() });
  assert.equal(await client.getJob('missing'), null);
});
