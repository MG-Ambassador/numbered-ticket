// 新規登録を匿名に限る（設計書 4章・7.4-6）。
// Identity Platform の新規登録無効化は匿名ログインも止めるため使わず、ブロッキング関数で拒否する。
// 管理者は管理スクリプト（Admin SDK）で作るので、この関数の対象にならない。
import type { AuthUserRecord } from 'firebase-functions/v2/identity';

/** 匿名ユーザーはプロバイダを持たない（メール・電話・外部 IdP のいずれもない） */
export function isAnonymousSignUp(user: Pick<AuthUserRecord, 'providerData' | 'email' | 'phoneNumber'> | undefined): boolean {
  if (!user) return false;
  return user.providerData.length === 0 && !user.email && !user.phoneNumber;
}
