// 7.4-4 の本番検証: 購読中に閉場したとき、ルールが再評価されるか
// 実行: node verify/src/prod-reeval.mjs （運用アカウントの gcloud 認証が必要）
// P0 の検証用ルール（verifyLive）が前提。P1 のルールをデプロイしたあとは動かない
import { execFileSync } from 'node:child_process';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { doc, initializeFirestore, memoryLocalCache, onSnapshot } from 'firebase/firestore';

const PROJECT = 'oc-ticket-2027';
const token = execFileSync('gcloud', ['auth', 'print-access-token', '--account=mga1863engineering@gmail.com'], {
  encoding: 'utf8',
}).trim();

async function adminSet(path, fields) {
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: v } : { stringValue: v }])) };
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = initializeApp({
  apiKey: 'AIzaSyBmRu1DldjCLRBJVxieHxWKOiMhErB-gMs',
  authDomain: 'oc-ticket-2027.firebaseapp.com',
  projectId: PROJECT,
});
const db = initializeFirestore(app, { localCache: memoryLocalCache() });
await signInAnonymously(getAuth(app));

await adminSet('events/e1', { state: 'open' });
await adminSet('verifyLive/a', { n: 0 });
await wait(1500);

const log = [];
const unsub = onSnapshot(
  doc(db, 'verifyLive/a'),
  (s) => log.push(`snapshot n=${s.data()?.n}`),
  (e) => log.push(`error ${e.code}`),
);
await wait(3000);
log.push('--- events/e1 を closed に変更');
await adminSet('events/e1', { state: 'closed' });
await wait(15000);
log.push('--- verifyLive/a を更新');
await adminSet('verifyLive/a', { n: 1 });
await wait(8000);
unsub();
console.log('[7.4-4 本番]', JSON.stringify(log));
process.exit(0);
