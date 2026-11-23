#!/usr/bin/env node
// 管理者アカウントの作成・無効化（A-01）。画面からの新規登録はできないので、管理者はこのスクリプトで作る。
//
//   本番:     node scripts/create-admin.mjs --project oc-ticket-2027 --email <メール>
//   無効化:   node scripts/create-admin.mjs --project oc-ticket-2027 --email <メール> --disable
//   Emulator: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/create-admin.mjs --project demo-numbered-ticket --email a@example.com
//
// - 本番では Application Default Credentials を使う（gcloud auth application-default login を運用アカウントで）
// - emailVerified: true で作る（TOTP の登録に必要。7.4-2。メールは送らない）
// - 仮パスワード（20文字）を一度だけ表示する。初回ログインでパスワード変更と TOTP 登録を求める（クレーム initial: true）
// - Admin SDK の作成はブロッキング関数（beforeCreate）の対象外
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    email: { type: 'string' },
    disable: { type: 'boolean', default: false },
  },
});

if (!values.project || !values.email) {
  console.error('使い方: node scripts/create-admin.mjs --project <プロジェクト ID> --email <メール> [--disable]');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
  console.error('メールアドレスの形が正しくありません');
  process.exit(1);
}

const auth = getAuth(initializeApp({ projectId: values.project }));
const where = process.env.FIREBASE_AUTH_EMULATOR_HOST ? `Emulator（${process.env.FIREBASE_AUTH_EMULATOR_HOST}）` : `本番（${values.project}）`;

/** 12〜128 文字のパスワードポリシー（設計書 4章）を満たす仮パスワード。紛らわしい文字は使わない */
function tempPassword(length = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length }, () => chars[randomInt(chars.length)]).join('');
}

if (values.disable) {
  const user = await auth.getUserByEmail(values.email);
  await auth.updateUser(user.uid, { disabled: true });
  await auth.revokeRefreshTokens(user.uid);
  console.log(`${where}: ${values.email} を無効化しました（ログイン中のセッションも失効）`);
  process.exit(0);
}

const existing = await auth.getUserByEmail(values.email).catch((e) => (e.code === 'auth/user-not-found' ? null : Promise.reject(e)));
if (existing) {
  console.error(`${where}: ${values.email} はすでにあります。作り直す場合は Firebase コンソールで削除してから実行してください`);
  process.exit(1);
}

const password = tempPassword();
const user = await auth.createUser({ email: values.email, password, emailVerified: true });
await auth.setCustomUserClaims(user.uid, { admin: true, initial: true });

console.log(`${where}: 管理者を作成しました`);
console.log(`  uid:          ${user.uid}`);
console.log(`  メール:       ${values.email}`);
console.log(`  仮パスワード: ${password}`);
console.log('仮パスワードはこの画面にしか出ません。本人に直接伝え、初回ログインで変更してもらってください。');
