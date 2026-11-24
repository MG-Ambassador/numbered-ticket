// 管理者のセッション（A-01）。Firestore・Storage・adminApi への入口をまとめる。
//
// 本番: メール/パスワード＋TOTP でログインしたトークン（sign_in_second_factor == 'totp'）をそのまま使う。
// Emulator: Auth Emulator は TOTP に対応していない（登録で "Missing phoneEnrollmentInfo"）。
//   そこで Emulator のときだけ、パスワードでログインしたユーザーの uid に「TOTP 済み」を付けた
//   署名なしのトークンを作り、Firestore・Storage は mockUserToken、adminApi は fetch で渡す。
//   Emulator は署名を確かめないので通るが、本番は署名を確かめるので、この経路は本番では通らない。
import { getApps, initializeApp } from 'firebase/app';
import type { User } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { ERROR_REASONS, FUNCTION_NAMES, REGION, type AdminRequest, type ErrorDetails } from '@nt/shared';
import { clients, firebaseConfig, useEmulator } from '../firebase';
import { ApiError, call } from '../lib/api';

export interface AdminSession {
  uid: string;
  email: string;
  db: Firestore;
  storage: FirebaseStorage;
  /** adminApi（op で振り分ける1つの callable） */
  api: <Res = void>(req: AdminRequest) => Promise<Res>;
  /** Emulator の代用トークンで動いている（TOTP は省略） */
  emulated: boolean;
}

export function productionSession(user: User): AdminSession {
  const c = clients('admin');
  return {
    uid: user.uid,
    email: user.email ?? '',
    db: c.db,
    storage: c.storage,
    api: (req) => call(c.functions, FUNCTION_NAMES.admin, req),
    emulated: false,
  };
}

/** Emulator 専用。uid ごとにアプリを作る（mockUserToken は接続時にしか渡せないため） */
const emulated = new Map<string, AdminSession>();

export function emulatorSession(user: User): AdminSession {
  if (!useEmulator) throw new Error('emulatorSession は Emulator でしか使えない');
  const hit = emulated.get(user.uid);
  if (hit) return hit;
  const claims = {
    sub: user.uid,
    user_id: user.uid,
    email: user.email ?? undefined,
    email_verified: true,
    admin: true,
    firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp', identities: {} },
  };
  const name = `admin-emulated-${user.uid}`;
  // ホットリロードでモジュールが読み直されたときは、作ってあるアプリをそのまま使う
  const existing = getApps().find((a) => a.name === name);
  const app = existing ?? initializeApp(firebaseConfig, name);
  const db = existing ? getFirestore(app) : initializeFirestore(app, { localCache: memoryLocalCache() });
  const storage = getStorage(app);
  if (!existing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connectFirestoreEmulator(db, '127.0.0.1', 8080, { mockUserToken: claims as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connectStorageEmulator(storage, '127.0.0.1', 9199, { mockUserToken: claims as any });
  }

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { ...claims, iss: `https://securetoken.google.com/${firebaseConfig.projectId}`, aud: firebaseConfig.projectId, iat: now, auth_time: now, exp: now + 3600 };
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
  const url = `http://127.0.0.1:5001/${firebaseConfig.projectId}/${REGION}/${FUNCTION_NAMES.admin}`;

  async function api<Res>(req: AdminRequest): Promise<Res> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ data: req }) });
    const body = (await res.json()) as { result?: Res; error?: { message: string; details?: ErrorDetails } };
    if (body.error) {
      const d = body.error.details;
      throw new ApiError(d?.reason ? ERROR_REASONS[d.reason] : body.error.message, d?.reason ?? null, d ?? null);
    }
    return body.result as Res;
  }
  const session: AdminSession = { uid: user.uid, email: user.email ?? '', db, storage, api, emulated: true };
  emulated.set(user.uid, session);
  return session;
}
