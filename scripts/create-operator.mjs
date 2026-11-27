#!/usr/bin/env node
// 運営アカウント（管理者）の作成・仮パスワードの再発行・停止・再開。明学の質問箱の operator:create と同じ使い方。
// 最初の管理者は画面から作れないので、このスクリプトで作る（以降は管理画面の「アカウント」で作る）。
//
//   確認のみ（何も書かない）:
//     node scripts/create-operator.mjs --project oc-ticket-2027 --login-id <運営ID> --display-name <表示名> --role owner
//   作成:        ... --execute を付ける
//   再発行:      node scripts/create-operator.mjs --project oc-ticket-2027 --login-id <運営ID> --reset --execute
//   停止／再開:  node scripts/create-operator.mjs --project oc-ticket-2027 --login-id <運営ID> --disable --execute   （--enable で再開）
//   Emulator:    FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/create-operator.mjs --project demo-numbered-ticket ...
//
// - 本番では Application Default Credentials を使う（gcloud auth application-default login を運用アカウントで）
// - 仮パスワードは標準出力に一度だけ出る（ファイルには保存しない）。保存するのはハッシュだけ
// - 作成・再発行したアカウントは、初回ログインでパスワード変更が必要（mustChange）
// - ロール: developer（開発者）・owner（責任者）・faculty（教員）・ambassador（アンバサダー）・staff（スタッフ）
// - パスワードのハッシュは functions/src/core/password.ts をそのまま読み込む（Node 22.18 以上、24 など）
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { OPERATOR_ROLES, normalizeLoginId } from '../shared/dist/index.js';
import { generateTemporaryPassword, hashPassword } from '../functions/src/core/password.ts';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    'login-id': { type: 'string' },
    'display-name': { type: 'string' },
    role: { type: 'string' },
    reset: { type: 'boolean', default: false },
    disable: { type: 'boolean', default: false },
    enable: { type: 'boolean', default: false },
    execute: { type: 'boolean', default: false },
  },
});

const usage = () => {
  console.error('使い方: node scripts/create-operator.mjs --project <プロジェクト ID> --login-id <運営ID> (--display-name <表示名> --role <ロール> | --reset | --disable | --enable) [--execute]');
  process.exit(1);
};
if (!values.project || !values['login-id']) usage();
const loginId = normalizeLoginId(values['login-id']);
if (!loginId) {
  console.error('運営ID は半角英数字・ハイフン・アンダーバーの3〜40文字にしてください');
  process.exit(1);
}
const mode = values.reset ? 'reset' : values.disable ? 'disable' : values.enable ? 'enable' : 'create';
if (mode === 'create') {
  if (!values['display-name'] || !values.role) usage();
  if (!OPERATOR_ROLES.includes(values.role)) {
    console.error(`ロールは ${OPERATOR_ROLES.join(' / ')} のどれかにしてください`);
    process.exit(1);
  }
  if ([...values['display-name'].trim()].length > 40) {
    console.error('表示名は40文字以内にしてください');
    process.exit(1);
  }
}

const db = getFirestore(initializeApp({ projectId: values.project }));
const where = process.env.FIRESTORE_EMULATOR_HOST ? `Emulator（${process.env.FIRESTORE_EMULATOR_HOST}）` : `本番（${values.project}）`;
const ref = db.doc(`operators/${loginId}`);
const existing = await ref.get();
const now = Timestamp.now();
const audit = (action, version) =>
  db.collection('operatorAudit').doc().set({ at: now, actor: 'cli', action, target: loginId, version });

if (mode === 'create') {
  if (existing.exists) {
    console.error(`${where}: 運営ID ${loginId} はすでにあります。パスワードを再発行する場合は --reset を付けてください`);
    process.exit(1);
  }
  console.log(`${where}: 作成 → 運営ID ${loginId} / ${values['display-name'].trim()} / ${values.role}`);
  if (!values.execute) {
    console.log('確認のみです。実際に作るには --execute を付けて、もう一度実行してください。');
    process.exit(0);
  }
  const password = generateTemporaryPassword();
  await ref.set({
    loginId,
    displayName: values['display-name'].trim(),
    role: values.role,
    passwordHash: await hashPassword(password),
    active: true,
    mustChange: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await audit('operator_create', 1);
  console.log(`  運営ID:       ${loginId}`);
  console.log(`  仮パスワード: ${password}`);
  console.log('仮パスワードはこの画面にしか出ません。本人に直接伝え、初回ログインで変更してもらってください。');
  process.exit(0);
}

if (!existing.exists) {
  console.error(`${where}: 運営ID ${loginId} は見つかりません`);
  process.exit(1);
}
const current = existing.data();
const version = (current.version ?? 0) + 1;
console.log(`${where}: ${{ reset: '仮パスワードの再発行', disable: '利用停止', enable: '利用再開' }[mode]} → ${loginId}（${current.displayName} / ${current.role}）。この人のいまのログインはすべて無効になります`);
if (!values.execute) {
  console.log('確認のみです。実際に行うには --execute を付けて、もう一度実行してください。');
  process.exit(0);
}
if (mode === 'reset') {
  const password = generateTemporaryPassword();
  await ref.update({ passwordHash: await hashPassword(password), mustChange: true, version, updatedAt: now });
  await audit('operator_reset', version);
  console.log(`  運営ID:       ${loginId}`);
  console.log(`  仮パスワード: ${password}`);
  console.log('仮パスワードはこの画面にしか出ません。本人に直接伝えてください。');
} else {
  await ref.update({ active: mode === 'enable', version, updatedAt: now });
  await audit(`operator_${mode}`, version);
  console.log('完了しました。');
}
