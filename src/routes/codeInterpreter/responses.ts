import { basename } from 'node:path';
import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { badRequest, serverError } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import { resolveCodeInterpreterModel } from '../../lib/llm/models.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import { type SandboxError, isSandboxError } from '../../lib/sandbox/errors.js';
import type { SandboxInputFile } from '../../lib/sandbox/sandboxClient.js';
import type { CodeInterpreterDeps } from './deps.js';
import { orchestrate } from './orchestrator.js';
import { codeInterpreterSchema } from './schemas.js';

/**
 * Code Interpreter（POST /code-interpreter/responses、源内独自 IF 互換）。
 * 入力検証 → ファイル平坦化/サイズ検査 → orchestrate（コード生成 LLM↔サンドボックス）→ { outputs, artifacts[base64] }。
 * 入力エラーは 400、実行失敗・サンドボックス到達失敗は 500（源内 IF は 200/400/500）。
 */
export function createCodeInterpreterHandler(deps: CodeInterpreterDeps): RequestHandler {
  return createApiHandler(async ({ req, log }) => {
    const { inputs } = parseBody(codeInterpreterSchema, req.body);

    // 源内 IF: files[].files[] を平坦化し base64 をデコード。key は破棄。filename は basename のみ（パストラバーサル防御）。
    const files: SandboxInputFile[] = [];
    let totalBytes = 0;
    for (const group of inputs.files) {
      for (const f of group.files) {
        const bytes = Buffer.from(f.content, 'base64');
        totalBytes += bytes.length;
        files.push({ name: basename(f.filename), bytes });
      }
    }
    if (totalBytes > deps.config.maxTotalFileBytes) {
      throw badRequest(`入力ファイルの合計サイズが上限（${deps.config.maxTotalFileBytes} byte）を超えています。`);
    }

    const model = resolveCodeInterpreterModel();
    const requestId = currentRequestId() ?? '';

    let result: Awaited<ReturnType<typeof orchestrate>>;
    try {
      result = await orchestrate({
        llm: deps.llm,
        sandbox: deps.sandbox,
        config: deps.config,
        model,
        inputText: inputs.input_text,
        files,
        requestId,
      });
    } catch (err) {
      if (isSandboxError(err)) {
        log.warn(
          { event: 'code_interpreter_sandbox_error', error: { code: err.code, message: err.message } },
          'code interpreter sandbox unreachable',
        );
        throw serverError(sandboxErrorMessage(err));
      }
      throw err;
    }

    if (!result.ok) {
      // stderr はクライアントに出さずログのみ（情報漏えい防止）。
      log.warn(
        { event: 'code_interpreter_failed', stderr: result.lastStderr?.slice(0, 1000) },
        'code interpreter execution failed after retries',
      );
      throw serverError('コードの実行に失敗しました。入力データや指示を見直して再度お試しください。');
    }

    return { status: 200, body: { outputs: result.outputs, artifacts: result.artifacts } };
  });
}

function sandboxErrorMessage(err: SandboxError): string {
  switch (err.code) {
    case 'timeout':
      return 'コード実行がタイムアウトしました。';
    case 'down':
      return 'サンドボックスに接続できませんでした。サービスが起動しているか確認してください。';
    default:
      return 'コード実行サービスでエラーが発生しました。';
  }
}
