// P1 のルールテスト（firestore.rules / storage.rules）。
// 完了条件: 「他人の整理券を読めない」などのルールテストが全件通る（設計書 6章）。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

const E = 'e1';
const OTHER = 'e2';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-numbered-ticket',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    storage: {
      rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

// ---- 利用者 -----------------------------------------------------------------

const ANON = { firebase: { sign_in_provider: 'anonymous' } };
const TOTP = { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } };

const users = {
  visitor1: ['v1', { ...ANON, eid: E, role: 'visitor' }],
  visitor2: ['v2', { ...ANON, eid: E, role: 'visitor' }],
  /** 別イベントの来場者（同じ uid でも e1 のものは読めない） */
  visitorOther: ['v1', { ...ANON, eid: OTHER, role: 'visitor' }],
  /** 匿名ログインしただけで入場コードを通していない */
  anonymous: ['n1', ANON],
  studentA: ['sA', { ...ANON, eid: E, role: 'student' }],
  studentB: ['sB', { ...ANON, eid: E, role: 'student' }],
  /** 枠を占有していない学生スタッフ */
  studentFree: ['sC', { ...ANON, eid: E, role: 'student' }],
  faculty: ['f1', { ...ANON, eid: E, role: 'faculty' }],
  admin: ['adm', { ...TOTP, admin: true }],
  adminNoTotp: ['adm', { firebase: { sign_in_provider: 'password' }, admin: true }],
  adminSms: ['adm', { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'phone' }, admin: true }],
  /** admin クレームのない TOTP ユーザー */
  totpOnly: ['x1', TOTP],
} satisfies Record<string, [string, TokenOptions]>;
type User = keyof typeof users | 'unauthenticated';

function ctx(user: User) {
  if (user === 'unauthenticated') return env.unauthenticatedContext();
  const [uid, token] = users[user];
  return env.authenticatedContext(uid, token);
}
const fs = (user: User): Firestore => ctx(user).firestore() as unknown as Firestore;
const read = (user: User, path: string) => getDoc(doc(fs(user), path));

// ---- 初期データ（関数が書く想定のもの） -----------------------------------------

const P = `events/${E}`;
const now = new Date();

async function seed(state: 'scheduled' | 'open' | 'closed' | 'purged' = 'open') {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const put = (path: string, data: object) => setDoc(doc(db, path), data);
    await put(P, { title: 'OC', state, paused: false, nextTicketNumber: 104 });
    await put(`events/${OTHER}`, { title: 'other', state: 'open' });
    await put(`${P}/secrets/codes`, { entryCode: '0384712', facultyCode: '03847125', slotCodes: { 'A-1': '51829364' } });
    await put(`${P}/slots/A-1`, { kind: 'student', occupant: { uid: 'sA', since: now }, paused: false, queueLimit: 5 });
    await put(`${P}/slots/A-2`, { kind: 'student', occupant: { uid: 'sB', since: now }, paused: false, queueLimit: 5 });
    await put(`${P}/slots/A-3`, { kind: 'student', occupant: null, paused: false, queueLimit: 5 });
    await put(`${P}/slots/faculty`, { kind: 'faculty', occupant: null, paused: false, queueLimit: 40 });
    await put(`${P}/queues/A-1`, { kind: 'student', waiting: [{ ticketId: 't1', number: 101 }] });
    await put(`${P}/queues/A-2`, { kind: 'student', waiting: [{ ticketId: 't2', number: 102 }] });
    await put(`${P}/queues/A-3`, { kind: 'student', waiting: [] });
    await put(`${P}/queues/faculty`, { kind: 'faculty', waiting: [{ ticketId: 't3', number: 103 }] });
    await put(`${P}/board/public`, { paused: false, slots: {} });
    await put(`${P}/board/other`, { x: 1 });
    const ticket = (number: number, slotId: string, visitorUid: string) => ({
      number,
      slotId,
      kind: slotId === 'faculty' ? 'faculty' : 'student',
      visitorUid,
      state: 'waiting',
      memo: '奨学金のことを聞きたい',
    });
    await put(`${P}/tickets/t1`, ticket(101, 'A-1', 'v1'));
    await put(`${P}/tickets/t2`, ticket(102, 'A-2', 'v2'));
    await put(`${P}/tickets/t3`, ticket(103, 'faculty', 'v2'));
    await put(`${P}/visitors/v1`, { activeTicketId: 't1' });
    await put(`${P}/visitors/v2`, { activeTicketId: 't2' });
    await put(`${P}/staff/sA`, { role: 'student', slotId: 'A-1' });
    await put(`${P}/staff/f1`, { role: 'faculty', booth: 'B-2' });
    await put(`${P}/auditLog/l1`, { action: 'queueLimit.change' });
    await put(`${P}/stats/2027-03-20`, { issued: 0 });
    await put(`events/${OTHER}/tickets/o1`, ticket(101, 'A-1', 'v1'));
    await put(`events/${OTHER}/slots/A-1`, { kind: 'student', occupant: { uid: 'sA', since: now } });
  });
}

async function setEventState(state: string) {
  await env.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), P), { state });
  });
}

// ---- テスト -----------------------------------------------------------------

describe('Firestore', () => {
  beforeEach(async () => {
    await seed('open');
  });

  describe('書き込みはクライアントから一切できない（書くのは関数のみ）', () => {
    const targets = [
      P,
      `events/new`,
      `${P}/secrets/codes`,
      `${P}/slots/A-1`,
      `${P}/queues/A-1`,
      `${P}/board/public`,
      `${P}/tickets/t1`,
      `${P}/tickets/new`,
      `${P}/visitors/v1`,
      `${P}/staff/sA`,
      `${P}/auditLog/l1`,
      `${P}/stats/2027-03-20`,
      `somewhere/else`,
    ];
    const writers: User[] = ['visitor1', 'studentA', 'faculty', 'admin', 'anonymous', 'unauthenticated'];
    for (const user of writers) {
      it(`${user} は作成・更新・削除できない`, async () => {
        const db = fs(user);
        for (const path of targets) {
          await assertFails(setDoc(doc(db, path), { hacked: true }));
          await assertFails(setDoc(doc(db, path), { hacked: true }, { merge: true }));
          await assertFails(deleteDoc(doc(db, path)));
        }
      });
    }
    it('本人の整理券でも状態を書き換えられない', async () => {
      await assertFails(updateDoc(doc(fs('visitor1'), `${P}/tickets/t1`), { state: 'canceled' }));
    });
    it('占有中の学生スタッフでも整理券を呼出にできない', async () => {
      await assertFails(updateDoc(doc(fs('studentA'), `${P}/tickets/t1`), { state: 'calling' }));
    });
  });

  describe('整理券 tickets', () => {
    it('来場者は自分の整理券を読める', async () => {
      await assertSucceeds(read('visitor1', `${P}/tickets/t1`));
    });
    it('来場者は他人の整理券を読めない', async () => {
      await assertFails(read('visitor1', `${P}/tickets/t2`));
      await assertFails(read('visitor1', `${P}/tickets/t3`));
    });
    it('来場者は整理券を一覧できない（自分のものに絞った場合のみ可）', async () => {
      const col = collection(fs('visitor1'), `${P}/tickets`);
      await assertFails(getDocs(col));
      await assertFails(getDocs(query(col, where('slotId', '==', 'A-1'))));
      await assertSucceeds(getDocs(query(col, where('visitorUid', '==', 'v1'))));
      await assertFails(getDocs(query(col, where('visitorUid', '==', 'v2'))));
    });
    it('別イベントのクレームでは、同じ uid でも読めない', async () => {
      await assertFails(read('visitorOther', `${P}/tickets/t1`));
    });
    it('入場コードを通していない匿名ユーザー・未ログインは読めない', async () => {
      await assertFails(read('anonymous', `${P}/tickets/t1`));
      await assertFails(read('unauthenticated', `${P}/tickets/t1`));
    });
    it('閉場後は自分の整理券も読めない', async () => {
      await setEventState('closed');
      await assertFails(read('visitor1', `${P}/tickets/t1`));
    });
    it('開場前（scheduled）は自分の整理券も読めない', async () => {
      await setEventState('scheduled');
      await assertFails(read('visitor1', `${P}/tickets/t1`));
    });

    it('学生スタッフは占有中の枠の整理券を読める・一覧できる', async () => {
      await assertSucceeds(read('studentA', `${P}/tickets/t1`));
      const col = collection(fs('studentA'), `${P}/tickets`);
      await assertSucceeds(getDocs(query(col, where('slotId', '==', 'A-1'))));
      await assertSucceeds(
        getDocs(query(col, where('slotId', '==', 'A-1'), where('state', 'in', ['waiting', 'calling']))),
      );
    });
    it('学生スタッフは他の枠・教員相談の整理券を読めない', async () => {
      await assertFails(read('studentA', `${P}/tickets/t2`));
      await assertFails(read('studentA', `${P}/tickets/t3`));
      const col = collection(fs('studentA'), `${P}/tickets`);
      await assertFails(getDocs(query(col, where('slotId', '==', 'A-2'))));
      await assertFails(getDocs(query(col, where('slotId', '==', 'faculty'))));
      await assertFails(getDocs(col));
    });
    it('枠を占有していない学生スタッフは読めない', async () => {
      await assertFails(read('studentFree', `${P}/tickets/t1`));
      await assertFails(getDocs(query(collection(fs('studentFree'), `${P}/tickets`), where('slotId', '==', 'A-3'))));
    });
    it('占有を外れたら（強制解除を含む）読めなくなる', async () => {
      await env.withSecurityRulesDisabled(async (c) => {
        await updateDoc(doc(c.firestore(), `${P}/slots/A-1`), { occupant: null });
      });
      await assertFails(read('studentA', `${P}/tickets/t1`));
    });
    it('教員スタッフは教員相談の整理券を読める・一覧できる', async () => {
      await assertSucceeds(read('faculty', `${P}/tickets/t3`));
      await assertSucceeds(getDocs(query(collection(fs('faculty'), `${P}/tickets`), where('slotId', '==', 'faculty'))));
    });
    it('教員スタッフは学生相談の整理券を読めない', async () => {
      await assertFails(read('faculty', `${P}/tickets/t1`));
      await assertFails(getDocs(query(collection(fs('faculty'), `${P}/tickets`), where('slotId', '==', 'A-1'))));
    });
    it('スタッフは閉場後に読めない', async () => {
      await setEventState('closed');
      await assertFails(read('studentA', `${P}/tickets/t1`));
      await assertFails(read('faculty', `${P}/tickets/t3`));
    });
    it('別イベントのスタッフは読めない（同じ uid・同じ枠 ID でも）', async () => {
      // e2 の A-1 は sA が占有しているが、クレームは e1
      await assertFails(read('studentA', `events/${OTHER}/tickets/o1`));
    });

    it('管理者は TOTP 済みのときだけ読める', async () => {
      await assertSucceeds(read('admin', `${P}/tickets/t1`));
      await assertSucceeds(getDocs(collection(fs('admin'), `${P}/tickets`)));
      await assertFails(read('adminNoTotp', `${P}/tickets/t1`));
      await assertFails(read('adminSms', `${P}/tickets/t1`));
      await assertFails(read('totpOnly', `${P}/tickets/t1`));
    });
  });

  describe('イベント events', () => {
    it('自イベントの来場者・スタッフ・管理者は読める', async () => {
      for (const u of ['visitor1', 'studentA', 'studentFree', 'faculty', 'admin'] as const) {
        await assertSucceeds(read(u, P));
      }
    });
    it('閉場後も状態は読める（「閉場しました」の表示のため）', async () => {
      await setEventState('closed');
      await assertSucceeds(read('visitor1', P));
    });
    it('別イベント・未入場・管理者でない人は読めない', async () => {
      await assertFails(read('visitorOther', P));
      await assertFails(read('anonymous', P));
      await assertFails(read('unauthenticated', P));
      await assertFails(read('adminNoTotp', P));
    });
    it('イベントは一覧できない（管理者を除く）', async () => {
      await assertFails(getDocs(collection(fs('visitor1'), 'events')));
      await assertSucceeds(getDocs(collection(fs('admin'), 'events')));
    });
  });

  describe('コード secrets', () => {
    it('管理者を含め、誰も読めない', async () => {
      for (const u of ['visitor1', 'studentA', 'faculty', 'admin', 'anonymous'] as const) {
        await assertFails(read(u, `${P}/secrets/codes`));
      }
      await assertFails(getDocs(collection(fs('admin'), `${P}/secrets`)));
    });
  });

  describe('枠 slots と board/public', () => {
    const publicPaths = [`${P}/slots/A-1`, `${P}/slots/faculty`, `${P}/board/public`];
    it('開場中の来場者は読める（枠は一覧も可）', async () => {
      for (const p of publicPaths) await assertSucceeds(read('visitor1', p));
      await assertSucceeds(getDocs(collection(fs('visitor1'), `${P}/slots`)));
    });
    it('来場者は開場前・閉場後は読めない', async () => {
      for (const state of ['scheduled', 'closed', 'purged']) {
        await setEventState(state);
        for (const p of publicPaths) await assertFails(read('visitor1', p));
      }
    });
    it('スタッフは開場前・開場中に読める', async () => {
      for (const state of ['scheduled', 'open']) {
        await setEventState(state);
        for (const u of ['studentFree', 'faculty'] as const) {
          for (const p of publicPaths) await assertSucceeds(read(u, p));
          await assertSucceeds(getDocs(collection(fs(u), `${P}/slots`)));
        }
      }
    });
    it('スタッフは閉場後は読めない', async () => {
      await setEventState('closed');
      for (const p of publicPaths) await assertFails(read('studentA', p));
    });
    it('別イベント・未入場は読めない', async () => {
      for (const p of publicPaths) {
        await assertFails(read('visitorOther', p));
        await assertFails(read('anonymous', p));
      }
    });
    it('board は public 以外のドキュメントを読めない', async () => {
      await assertFails(read('visitor1', `${P}/board/other`));
      await assertFails(getDocs(collection(fs('visitor1'), `${P}/board`)));
    });
    it('管理者は閉場後も読める', async () => {
      await setEventState('closed');
      for (const p of publicPaths) await assertSucceeds(read('admin', p));
    });
  });

  describe('待ち行列 queues', () => {
    it('学生スタッフは占有中の枠の列だけ読める', async () => {
      await assertSucceeds(read('studentA', `${P}/queues/A-1`));
      await assertFails(read('studentA', `${P}/queues/A-2`));
      await assertFails(read('studentA', `${P}/queues/faculty`));
      await assertFails(read('studentFree', `${P}/queues/A-3`));
    });
    it('教員スタッフは教員相談の列だけ読める', async () => {
      await assertSucceeds(read('faculty', `${P}/queues/faculty`));
      await assertFails(read('faculty', `${P}/queues/A-1`));
    });
    it('来場者は列を読めない（自分の枠でも）', async () => {
      await assertFails(read('visitor1', `${P}/queues/A-1`));
      await assertFails(getDocs(collection(fs('visitor1'), `${P}/queues`)));
    });
    it('スタッフは列を一覧できない', async () => {
      await assertFails(getDocs(collection(fs('studentA'), `${P}/queues`)));
    });
    it('閉場後はスタッフも読めない', async () => {
      await setEventState('closed');
      await assertFails(read('studentA', `${P}/queues/A-1`));
      await assertFails(read('faculty', `${P}/queues/faculty`));
    });
    it('管理者は読める', async () => {
      await assertSucceeds(read('admin', `${P}/queues/A-1`));
      await assertSucceeds(getDocs(collection(fs('admin'), `${P}/queues`)));
    });
  });

  describe('入場記録 visitors とスタッフ staff', () => {
    it('来場者は自分の入場記録だけ読める', async () => {
      await assertSucceeds(read('visitor1', `${P}/visitors/v1`));
      await assertFails(read('visitor1', `${P}/visitors/v2`));
      await assertFails(getDocs(collection(fs('visitor1'), `${P}/visitors`)));
    });
    it('スタッフは来場者の入場記録を読めない', async () => {
      await assertFails(read('studentA', `${P}/visitors/v1`));
      await assertFails(read('faculty', `${P}/visitors/v1`));
    });
    it('スタッフは自分の記録だけ読める', async () => {
      await assertSucceeds(read('studentA', `${P}/staff/sA`));
      await assertSucceeds(read('faculty', `${P}/staff/f1`));
      await assertFails(read('studentA', `${P}/staff/f1`));
      await assertFails(getDocs(collection(fs('studentA'), `${P}/staff`)));
    });
    it('来場者はスタッフの記録を読めない', async () => {
      await assertFails(read('visitor1', `${P}/staff/sA`));
    });
    it('別イベントのクレームでは自分の記録も読めない', async () => {
      await assertFails(read('visitorOther', `${P}/visitors/v1`));
    });
    it('管理者は読める', async () => {
      await assertSucceeds(read('admin', `${P}/visitors/v1`));
      await assertSucceeds(read('admin', `${P}/staff/sA`));
    });
  });

  describe('監査ログ auditLog と統計 stats', () => {
    const paths = [`${P}/auditLog/l1`, `${P}/stats/2027-03-20`];
    it('TOTP 済みの管理者だけ読める', async () => {
      for (const p of paths) await assertSucceeds(read('admin', p));
      await assertSucceeds(getDocs(collection(fs('admin'), `${P}/auditLog`)));
    });
    it('TOTP なしの管理者・スタッフ・来場者は読めない', async () => {
      for (const u of ['adminNoTotp', 'adminSms', 'totpOnly', 'studentA', 'faculty', 'visitor1'] as const) {
        for (const p of paths) await assertFails(read(u, p));
      }
    });
  });

  describe('定義していないパスは誰も読めない', () => {
    it('ルート直下や未知のサブコレクション', async () => {
      await env.withSecurityRulesDisabled(async (c) => {
        await setDoc(doc(c.firestore(), 'rateLimits/x'), { n: 1 });
        await setDoc(doc(c.firestore(), `${P}/unknown/x`), { n: 1 });
      });
      for (const u of ['visitor1', 'studentA', 'admin'] as const) {
        await assertFails(read(u, 'rateLimits/x'));
        await assertFails(read(u, `${P}/unknown/x`));
      }
    });
  });

  // 設計書 7.4-4 を本番ルールで確かめる。本番では events を closed にした時点で止まる（15秒以内）。
  // Emulator は購読対象が次に更新されるまで止まらないので、閉場処理で整理券も更新する前提で確かめる。
  describe('閉場すると購読中の整理券が止まる（7.4-4）', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    it('閉場して整理券を更新したら、来場者の購読は permission-denied で止まる', async () => {
      const log: string[] = [];
      const unsub = onSnapshot(
        doc(fs('visitor1'), `${P}/tickets/t1`),
        (s) => log.push(`snapshot ${s.data()?.state}`),
        (e) => log.push(`error ${(e as { code?: string }).code}`),
      );
      await wait(800);
      await setEventState('closed');
      await env.withSecurityRulesDisabled(async (c) => {
        await updateDoc(doc(c.firestore(), `${P}/tickets/t1`), { state: 'expired', memo: null });
      });
      await wait(1500);
      unsub();
      expect(log[0]).toBe('snapshot waiting');
      expect(log).not.toContain('snapshot expired');
      expect(log).toContain('error permission-denied');
    });
  });
});

describe('Storage（プロフィール画像）', () => {
  const avatar = `events/${E}/avatars/A-1`;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  beforeAll(async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), avatar), png, { contentType: 'image/png' });
      await uploadBytes(ref(c.storage(), `other/file`), png, { contentType: 'image/png' });
    });
  });

  beforeEach(async () => {
    await seed('open');
  });

  const get = (user: User, path = avatar) => getBytes(ref(ctx(user).storage(), path));

  it('開場中の来場者は読める', async () => {
    await assertSucceeds(get('visitor1'));
  });
  it('来場者は開場前・閉場後は読めない', async () => {
    for (const state of ['scheduled', 'closed']) {
      await setEventState(state);
      await assertFails(get('visitor1'));
    }
  });
  it('スタッフは開場前・開場中に読め、閉場後は読めない', async () => {
    await setEventState('scheduled');
    await assertSucceeds(get('studentFree'));
    await assertSucceeds(get('faculty'));
    await setEventState('closed');
    await assertFails(get('studentFree'));
  });
  it('別イベント・未入場・未ログイン・TOTP なしの管理者は読めない', async () => {
    for (const u of ['visitorOther', 'anonymous', 'unauthenticated', 'adminNoTotp'] as const) {
      await assertFails(get(u));
    }
  });
  it('TOTP 済みの管理者は読める', async () => {
    await assertSucceeds(get('admin'));
  });
  it('誰もアップロード・削除できない（アップロードは関数で行う）', async () => {
    for (const u of ['visitor1', 'studentA', 'admin'] as const) {
      await assertFails(uploadBytes(ref(ctx(u).storage(), avatar), png));
      await assertFails(uploadBytes(ref(ctx(u).storage(), `events/${E}/avatars/new`), png));
    }
  });
  it('定義していないパスは誰も読めない', async () => {
    await assertFails(get('admin', 'other/file'));
  });
});
