// 設計書 7.4 のうち、Emulator で確かめられるものの検証。
// Emulator と本番の挙動が違う可能性があるため、結果は docs/p0-verification.md に「Emulator での結果」として残す。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-numbered-ticket',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe('7.4-1 ルールで sign_in_second_factor == "totp" を判定できるか', () => {
  it('TOTP 済みトークンは読める', async () => {
    const db = env
      .authenticatedContext('admin1', { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } })
      .firestore();
    await assertSucceeds(getDoc(doc(db, 'verify/mfa')));
  });

  it('第2要素なしのトークンは読めない', async () => {
    const db = env.authenticatedContext('admin1', { firebase: { sign_in_provider: 'password' } }).firestore();
    await assertFails(getDoc(doc(db, 'verify/mfa')));
  });

  it('SMS など totp 以外の第2要素は読めない', async () => {
    const db = env
      .authenticatedContext('admin1', { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'phone' } })
      .firestore();
    await assertFails(getDoc(doc(db, 'verify/mfa')));
  });

  it('全体の拒否ルールが効いている（クライアント書込は全拒否）', async () => {
    const db = env
      .authenticatedContext('admin1', { firebase: { sign_in_second_factor: 'totp' } })
      .firestore();
    await assertFails(setDoc(doc(db, 'events/e1'), { state: 'open' }));
  });
});

describe('7.4-4 購読中に閉場したとき、ルールが再評価されるか', () => {
  async function seed(state: string) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'events/e1'), { state });
      await setDoc(doc(ctx.firestore(), 'verifyLive/a'), { n: 0 });
    });
  }
  async function admin(path: string, data: object) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('閉場（events のみ更新）と、その後の購読対象の更新で何が起きるかを記録する', async () => {
    await seed('open');
    const db = env.authenticatedContext('visitor1').firestore();
    const log: string[] = [];
    const unsub = onSnapshot(
      doc(db, 'verifyLive/a'),
      (s) => log.push(`snapshot n=${s.data()?.n}`),
      (e) => log.push(`error ${(e as { code?: string }).code}`),
    );
    await wait(1000);
    log.push('--- events/e1 を closed に変更');
    await admin('events/e1', { state: 'closed' });
    await wait(2000);
    log.push('--- verifyLive/a を更新');
    await admin('verifyLive/a', { n: 1 });
    await wait(2000);
    unsub();

    console.log('[7.4-4 Emulator]', JSON.stringify(log));
    // 開場中に購読を開始できること
    expect(log[0]).toBe('snapshot n=0');
    // 閉場後、購読対象の更新が届かないこと（エラーで止まる）を期待する
    expect(log).not.toContain('snapshot n=1');
  });
});
