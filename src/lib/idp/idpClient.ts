import { SYSTEM_ADMIN_GROUP, TEAM_ADMIN_GROUP, USER_GROUP } from '../auth/groups.js';

/**
 * IdP（Keycloak）連携の seam（seam 注入＋実装は realm 構築後）。
 *
 * 上流は Cognito Identity Provider API（findUserByEmail／addUserToGroup）でユーザー解決とグループ
 * 連動を行う。ローカルは機能的に Keycloak Admin REST API へ 1:1 対応するが、realm 構築は
 * 別途のため、ここではインターフェースのみ定義して deps 注入する（queue/repository と同方式）。
 * ハンドラはこの seam を上流同等に呼び（createTeam/createTeamUser のグループ付与、updateTeamUser/
 * deleteTeamUser の管理者グループ加入・離脱）、認可層2 の DB is_admin と IdP グループの 2 系統書込を保つ。
 * unit テストは fake を注入する。実 Keycloak アダプタは後続で差し替える。
 */

/** IdP 上のユーザー（メール解決の結果）。上流 Cognito UserType の最小射影に対応。 */
export interface IdpUser {
  userId: string;
  email: string;
}

/** 連携対象グループ（認可層1 の cognito:groups 互換クレーム値＝groups.ts 定数）。 */
export type IdpGroup = typeof SYSTEM_ADMIN_GROUP | typeof TEAM_ADMIN_GROUP | typeof USER_GROUP;

export interface IdpClient {
  /** メールで IdP ユーザーを解決。未ログイン（不在）は null。 */
  findUserByEmail(email: string): Promise<IdpUser | null>;
  /** ユーザーをグループへ加入させる（冪等想定）。 */
  addUserToGroup(userId: string, group: IdpGroup): Promise<void>;
  /** ユーザーをグループから離脱させる（冪等想定）。 */
  removeUserFromGroup(userId: string, group: IdpGroup): Promise<void>;
}
