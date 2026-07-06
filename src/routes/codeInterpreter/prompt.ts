import type { SandboxInputFile } from '../../lib/sandbox/sandboxClient.js';

/**
 * Code Interpreter のコード生成 LLM へのプロンプト構築とコード抽出。
 *
 * 制約（CSV/Excel→pandas→matplotlib チャート）を system プロンプトで誘導するが、これは UX/効率のための
 * 誘導であって隔離の保証ではない（真の境界はサンドボックス）。日本語フォントはサンドボックス側 matplotlibrc で
 * 既定設定済のため、プロンプトでフォント指定を促さない（堅牢化）。チャートはカレントディレクトリに PNG 保存させ、
 * サンドボックスが output_globs（既定 *.png）で回収する。
 *
 * 列名の推測対策：コード生成 LLM にファイル名だけを渡すと、弱いモデルは列名（特に日本語列）を英語で決め打ちし、
 * 実データと不一致のコードを生成して PNG を出せないことがある。これを根本対処するため、CSV は先頭数行を
 * プレビューとして system プロンプトに添付し、かつ「列名を推測せず df.columns/df.head() で実列を確認する」よう
 * 明示する。プレビューはサイズ上限で打ち切る（大きな CSV による文脈圧迫を防ぐ）。Excel はバイナリのため添付しない。
 */

/** CSV プレビューの上限（文脈圧迫を避ける）。 */
const PREVIEW_MAX_LINES = 8;
const PREVIEW_MAX_LINE_LEN = 200;

/** CSV ファイルの先頭プレビューを作る。実カラム名をコード生成 LLM に見せて列名の推測を防ぐ。CSV 以外は null。 */
function buildCsvPreview(file: SandboxInputFile): string | null {
  if (!file.name.toLowerCase().endsWith('.csv')) return null;
  const lines = file.bytes
    .toString('utf-8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(0, PREVIEW_MAX_LINES)
    .map((l) => (l.length > PREVIEW_MAX_LINE_LEN ? `${l.slice(0, PREVIEW_MAX_LINE_LEN)}…` : l));
  if (lines.length === 0) return null;
  return [`${file.name} の先頭 ${lines.length} 行:`, '```', ...lines, '```'].join('\n');
}

/** コード生成用 system プロンプト。入力ファイル名＋CSV 先頭プレビューを埋め込む。 */
export function buildSystemPrompt(files: SandboxInputFile[]): string {
  const fileList = files.length > 0 ? files.map((f) => `- ${f.name}`).join('\n') : '（添付ファイルなし）';
  const previews = files.map(buildCsvPreview).filter((p): p is string => p !== null);

  const lines: string[] = [
    'あなたは CSV/Excel データを分析する Python コードを書くアシスタントです。',
    '次の入力ファイルがカレントディレクトリにあります:',
    fileList,
  ];
  if (previews.length > 0) {
    lines.push('', '入力データの先頭プレビュー（実際の列名・構造はこれに従うこと）:', ...previews);
  }
  lines.push(
    '',
    '規約:',
    '- pandas で読み込む（CSV は pandas.read_csv、Excel は pandas.read_excel(engine="openpyxl")）。',
    '- 列名は推測・ハードコードしない。読み込んだ後に df.columns / df.head() で実際の列名を確認してから使う（列名が日本語でもそのまま使う）。',
    '- グラフは matplotlib で描き、PNG としてカレントディレクトリに保存する（例: plt.savefig("chart.png")）。plt.show() は使わない。',
    '- 日本語フォントは設定済みです。フォント指定のコードは書かず、そのまま日本語ラベルを使ってください。',
    '- ネットワークは使用できません（外部ダウンロード・pip install は不可）。標準ライブラリと pandas / numpy / matplotlib / openpyxl のみ使用可能。',
    '- 分析結果の説明を最後に print() で日本語出力してください（この出力が利用者への回答になります）。',
    '',
    '出力は ```python ... ``` の単一コードブロックのみとし、前置きや解説は書かないでください。',
  );
  return lines.join('\n');
}

/** 実行失敗時の修正依頼メッセージ（stderr を添えて再生成を促す）。 */
export function buildRepairMessage(stderr: string): string {
  const trimmed = stderr.slice(0, 4000);
  return [
    '直前のコードの実行が失敗しました。以下のエラーを修正した完全なコードを再度出力してください。',
    '',
    'エラー出力:',
    '```',
    trimmed,
    '```',
    '',
    '修正後の完全なコードを ```python ... ``` の単一ブロックで出力してください。',
  ].join('\n');
}

/** LLM 出力から Python コードを抽出する。```python フェンス優先、無ければ生フェンス、それも無ければ全文。 */
export function extractCode(llmOutput: string): string {
  const fenced = llmOutput.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return llmOutput.trim();
}
