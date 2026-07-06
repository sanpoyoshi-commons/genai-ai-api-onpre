/**
 * 認可グループ名（cognito:groups 互換クレームの値、認可層1）。
 * Keycloak realm の Group 名はこの定数に一致させる
 * （api が契約を定義し realm が追従、Group 1:1）。
 */
export const SYSTEM_ADMIN_GROUP = 'SystemAdmin';
export const TEAM_ADMIN_GROUP = 'TeamAdmin';
export const USER_GROUP = 'User';
