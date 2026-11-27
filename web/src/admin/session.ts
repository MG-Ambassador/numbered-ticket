// 管理者のセッション（A-01）。Firestore・Storage・adminApi への入口をまとめる。
// 運営ID＋パスワードでログインしたカスタムトークン（operatorLogin）をそのまま使う。ロールごとの権限は関数が判定する。
import { signOut, type User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { FUNCTION_NAMES, can, type AdminRequest, type OperatorIdentity, type Permission } from '@nt/shared';
import { clients } from '../firebase';
import { ApiError, call } from '../lib/api';

export interface AdminSession {
  uid: string;
  /** ログインしている運営アカウント（ロールで表示を絞る。権限の判定の正本は関数） */
  identity: OperatorIdentity;
  db: Firestore;
  storage: FirebaseStorage;
  /** adminApi（op で振り分ける1つの callable） */
  api: <Res = void>(req: AdminRequest) => Promise<Res>;
  /** ロールがその権限を持つか（画面の表示を絞るため） */
  can: (permission: Permission) => boolean;
}

export function productionSession(user: User, identity: OperatorIdentity): AdminSession {
  const c = clients('admin');
  return {
    uid: user.uid,
    identity,
    db: c.db,
    storage: c.storage,
    api: async (req) => {
      try {
        return await call(c.functions, FUNCTION_NAMES.admin, req);
      } catch (e) {
        // 有効期間（8時間）の終了・停止・再発行・ロール変更でログインが無効になったら、ログイン画面に戻す
        if (e instanceof ApiError && e.reason === 'sessionExpired') void signOut(c.auth);
        throw e;
      }
    },
    can: (permission) => can(identity.role, permission),
  };
}

/** 自分の情報を取る（ログイン直後・再読み込み後）。AdminSession を作る前なので、user から直接呼ぶ */
export async function fetchIdentity(): Promise<OperatorIdentity> {
  const c = clients('admin');
  return call<AdminRequest, OperatorIdentity>(c.functions, FUNCTION_NAMES.admin, { op: 'me' });
}
