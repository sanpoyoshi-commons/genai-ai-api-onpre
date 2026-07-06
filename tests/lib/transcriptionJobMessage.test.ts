import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import {
  decodeTranscriptionJobMessage,
  encodeTranscriptionJobMessage,
} from '../../src/lib/transcription/jobMessage.js';

test('encode/decode 往復で jobName を保つ', () => {
  const body = encodeTranscriptionJobMessage({ jobName: 'job-abc' });
  assert.deepEqual(decodeTranscriptionJobMessage(body), { jobName: 'job-abc' });
});

test('jobName 欠落は ZodError', () => {
  assert.throws(() => decodeTranscriptionJobMessage(JSON.stringify({})), ZodError);
});
