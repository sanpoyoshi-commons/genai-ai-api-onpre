import { Router } from 'express';
import { createCopyExAppHandler } from './copyExApp.js';
import { createCreateExAppHandler } from './createExApp.js';
import { createCreateTeamHandler } from './createTeam.js';
import { createDeleteExAppHandler } from './deleteExApp.js';
import { createDeleteInvokeExAppHistoryHandler } from './deleteInvokeExAppHistory.js';
import { createDeleteTeamHandler } from './deleteTeam.js';
import type { TeamsDeps } from './deps.js';
import { createGetExAppHandler } from './getExApp.js';
import { createGetRawTeamHandler } from './getRawTeam.js';
import { createGetRawTeamAppHandler } from './getRawTeamApp.js';
import { createGetTeamHandler } from './getTeam.js';
import { createListTeamExAppsHandler } from './listTeamExApps.js';
import { createListTeamsHandler } from './listTeams.js';
import { createUpdateExAppHandler } from './updateExApp.js';
import { createUpdateTeamHandler } from './updateTeam.js';

/**
 * teams リソース群 Router。/api 配下（requireAuth 内側）にマウントされる。
 * createTeam/getTeam/getRawTeam/getExApp/getRawTeamApp/copyExApp/deleteInvokeExAppHistory と
 * listTeams/updateTeam/deleteTeam/listTeamExApps/createExApp/updateExApp/deleteExApp を集約。
 * 認可は各ハンドラ内（2 層＋共通チーム特例＋最後の管理者保護）。依存は注入式。
 * ルート登録順は具体パスを先・パラメータパスを後（Express 5 のマッチング衝突回避）。
 */
export function createTeamsRouter(deps: TeamsDeps): Router {
  const router = Router();

  // チーム本体
  router.post('/teams', createCreateTeamHandler(deps));
  router.get('/teams', createListTeamsHandler(deps));
  router.get('/teams/:teamId/raw', createGetRawTeamHandler(deps));
  router.get('/teams/:teamId', createGetTeamHandler(deps));
  router.put('/teams/:teamId', createUpdateTeamHandler(deps));
  router.delete('/teams/:teamId', createDeleteTeamHandler(deps));

  // チーム配下のアプリ登録
  router.get('/teams/:teamId/exapps', createListTeamExAppsHandler(deps));
  router.post('/teams/:teamId/exapps', createCreateExAppHandler(deps));
  router.get('/teams/:teamId/exapps/:exAppId/raw', createGetRawTeamAppHandler(deps));
  router.post('/teams/:teamId/exapps/:exAppId/copy', createCopyExAppHandler(deps));
  router.delete('/teams/:teamId/exapps/:exAppId/history', createDeleteInvokeExAppHistoryHandler(deps));
  router.get('/teams/:teamId/exapps/:exAppId', createGetExAppHandler(deps));
  router.put('/teams/:teamId/exapps/:exAppId', createUpdateExAppHandler(deps));
  router.delete('/teams/:teamId/exapps/:exAppId', createDeleteExAppHandler(deps));

  return router;
}
