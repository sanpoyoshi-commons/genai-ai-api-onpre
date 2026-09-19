/**
 * 法令名の「固有部分（識別子）」抽出と一致判定（**on-prem 独自追加・移植元 Lawsy に対応物なし**）。
 *
 * 上流との差分（明示）:
 *   上流 Lawsy は段1の法令名推定を Gemini＋Google 検索 grounding で行うため、「クエリが指す法令が
 *   実在するか」を web が保証していた。on-prem は web を持たないので、**手元の法令名マスタ
 *   （app_laws_master・約 7.8k 法令）を辞書として引くこと**で同じ保証を作る。その照合キーが本モジュール。
 *
 * なぜ bigram だけでは足りないか（実測・2026-09-19 / pg_bigm 1.2）:
 *   bigm_similarity('防災庁設置法','復興庁設置法') = **0.5714**。pg_bigm の既定 similarity_limit は 0.3 で、
 *   「◯◯庁設置法」同士は `庁設`／`設置`／`置法` を共有するため**表層類似だけでは別法令を弾けない**。
 *   法令名の識別力は先頭の固有部分（防災／復興）にあるので、固有部分の一致を**必須条件**に昇格させる。
 *
 * 規則ベースで足りる（形態素解析器を足さない）のは、法令名の命名が「固有部分＋定型の法形式接尾辞」という
 * 定型だからである。剥がし過ぎ（「民法」→「民」）は識別力を失うので、MIN_IDENTIFIER_LENGTH 未満に
 * なったら名称全体へ戻す。
 */

import { extractLawNamesFromQuery } from './lawNameEstimator.js';

/** 識別子として認める最小長。これ未満に削れたら剥がさず名称全体を識別子とする（「民法」→「民法」）。 */
export const MIN_IDENTIFIER_LENGTH = 2;

/**
 * 制定番号だけの題名（例「大正三年法律第三十七号（公共団体ノ管理スル…法律）」）を検出するパターン。
 * 旧法令は題名を持たず「元号◯年◯法律第N号」で呼ばれ、実質の題名は括弧内に入っている。
 */
const ENACTMENT_NUMBER =
  /(明治|大正|昭和|平成|令和)[一二三四五六七八九十百元]+年[^（()）]*?第[一二三四五六七八九十百千]+号/g;

/** 括弧書き（1 段・入れ子なし）。 */
const PARENTHETICAL = /[（(][^（()）]*[)）]/g;

/** 最初の括弧書きの中身（制定番号だけの題名から実質の題名を取り出す）。 */
const FIRST_PARENTHETICAL_BODY = /[（(]([^（()）]*)[)）]/;

/**
 * 比較キーを作るときに落とす助詞（「個人情報保護」と「個人情報の保護」を同一視する）。
 * 語中に現れても意味を担わない字だけに絞る（「等」は「均等」「高等」の一部になり得るため末尾のみ落とす）。
 */
const PARTICLES = /[のにをはがともへや]/g;

/** 識別子末尾の「等」（「◯◯の切替え等」と「◯◯の切替え」を同一視する）。語中の「等」は残す。 */
const TRAILING_ETC = /等+$/;

/**
 * 法形式の接尾辞（長い順に反復して剥がす）。法令名は「固有部分＋法形式」で構成され、
 * 法形式は識別に寄与しない（「◯◯庁設置法」の「設置法」は全省庁で共通）。
 */
const SUFFIXES: readonly string[] = [
  'の施行に伴う関係法律の整備等に関する法律',
  'の施行に伴う関係政令の整備等に関する政令',
  'の一部を改正する法律',
  'の一部を改正する政令',
  'の一部を改正する省令',
  'の一部を改正する規則',
  'に関する法律施行令',
  'に関する法律施行規則',
  'の特例に関する法律',
  'に関する法律',
  'に関する政令',
  'に関する省令',
  'に関する府令',
  'に関する規則',
  'に関する命令',
  'に関する件',
  'を定める政令',
  'を定める省令',
  'を定める規則',
  'を定める件',
  '法律施行令',
  '法律施行規則',
  '法施行令',
  '法施行規則',
  '施行令',
  '施行規則',
  '施行法',
  '設置法',
  '組織令',
  '組織規則',
  'の特例',
  '法律',
  '省令',
  '政令',
  '府令',
  '条例',
  '規則',
  '命令',
  '法',
  '令',
  '律',
  '等',
].slice().sort((a, b) => b.length - a.length);

/** 接尾辞剥がしの反復上限（「◯◯法施行規則等の一部を改正する省令」のような多重接尾辞を想定）。 */
const MAX_STRIP_ROUNDS = 6;

/**
 * 法令名を照合用に正規化する。NFKC（全角半角の統一）→空白除去→括弧書き除去→制定番号除去。
 * 制定番号と括弧を落として空になる旧法令は、括弧内（＝実質の題名）を採る。
 */
export function normalizeLawName(name: string): string {
  const base = (name ?? '')
    .normalize('NFKC')
    .replace(/[\s　]/g, '');
  const outside = base.replace(PARENTHETICAL, '').replace(ENACTMENT_NUMBER, '').trim();
  if (outside.length > 0) {
    return outside;
  }
  const inner = base.match(FIRST_PARENTHETICAL_BODY)?.[1]?.trim();
  return inner && inner.length > 0 ? inner : base;
}

/** 正規化済み名称から法形式の接尾辞を反復的に剥がす。 */
function stripFormSuffix(normalized: string): string {
  let s = normalized;
  for (let round = 0; round < MAX_STRIP_ROUNDS; round += 1) {
    const hit = SUFFIXES.find((suf) => s.length > suf.length && s.endsWith(suf));
    if (!hit) {
      break;
    }
    s = s.slice(0, -hit.length);
  }
  return s;
}

/**
 * 法令名から固有部分（識別子）を取り出す。「防災庁設置法」→「防災庁」／「民法」→「民法」
 * （剥がすと 1 文字になるため名称全体へ戻す）。
 */
export function extractLawIdentifier(name: string): string {
  const normalized = normalizeLawName(name);
  const stripped = stripFormSuffix(normalized);
  return stripped.length < MIN_IDENTIFIER_LENGTH ? normalized : stripped;
}

/**
 * 識別子の比較キー（助詞を落として表記ゆれを吸収）。「個人情報保護」と「個人情報の保護」を同一視する。
 * 2 文字未満へ潰れる場合は潰す前の識別子を返す（比較キーが短すぎると誤一致するため）。
 */
export function identifierKey(identifier: string): string {
  const key = (identifier ?? '').replace(TRAILING_ETC, '').replace(PARTICLES, '');
  return key.length < MIN_IDENTIFIER_LENGTH ? (identifier ?? '') : key;
}

/**
 * 2 つの法令名の固有部分が一致するか（**あいまい候補を通す必須条件**）。
 *
 * 比較キーの**完全一致のみ**を採る。包含（片方がもう片方を含む）も一度検討したが、
 * `identifiersMatch('会社法','会社更生法')` が「会社」⊂「会社更生」で通ってしまい（実測）、
 * 安全側（迷ったら条文を出さない）の方針に反するため採らない。通称→正式名称の距離は
 * 上流 web grounding の代わりに置いた通称辞書（LAW_RAG_ALIASES_FILE）が先に吸収する。
 */
export function identifiersMatch(nameA: string, nameB: string): boolean {
  const a = identifierKey(extractLawIdentifier(nameA));
  const b = identifierKey(extractLawIdentifier(nameB));
  if (a.length < MIN_IDENTIFIER_LENGTH || b.length < MIN_IDENTIFIER_LENGTH) {
    return false;
  }
  return a === b;
}

/**
 * 候補法令名の固有部分がクエリ本文と両立するか（**段1 が空でクエリ直検索へ落ちた経路の必須条件**）。
 *
 * 2 段構えにする。
 *
 * 1. **クエリが法令名らしき語を名乗っている場合**（「宇宙移民法の要件は」の「宇宙移民法」）は、その語と
 *    固有部分どうしを突き合わせる。単なる部分文字列の包含だと **「宇宙移民法」に「民法」が含まれる**ため
 *    民法が通ってしまう（法令名マスタ 7,826 件の全数探索で実際に検出・2026-09-19）。
 * 2. **法令名を名乗らない自然文**（「防災庁はもう設置されていますか」）は突き合わせる語が無いので、
 *    固有部分がクエリ本文に現れるかで判定する。「防災庁」は現れるが「復興庁」は現れない。
 *
 * これが web grounding の代わりに「最近傍 1 件を無条件に採る」のを止める歯止めになる。
 */
export function identifierAppearsInQuery(candidateLawName: string, query: string): boolean {
  const id = identifierKey(extractLawIdentifier(candidateLawName));
  if (id.length < MIN_IDENTIFIER_LENGTH) {
    return false;
  }
  // 段1 と同じ抽出規則を使う（法令名らしき語の定義を 2 箇所に持たない）。
  const spoken = extractLawNamesFromQuery(query);
  if (spoken.length > 0) {
    return spoken.some((name) => identifiersMatch(name, candidateLawName));
  }
  const q = identifierKey(normalizeLawName(query));
  return q.includes(id);
}
