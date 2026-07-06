import type { IdpClient } from '../../lib/idp/idpClient.js';
import type { TeamRepository } from '../../repositories/teamRepository.js';
import type { TeamUserRepository } from '../../repositories/teamUserRepository.js';

/** teamUsers Router（/teams/:teamId/users 配下）の依存。認可層2 の lookup は teamUsers.findMembership。 */
export interface TeamUsersDeps {
  teams: TeamRepository;
  teamUsers: TeamUserRepository;
  /** Keycloak 連携 seam（findUserByEmail／管理者グループ加入・離脱）。実装は realm セッション後続。 */
  idp: IdpClient;
}
