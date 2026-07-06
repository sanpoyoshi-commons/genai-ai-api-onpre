import type { CodeInterpreterConfig } from '../../lib/sandbox/config.js';
import type { LlmClient } from '../../lib/llm/llmClient.js';
import type { SandboxClient, SandboxInputFile } from '../../lib/sandbox/sandboxClient.js';
import type { UnrecordedMessage } from '../../types/genaiWeb.js';
import { buildRepairMessage, buildSystemPrompt, extractCode } from './prompt.js';

/**
 * Code Interpreter のオーケストレーション（①コード生成 LLM ↔ ②サンドボックス実行の bounded 再試行ループ）。
 *
 * 生成 → 実行 → 失敗なら stderr を LLM に戻して修正させる、を maxAttempts まで繰り返す（既定 3＝初回＋2 リトライ）。
 * maxAttempts=1 で単発。サンドボックス到達失敗（SandboxError）は execute が throw し、ここでは握らず呼び出し側
 * （ハンドラ）が 500 に写像する。コード実行の失敗（status error/timeout）はループの再試行対象。
 * Express 非依存の純関数＝unit テストで再試行回数を assert できる。
 */
export interface OrchestrateInput {
  llm: LlmClient;
  sandbox: SandboxClient;
  config: CodeInterpreterConfig;
  /** 解決済みコード生成モデル ID。 */
  model: string;
  /** 利用者の分析指示（源内 IF の input_text）。 */
  inputText: string;
  /** 分析対象ファイル。 */
  files: SandboxInputFile[];
  requestId: string;
}

export interface OrchestrateArtifact {
  display_name: string;
  content: string;
}

export interface OrchestrateResult {
  ok: boolean;
  /** 成功時の説明文（実行 stdout）。 */
  outputs: string;
  artifacts: OrchestrateArtifact[];
  /** 失敗時の最終 stderr（ログ用、クライアントには出さない）。 */
  lastStderr?: string;
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { llm, sandbox, config, model, inputText, files, requestId } = input;

  const messages: UnrecordedMessage[] = [
    { role: 'system', content: buildSystemPrompt(files) },
    { role: 'user', content: inputText },
  ];

  let lastStderr = '';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const raw = await llm.generate({ model, messages, requestId });
    const code = extractCode(raw);
    const result = await sandbox.execute({ code, files, timeoutMs: config.execTimeoutMs, requestId });

    if (result.status === 'ok') {
      const artifacts = result.files
        .filter((f) => f.name.toLowerCase().endsWith('.png'))
        .map((f) => ({ display_name: f.name, content: f.bytes.toString('base64') }));
      const outputs = result.stdout.trim() || '分析が完了しました。';
      return { ok: true, outputs, artifacts };
    }

    // 失敗（error/timeout）。残回数があれば直近のコードとエラーを履歴に積んで修正を促す。
    lastStderr = result.stderr.trim() || (result.status === 'timeout' ? '実行がタイムアウトしました。' : '');
    if (attempt < config.maxAttempts) {
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRepairMessage(lastStderr) });
    }
  }

  return { ok: false, outputs: '', artifacts: [], lastStderr };
}
