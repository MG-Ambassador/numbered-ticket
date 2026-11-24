import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { REGION } from '@nt/shared';

// 本番の設定値は P4 で .env に入れる。Emulator では demo プロジェクトを使う。
const useEmulator = import.meta.env.DEV || import.meta.env.VITE_USE_EMULATOR === 'true';
const projectId = import.meta.env.VITE_FB_PROJECT_ID ?? 'demo-numbered-ticket';

const config = {
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

const cache = new Map<Surface, Clients>();

export function clients(surface: Surface): Clients {
  const hit = cache.get(surface);
  if (hit) return hit;
  const app = initializeApp(config, surface);
  const auth = getAuth(app);
  // 設計書 4章「SDK はメモリキャッシュのみ」
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  const functions = getFunctions(app, REGION);
  const storage = getStorage(app);
  if (useEmulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }
  const c = { app, auth, db, functions, storage };
  cache.set(surface, c);
  return c;
}
