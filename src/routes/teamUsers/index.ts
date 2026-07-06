import { Router } from 'express';
import { createCreateTeamUserHandler } from './createTeamUser.js';
import { createDeleteTeamUserHandler } from './deleteTeamUser.js';
import type { TeamUsersDeps } from './deps.js';
import { createGetTeamUserHandler } from './getTeamUser.js';
import { createListTeamUsersHandler } from './listTeamUsers.js';
import { createUpdateTeamUserHandler } from './updateTeamUser.js';

/**
 * teamUsers リソース群 Router（/teams/:teamId/users 配下）。/api 配下にマウントされる。
 * listTeamUsers/updateTeamUser/deleteTeamUser、createTeamUser/getTeamUser を提供。
 * 認可は各ハンドラ内（チーム管理者 or システム管理者＋最後の管理者保護）。依存は注入式。
 */
export function createTeamUsersRouter(deps: TeamUsersDeps): Router {
  const router = Router();
  router.get('/teams/:teamId/users', createListTeamUsersHandler(deps));
  router.post('/teams/:teamId/users', createCreateTeamUserHandler(deps));
  router.get('/teams/:teamId/users/:userId', createGetTeamUserHandler(deps));
  router.put('/teams/:teamId/users/:userId', createUpdateTeamUserHandler(deps));
  router.delete('/teams/:teamId/users/:userId', createDeleteTeamUserHandler(deps));
  return router;
}
