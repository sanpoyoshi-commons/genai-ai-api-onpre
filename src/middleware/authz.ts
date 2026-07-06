import type { AuthContext } from '../lib/auth/context.js';
import { SYSTEM_ADMIN_GROUP, TEAM_ADMIN_GROUP } from '../lib/auth/groups.js';
import { forbidden } from '../lib/http/errors.js';

/**
 * 認可2層。requireAuth が注入した claim を消費する共通ガード。
 * 上流のハンドラ冒頭ガード呼び出しパターンを保全（Router 前置ミドルウェアにしない）。
 *
 * 層1＝SystemAdmin（cognito:groups のみ、DB 不要）。
 * 層2＝当該チーム TeamAdmin（claim TeamAdminGroup AND DB team_users.is_admin の AND）OR 層1。
 */

/** team_users 参照 IF（findTeamUserById(teamId,userId)→{isAdmin} 相当）。実装は repository。 */
export type TeamAdminLookup = (teamId: string, userId: string) => Promise<{ isAdmin: boolean } | null>;

export function assertSystemAdmin(auth: AuthContext): void {
  if (!auth.groups.includes(SYSTEM_ADMIN_GROUP)) {
    throw forbidden('system administrator role is required');
  }
}

export async function assertTeamAdminOrSystemAdmin(
  auth: AuthContext,
  teamId: string,
  lookup: TeamAdminLookup,
): Promise<void> {
  if (auth.groups.includes(SYSTEM_ADMIN_GROUP)) {
    return;
  }
  if (auth.groups.includes(TEAM_ADMIN_GROUP)) {
    const membership = await lookup(teamId, auth.userId);
    if (membership?.isAdmin === true) {
      return;
    }
  }
  throw forbidden('team administrator role is required');
}

/**
 * 当該チームのメンバー OR システム管理者（getExApp）。「アプリ詳細取得＝一般メンバー可」に対応。
 * 層2 の管理者ガードと異なり TeamAdminGroup クレームも is_admin も要求せず、メンバーシップ存在のみで通す
 * （一般メンバー＝UserGroup ＋ is_admin=false でも可）。共通チーム特例は呼び出し側ハンドラが先に分岐する。
 */
export async function assertTeamMemberOrSystemAdmin(
  auth: AuthContext,
  teamId: string,
  lookup: TeamAdminLookup,
): Promise<void> {
  if (auth.groups.includes(SYSTEM_ADMIN_GROUP)) {
    return;
  }
  const membership = await lookup(teamId, auth.userId);
  if (membership !== null) {
    return;
  }
  throw forbidden('team membership is required');
}
