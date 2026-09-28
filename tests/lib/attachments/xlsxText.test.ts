import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractXlsxText } from '../../../src/lib/attachments/xlsxText.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/attachments/${name}`, import.meta.url))));

const OPTS = { maxChars: 5000 };

/** `dates.xlsx` の2行目（見出しの次）をタブで分けて返す。 */
async function valueRow(name: string): Promise<string[]> {
  const text = await extractXlsxText(fixture(name), OPTS);
  const lines = text.split('\n');
  const row = lines[2];
  assert.ok(row, `2行目が無い: ${text}`);
  return row.split('\t');
}

test('extractXlsxText: シートごとに見出しとタブ区切りの行を出す', async () => {
  const text = await extractXlsxText(fixture('sheet.xlsx'), OPTS);
  assert.ok(text.startsWith('[シート: 売上]'));
  assert.ok(text.includes('品名\t個数'));
  assert.ok(text.includes('りんご\t3'));
  assert.ok(text.includes('[シート: メモ]'));
});

// ── 日付・時刻（2026-09-27 の実機で見つかった不具合） ───────────────────────
// Excel は日付も時刻も「起点からの日数」という1つの数で持つ。時刻だけのセルは
// 起点の日（1899-12-30）の時刻になるので、日付の部分だけを出すと時刻が落ちる。

test('日付だけのセルは YYYY-MM-DD', async () => {
  assert.equal((await valueRow('dates.xlsx'))[0], '2026-09-27');
});

test('時刻だけのセル（21:21）は 21:21（1899-12-30 にしない）', async () => {
  // 実機で「1899-12-30」と出た件。1日の割合（0.8895833…）なので丸めも要る。
  assert.equal((await valueRow('dates.xlsx'))[1], '21:21');
});

test('日時のセルは YYYY-MM-DD HH:MM（ミリ秒の誤差を秒へ丸める）', async () => {
  // read-excel-file が返す Date は 2026-09-27T21:20:59.999Z。切り捨てると 21:20:59 になる。
  assert.equal((await valueRow('dates.xlsx'))[2], '2026-09-27 21:21');
});

test('秒が 0 でない時刻は HH:MM:SS', async () => {
  assert.equal((await valueRow('dates.xlsx'))[3], '09:05:07');
});

test('日付でない数はそのまま', async () => {
  assert.equal((await valueRow('dates.xlsx'))[4], '1234');
});

test('1904 年方式のブックでも同じに出る（起点は 1904-01-01）', async () => {
  // read-excel-file は 1904 方式を 1900 方式へ直してから Date にするので、
  // 時刻だけのセルは 1904-01-01 の時刻になる。両方の起点を見ている。
  assert.deepEqual(await valueRow('dates-1904.xlsx'), [
    '2026-09-27',
    '21:21',
    '2026-09-27 21:21',
    '09:05:07',
    '1234',
  ]);
});

test('時刻は UTC の getter で取り出す（実行環境の TZ に左右されない）', async () => {
  // 1899-12-30T21:21Z を地方時（例 JST）で読むと 1899-12-31 06:21 になる。
  // 21:21 が出ているなら UTC で読んでいる。`npm test` は TZ=Asia/Tokyo でも同じ結果になる。
  const row = await valueRow('dates.xlsx');
  assert.equal(row[1], '21:21');
  assert.ok(!row[1]?.includes('-'), '日付が混ざっていない');
});
