import type { ApiKeyStore } from '../../lib/apikey/apiKeyStore.js';
import type { IdpClient } from '../../lib/idp/idpClient.js';
import type { ExAppRepository } from '../../repositories/exAppRepository.js';
import type { InvokeHistoryRepository } from '../../repositories/invokeHistoryRepository.js';
import type { TeamRepository } from '../../repositories/teamRepository.js';
import type { TeamUserRepository } from '../../repositories/teamUserRepository.js';

/** teams Router の依存（注入式＝ユニットテストで fake 差し替え可）。認可層2 の lookup は teamUsers.findMembership。 */
export interface TeamsDeps {
  teams: TeamRepository;
  teamUsers: TeamUserRepository;
  exApps: ExAppRepository;
  histories: InvokeHistoryRepository;
  /** Keycloak 連携 seam（findUserByEmail／グループ加入・離脱）。実装は realm セッション後続。 */
  idp: IdpClient;
  /** apiKey 格納 seam（get/set/delete）。実装は docker secrets 後続。 */
  apiKeys: ApiKeyStore;
}
