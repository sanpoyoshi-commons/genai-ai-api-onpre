import type { RequestHandler } from 'express';
import { z } from 'zod';
import { encodeJobMessage } from '../../lib/exapp/jobMessage.js';
import { type ApiHandler, createApiHandler } from '../../lib/http/createApiHandler.js';
import { forbidden, notFound } from '../../lib/http/errors.js';
import { parseBody } from '../../lib/http/validation.js';
import type { ExAppQueue } from '../../lib/queue/exAppQueue.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { InvokeHistoryRepository } from '../../repositories/invokeHistoryRepository.js';
import type { TeamUserRepository } from '../../repositories/teamUserRepository.js';

/**
 * ExApp 非同期実行の起票（POST /exapps/invoke）。
 *
 * /api 共通 requireAuth 配下にマウントし、横断ラッパ createApiHandler で実行する。
 * 認可は当該チームのメンバーシップ（invoke は通常ユーザー操作＝admin ゲートしない）。
 * 履歴を status=running で作成し、その複合キーをジョブへ載せてキューへ投入する（送信側）。
 * 実状態確認・完了書き戻しは worker（pollExAppStatus）が担う。依存は注入式（テスト容易性）。
 */
const invokeExAppSchema = z.object({
  teamId: z.string().min(1),
  exAppId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

export interface InvokeExAppDeps {
  queue: ExAppQueue;
  exApps: Pick<ExAppRepository, 'findSnapshotById'>;
  histories: Pick<InvokeHistoryRepository, 'create'>;
  teamUsers: Pick<TeamUserRepository, 'findMembership'>;
}

export function createInvokeExAppHandler(deps: InvokeExAppDeps): RequestHandler {
  const handler: ApiHandler = async ({ req, auth }) => {
    const { teamId, exAppId, inputs } = parseBody(invokeExAppSchema, req.body);

    // 認可：当該チームのメンバーであること（findMembership 非 null）。admin ゲートはしない。
    const membership = await deps.teamUsers.findMembership(teamId, auth.userId);
    if (!membership) {
      throw forbidden('team membership is required to invoke an external app');
    }

    // スナップショット用の名称取得＝存在確認も兼ねる。
    const snapshot = await deps.exApps.findSnapshotById(teamId, exAppId);
    if (!snapshot) {
      throw notFound('external app not found');
    }

    const key = await deps.histories.create({
      teamId,
      exAppId,
      userId: auth.userId,
      teamNameSnapshot: snapshot.teamName,
      exAppNameSnapshot: snapshot.exAppName,
      inputs,
    });

    await deps.queue.enqueueJob(
      encodeJobMessage({
        teamId,
        exAppId,
        userId: auth.userId,
        createdDate: key.createdDate.toISOString(),
      }),
    );

    return { status: 202, body: { status: 'accepted' } };
  };

  return createApiHandler(handler);
}
