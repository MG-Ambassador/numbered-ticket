import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { REGION } from '@nt/shared';

// 本番の設定値は P4 で .env に入れる。Emulator では demo プロジェクトを使う。
const useEmulator = import.meta.env.DEV || import.meta.env.VITE_USE_EMULATOR === 'true';

export const app = initializeApp({
  apiKey: import.meta.env.VITE_FB_API_KEY ?? 'demo-key',
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN ?? 'demo-numbered-ticket.firebaseapp.com',
  projectId: import.meta.env.VITE_FB_PROJECT_ID ?? 'demo-numbered-ticket',
  appId: import.meta.env.VITE_FB_APP_ID ?? 'demo-app',
});

export const auth = getAuth(app);
// 設計書 4章「SDK はメモリキャッシュのみ」
export const db = initializeFirestore(app, { localCache: memoryLocalCache() });
export const functions = getFunctions(app, REGION);

if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
