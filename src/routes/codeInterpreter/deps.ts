import type { CodeInterpreterConfig } from '../../lib/sandbox/config.js';
import type { LlmClient } from '../../lib/llm/llmClient.js';
import type { SandboxClient } from '../../lib/sandbox/sandboxClient.js';

/** codeInterpreter Router の依存（注入式＝ユニットテストで fake 差し替え可）。 */
export interface CodeInterpreterDeps {
  /** コード生成 LLM。predict と同じ抽象化レイヤー seam を再利用する。 */
  llm: LlmClient;
  /** 実行（NsJail サンドボックスへの HTTP 委譲）seam。 */
  sandbox: SandboxClient;
  /** 実行制御（タイムアウト・試行回数・サイズ上限）。 */
  config: CodeInterpreterConfig;
}
