/**
 * 構造起点ハイブリッドチャンキング。
 *
 * 一次分割＝Markdown 見出し（# / ## / ###）で意味境界を切り、見出し階層を headerPath に持つ。
 * 二次分割＝見出しセクションが max_chunk_size を超えたら Recursive 分割（separators を順に試し、
 * 日本語句読点「。」「、」を含める）で overlap 付きに割る。構造が無い文書（プレーンテキスト）は
 * 一次分割が 1 セクションになり二次分割だけが効く＝頑健なフォールバック。
 *
 * サイズは文字数で測る（トークンカウント方式は後続で確定する暫定。embedding/LLM の
 * tokenizer 差を避け、まずは文字数プロキシ。max_chunk_size の既定は 1000「トークン」を文字数で代用）。
 * アルゴリズムは LangChain RecursiveCharacterTextSplitter の merge_splits に準拠した自前実装（外部依存なし）。
 */

/** チャンク（格納・検索の最小単位）。headerPath は参照表示用の見出し階層。 */
export interface DocumentChunk {
  /** 文書内の連番（0 起点）。 */
  index: number;
  /** チャンク本文（embedding 対象・pg_bigm 全文検索対象）。 */
  text: string;
  /** 見出し階層（"H1 > H2" 等）。見出し無し文書では undefined。 */
  headerPath?: string;
}

export interface ChunkOptions {
  /** チャンク最大サイズ（文字数プロキシ・既定 1000＝LLM 学習時 1024t 安全圏）。 */
  maxChunkSize: number;
  /** チャンク重なり（文字数・既定 120＝10-15%）。 */
  chunkOverlap: number;
  /** Recursive 分割の区切り（優先順・日本語句読点含む）。 */
  separators: string[];
}

/** 既定の区切り（英語句読点に「。」「、」を追加）。空文字は文字単位フォールバック。 */
export const DEFAULT_SEPARATORS = ['\n\n', '\n', '。', '、', ' ', ''];

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChunkSize: 1000,
  chunkOverlap: 120,
  separators: DEFAULT_SEPARATORS,
};

interface Section {
  headerPath?: string;
  body: string;
}

/** Markdown 見出し（# / ## / ###）で一次分割し、見出し階層を headerPath に積む。 */
function splitByMarkdownHeaders(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) {
      const headerPath = stack.map((s) => s.title).join(' > ');
      sections.push({ headerPath: headerPath || undefined, body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const level = (m[1] ?? '').length;
      const title = m[2] ?? '';
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
        stack.pop();
      }
      stack.push({ level, title });
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    const body = text.trim();
    return body ? [{ body }] : [];
  }
  return sections;
}

/** 区切りで分割した断片を、max を超えない範囲で結合しつつ overlap を残す（LangChain merge_splits 準拠）。 */
function mergeSplits(splits: string[], separator: string, maxSize: number, overlap: number): string[] {
  const sepLen = separator.length;
  const docs: string[] = [];
  let current: string[] = [];
  let total = 0;

  for (const d of splits) {
    const dLen = d.length;
    if (total + dLen + (current.length > 0 ? sepLen : 0) > maxSize && current.length > 0) {
      const doc = current.join(separator).trim();
      if (doc) {
        docs.push(doc);
      }
      // overlap を残しつつ先頭から押し出す。
      while (
        current.length > 0 &&
        (total > overlap || (total + dLen + (current.length > 0 ? sepLen : 0) > maxSize && total > 0))
      ) {
        const removed = current.shift() as string;
        total -= removed.length + (current.length > 0 ? sepLen : 0);
      }
    }
    current.push(d);
    total += dLen + (current.length > 1 ? sepLen : 0);
  }
  const doc = current.join(separator).trim();
  if (doc) {
    docs.push(doc);
  }
  return docs;
}

/** Recursive 分割：先頭から使える区切りを選び、超過断片は次の区切りで再帰分割する。 */
function recursiveSplit(text: string, separators: string[], maxSize: number, overlap: number): string[] {
  let separator = separators[separators.length - 1] ?? '';
  let nextSeparators: string[] = [];
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i] as string;
    if (s === '') {
      separator = '';
      break;
    }
    if (text.includes(s)) {
      separator = s;
      nextSeparators = separators.slice(i + 1);
      break;
    }
  }

  const splits = separator === '' ? Array.from(text) : text.split(separator);
  const finalChunks: string[] = [];
  let goodSplits: string[] = [];

  for (const s of splits) {
    if (s.length < maxSize) {
      goodSplits.push(s);
    } else {
      if (goodSplits.length > 0) {
        finalChunks.push(...mergeSplits(goodSplits, separator, maxSize, overlap));
        goodSplits = [];
      }
      if (nextSeparators.length > 0) {
        finalChunks.push(...recursiveSplit(s, nextSeparators, maxSize, overlap));
      } else {
        finalChunks.push(s);
      }
    }
  }
  if (goodSplits.length > 0) {
    finalChunks.push(...mergeSplits(goodSplits, separator, maxSize, overlap));
  }
  return finalChunks;
}

/**
 * 文書をチャンク列へ分割する（C-4）。見出しで一次分割→各セクションを max を超える分だけ Recursive 二次分割。
 * 空白のみのチャンクは捨て、連番を 0 起点で振り直す。
 */
export function chunkDocument(text: string, options?: Partial<ChunkOptions>): DocumentChunk[] {
  const opts: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const sections = splitByMarkdownHeaders(text);

  const pieces: Array<{ text: string; headerPath?: string }> = [];
  for (const section of sections) {
    for (const sub of recursiveSplit(section.body, opts.separators, opts.maxChunkSize, opts.chunkOverlap)) {
      const trimmed = sub.trim();
      if (trimmed) {
        pieces.push({ text: trimmed, headerPath: section.headerPath });
      }
    }
  }

  return pieces.map((p, i) => ({ index: i, text: p.text, headerPath: p.headerPath }));
}
