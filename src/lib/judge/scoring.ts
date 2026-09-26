/**
 * 1 トークン目の候補分布から答えを決める（-onpre 新規）。
 *
 * モデルは選択肢そのもの（`A`）だけでなく、先頭に空白の付いたトークン（` A`）・書式付き（`**`）・
 * 全角（`Ａ`）・本文断片を候補に混ぜてくる（2026-09-22 実機で確認）。そこで
 * **trim → NFKC → 大文字化**で正規化して候補に照合し、**同一候補に落ちたものは確率を合算**してから
 * 候補集合の中で再正規化する。候補が 1 つも現れなかった場合は一様分布で埋めず、エラーにする
 * （「判定できなかった」ことを黙って確からしい答えに見せない）。
 */

import { JudgeError } from './errors.js';

export interface TokenLogprob {
  token: string;
  logprob: number;
}

export interface CandidateScores {
  /** 候補ラベル → 再正規化後の確率（候補外は 0）。 */
  probabilities: Record<string, number>;
  /** 最大確率の候補ラベル（同率は labels の並び順で先勝ち＝決定論的）。 */
  top: string;
  /** 本家式 confidence。 */
  confidence: number;
}

/** 表示・比較用の丸め桁（確率・confidence 共通）。 */
const PRECISION = 6;

const round = (v: number): number => Number(v.toFixed(PRECISION));

/** 先頭末尾の非英数字（`**`、バッククォート、句読点など）を落とす。 */
const stripPunctuation = (v: string): string => v.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** トークン正規化：trim → NFKC → 大文字化。全角「Ｂ」・先頭空白付き「 B」を同一視する。 */
export function normalizeToken(token: string): string {
  return token.trim().normalize('NFKC').toUpperCase();
}

/**
 * 正規化済みトークンを候補ラベルへ写像する。次の順で、いずれも**一意に定まる場合のみ**採用する。
 *  1. 完全一致（`B` → B）
 *  2. 前後の記号を落として完全一致（`**B**`、`B.`、`"B"` → B）
 *  3. トークンが候補の先頭部分（`Y` → `YES`。num_predict:1 では複数トークン語の頭しか見えないため）
 *
 * 逆向き（候補がトークンの先頭部分）は採らない。`ALSO` を候補 `A` として数えてしまうため。
 */
function matchLabel(normalized: string, normalizedLabels: Map<string, string>): string | undefined {
  if (normalized === '') {
    return undefined;
  }
  const exact = normalizedLabels.get(normalized);
  if (exact !== undefined) {
    return exact;
  }
  const stripped = stripPunctuation(normalized);
  if (stripped !== '' && stripped !== normalized) {
    const viaStrip = normalizedLabels.get(stripped);
    if (viaStrip !== undefined) {
      return viaStrip;
    }
  }
  const prefixHits: string[] = [];
  for (const [key, label] of normalizedLabels) {
    if (key.startsWith(normalized)) {
      prefixHits.push(label);
    }
  }
  return prefixHits.length === 1 ? prefixHits[0] : undefined;
}

/** 本家式 confidence：clamp((N × max_p − 1) / (N − 1), 0, 1)。N は候補数。 */
export function confidenceOf(maxProbability: number, candidateCount: number): number {
  if (candidateCount < 2) {
    return 0;
  }
  const raw = (candidateCount * maxProbability - 1) / (candidateCount - 1);
  return round(Math.min(1, Math.max(0, raw)));
}

/**
 * 候補分布を求める。logprob → 確率へ戻し、候補ごとに合算して候補集合の中で再正規化する。
 * 候補が 1 つも現れなければ JudgeError('no_candidate')。
 */
export function scoreCandidates(entries: TokenLogprob[], labels: string[]): CandidateScores {
  const normalizedLabels = new Map<string, string>();
  for (const label of labels) {
    normalizedLabels.set(normalizeToken(label), label);
  }

  const mass = new Map<string, number>(labels.map((label) => [label, 0]));
  let total = 0;
  for (const entry of entries) {
    const label = matchLabel(normalizeToken(entry.token), normalizedLabels);
    if (label === undefined) {
      continue;
    }
    const p = Math.exp(entry.logprob);
    mass.set(label, (mass.get(label) ?? 0) + p);
    total += p;
  }

  if (total <= 0) {
    throw new JudgeError(
      'no_candidate',
      '判定できませんでした（モデルの上位候補に選択肢が含まれませんでした）',
    );
  }

  const probabilities: Record<string, number> = {};
  let top = labels[0] ?? '';
  let topRaw = -1;
  for (const label of labels) {
    const p = (mass.get(label) ?? 0) / total;
    probabilities[label] = round(p);
    if (p > topRaw) {
      topRaw = p;
      top = label;
    }
  }

  return { probabilities, top, confidence: confidenceOf(topRaw, labels.length) };
}

/** score の期待値 Σ i·pᵢ（i は段階の添字＝0 始まり）。 */
export function expectedScore(probabilities: Record<string, number>, labels: string[]): number {
  let sum = 0;
  labels.forEach((label, i) => {
    sum += i * (probabilities[label] ?? 0);
  });
  return round(sum);
}
