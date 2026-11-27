// 管理者のセッション（A-01）。Firestore・Storage・adminApi への入口をまとめる。
// メール/パスワードでログインしたトークン（admin クレーム）をそのまま使う。TOTP は必須にしない（2026-11-27）。
// Emulator も Auth Emulator のトークンで同じように動く。
import type { User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { FUNCTION_NAMES, type AdminRequest } from '@nt/shared';
import { clients } from '../firebase';
import { call } from '../lib/api';

export interface AdminSession {
  uid: string;
  email: string;
  db: Firestore;
  storage: FirebaseStorage;
  /** adminApi（op で振り分ける1つの callable） */
  api: <Res = void>(req: AdminRequest) => Promise<Res>;
}

export function productionSession(user: User): AdminSession {
  const c = clients('admin');
  return {
    uid: user.uid,
    email: user.email ?? '',
    db: c.db,
    storage: c.storage,
    api: (req) => call(c.functions, FUNCTION_NAMES.admin, req),
  };
}
