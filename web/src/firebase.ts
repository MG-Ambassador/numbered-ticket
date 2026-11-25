import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { REGION } from '@nt/shared';

// 本番の設定値はビルド時の環境変数（VITE_FB_*）で渡す（GitHub Actions の変数。docs/p4-integration.md）。
// Emulator では demo プロジェクトを使う。
export const useEmulator = import.meta.env.DEV || import.meta.env.VITE_USE_EMULATOR === 'true';
const projectId = import.meta.env.VITE_FB_PROJECT_ID ?? 'demo-numbered-ticket';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY ?? 'demo-key',
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET ?? `${projectId}.appspot.com`,
  appId: import.meta.env.VITE_FB_APP_ID ?? 'demo-app',
};

/**
 * 画面の種類。種類ごとに Firebase のアプリを分け、ログイン状態（匿名ユーザーとクレーム）を別々に保存する。
 * 同じ端末で来場者とスタッフの画面を開いても、クレームが上書きされないようにするため。
 */
export type Surface = 'visitor' | 'staff' | 'admin';

export interface Clients {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  storage: FirebaseStorage;
}

/** App Check（reCAPTCHA Enterprise）のサイトキー。未設定なら App Check を使わない（Emulator・強制前） */
const appCheckSiteKey: string | undefined = import.meta.env.VITE_APPCHECK_SITE_KEY || undefined;

const cache = new Map<Surface, Clients>();

export function clients(surface: Surface): Clients {
  const hit = cache.get(surface);
  if (hit) return hit;
  // 開発中のホットリロードでこのモジュールが読み直されたときは、作ってあるアプリをそのまま使う
  const existing = getApps().find((a) => a.name === surface);
  const app = existing ?? initializeApp(firebaseConfig, surface);
  // App Check はほかのサービスより先に初期化する（最初の要求からトークンを付けるため）
  if (!existing && !useEmulator && appCheckSiteKey) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }
  const auth = getAuth(app);
  // 設計書 4章「SDK はメモリキャッシュのみ」
  const db = existing ? getFirestore(app) : initializeFirestore(app, { localCache: memoryLocalCache() });
  const functions = getFunctions(app, REGION);
  const storage = getStorage(app);
  if (useEmulator && !existing) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }
  const c = { app, auth, db, functions, storage };
  cache.set(surface, c);
  return c;
}
