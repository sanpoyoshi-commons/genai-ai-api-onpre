import type { RequestHandler } from 'express';
import { createApiHandler } from '../../lib/http/createApiHandler.js';
import { toExApp } from '../../lib/serialize/team.js';
import { COMMON_TEAM_ID } from '../../lib/teams/constants.js';
import type { ListExAppsResponse } from '../../types/genaiWeb.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { TeamRepository } from '../../repositories/teamRepository.js';
import type { TeamUserRepository } from '../../repositories/teamUserRepository.js';

/** listExApps Router の依存（注入式）。チーム列挙・チーム取得・アプリ軽量一覧。 */
export interface ListExAppsDeps {
  teams: Pick<TeamRepository, 'findById'>;
  teamUsers: Pick<TeamUserRepository, 'listTeamIdsByUser'>;
  exApps: Pick<ExAppRepository, 'listByTeam'>;
}

/**
 * listExApps（GET /exapps）。
 *
 * 認証ユーザーの所属チーム＋共通チームを横断し、各チームのアプリ登録を軽量射影で収集してチーム名を付与する。
 * 明示的な管理者ガードはなく、可視範囲は所属チーム＋共通チームへ自然スコープされる。チーム列挙・
 * アプリ列挙は上流ではカーソル尽きるまで反復・全件累積。本リポは正規化クエリで各チームのアプリを
 * 全ページ走査して平坦化する。0 件は空配列・200。
 */
export function createListExAppsHandler(deps: ListExAppsDeps): RequestHandler {
  return createApiHandler(async ({ auth }) => {
    const teamIds = await deps.teamUsers.listTeamIdsByUser(auth.userId);
    const scopedTeamIds = teamIds.includes(COMMON_TEAM_ID) ? teamIds : [...teamIds, COMMON_TEAM_ID];

    const result: ListExAppsResponse = [];
    for (const teamId of scopedTeamIds) {
      const team = await deps.teams.findById(teamId);
      if (!team) {
        continue;
      }
      let cursor: string | undefined;
      do {
        const page = await deps.exApps.listByTeam(teamId, cursor);
        for (const record of page.data) {
          result.push({ ...toExApp(record, { light: true }), teamName: team.name });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }

    return { status: 200, body: result };
  });
}
