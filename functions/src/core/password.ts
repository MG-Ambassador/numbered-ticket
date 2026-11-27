// 運営アカウントのパスワード処理。明学の質問箱（server/src/password.ts）と同じ形式・同じコスト。
// OWASP の scrypt 推奨値（N=2^14, r=8, p=5）。salt とコストはハッシュ文字列に含める。
// 形式: scrypt$16384$8$5$<salt 32hex>$<hash 64hex>
// scripts/create-operator.mjs が TypeScript のまま読み込むので、型の注釈だけで書く（enum などは使わない）
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 5;
const KEY_LENGTH = 32;
const PREFIX = `scrypt$${N}$${R}$${P}$`;
const HASH_PATTERN = /^scrypt\$16384\$8\$5\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
// 未登録 ID でも同じ計算量をかけ、応答時間から ID の有無を推測させない
const DUMMY_HASH = `${PREFIX}${'0'.repeat(32)}$${'0'.repeat(64)}`;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string, salt: string = crypto.randomBytes(16).toString('hex')): Promise<string> {
  const key = await derive(password, salt);
  return `${PREFIX}${salt}$${key.toString('hex')}`;
}

/** 形式が不正なハッシュ（未登録 ID など）でも計算を行い、必ず false を返す */
export async function verifyPassword(password: string, encoded: string | undefined | null): Promise<boolean> {
  const match = HASH_PATTERN.exec(encoded || '');
  const [, salt, expected] = match || HASH_PATTERN.exec(DUMMY_HASH)!;
  const actual = await derive(password, salt!);
  return crypto.timingSafeEqual(actual, Buffer.from(expected!, 'hex')) && !!match;
}

/** 仮パスワード（24文字・URL セーフ）。初回ログイン後に本人が変更する */
export function generateTemporaryPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}
