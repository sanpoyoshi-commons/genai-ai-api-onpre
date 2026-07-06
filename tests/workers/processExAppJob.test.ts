import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { encodeJobMessage } from '../../src/lib/exapp/jobMessage.js';
import type { ReceivedJob } from '../../src/lib/queue/exAppQueue.js';
import type { HistoryKey, HistoryStatus } from '../../src/repositories/invokeHistoryRepository.js';
import { createExAppJobProcessor, type ExAppStatusChecker } from '../../src/workers/processExAppJob.js';

const message = { teamId: 'team-1', exAppId: 'app-1', userId: 'user-1', createdDate: '2026-05-26T00:00:00.000Z' };

function jobWith(body: string, receiveCount = 1): ReceivedJob {
  return { messageId: 'm-1', receiptHandle: 'r-1', body, receiveCount };
}

interface RecordedUpdate {
  key: HistoryKey;
  status: HistoryStatus;
  outputs: unknown;
}

function fakeHistories() {
  const updates: RecordedUpdate[] = [];
  return {
    updates,
    async updateResult(key: HistoryKey, status: HistoryStatus, outputs: unknown) {
      updates.push({ key, status, outputs });
    },
  };
}

test('未完了（done=false）は履歴を更新せず completed:false', async () => {
  const histories = fakeHistories();
  const checkStatus: ExAppStatusChecker = async () => ({ done: false });
  const processJob = createExAppJobProcessor({ histories, checkStatus });

  const result = await processJob(jobWith(encodeJobMessage(message)));
  assert.deepEqual(result, { completed: false });
  assert.equal(histories.updates.length, 0);
});

test('完了（done=true）は success と outputs で履歴更新し completed:true', async () => {
  const histories = fakeHistories();
  const checkStatus: ExAppStatusChecker = async () => ({ done: true, status: 'success', outputs: { value: 42 } });
  const processJob = createExAppJobProcessor({ histories, checkStatus });

  const result = await processJob(jobWith(encodeJobMessage(message)));
  assert.deepEqual(result, { completed: true });
  assert.equal(histories.updates.length, 1);
  const update = histories.updates[0];
  assert.equal(update?.status, 'success');
  assert.deepEqual(update?.outputs, { value: 42 });
  // 複合キーは createdDate を Date へ復元して渡す。
  assert.deepEqual(update?.key, {
    teamId: 'team-1',
    exAppId: 'app-1',
    userId: 'user-1',
    createdDate: new Date('2026-05-26T00:00:00.000Z'),
  });
});

test('error 完了は status=error で履歴更新', async () => {
  const histories = fakeHistories();
  const checkStatus: ExAppStatusChecker = async () => ({ done: true, status: 'error' });
  const processJob = createExAppJobProcessor({ histories, checkStatus });

  const result = await processJob(jobWith(encodeJobMessage(message)));
  assert.deepEqual(result, { completed: true });
  assert.equal(histories.updates[0]?.status, 'error');
  assert.equal(histories.updates[0]?.outputs, null);
});

test('不正なジョブ body は ZodError（状態確認に到達しない）', async () => {
  const histories = fakeHistories();
  let called = false;
  const checkStatus: ExAppStatusChecker = async () => {
    called = true;
    return { done: true };
  };
  const processJob = createExAppJobProcessor({ histories, checkStatus });

  await assert.rejects(() => processJob(jobWith(JSON.stringify({ teamId: 'only' }))), ZodError);
  assert.equal(called, false);
  assert.equal(histories.updates.length, 0);
});
