import type { RequestHandler } from 'express';
import type { EnabledUseCases, UseCaseKey } from '../lib/config/enabledUseCases.js';
import { serviceUnavailable } from '../lib/http/errors.js';

/**
 * 機能 ON/OFF ガード（compose profile 連動）。
 *
 * 該当機能が無効（COMPOSE_PROFILES で当該 profile を起動していない）なら 503 を返す。web 側は
 * メニューを非表示にするが（isUseCaseEnabled）、経路だけ生きていると「壊れた導線」になるため api 側でも
 * 明示エラーで止める。errorHandler が ApiError を {error:message} に整形する（503）。
 */
export function requireUseCase(enabled: EnabledUseCases, key: UseCaseKey): RequestHandler {
  return (_req, _res, next) => {
    if (enabled[key]) {
      next();
      return;
    }
    next(
      serviceUnavailable(
        `機能「${key}」は無効です。利用するには deploy の COMPOSE_PROFILES で対応するプロファイルを有効化してください。`,
      ),
    );
  };
}
