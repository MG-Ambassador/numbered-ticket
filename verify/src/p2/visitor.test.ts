// P2 来場者の関数（V-01・V-03・V-05・V-06）。
// 完了条件（設計書 6章）のうち「同時発券」「二重発券」をここで確かめる。
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  paths,
  type BoardDoc,
  type EventDoc,
  type IssueTicketRequest,
  type QueueDoc,
  type TicketDoc,
  type VisitorDoc,
} from '@nt/shared';
import { computeBoardSlot } from '../../../functions/src/core/board.js';
import { clientIp } from '../../../functions/src/core/context.js';
import { isAnonymousSignUp } from '../../../functions/src/core/auth.js';
import * as visitor from '../../../functions/src/core/visitor.js';
import {
  ENTRY_CODE,
  NOW,
  anonymous,
  auth,
  clearFirestore,
  db,
  expectReason,
  makeDeps,
  read,
  reasonOf,
  seedEvent,
  visitorCaller,
} from './fixture.js';

const deps = makeDeps();

function req(slotId: string, over: Partial<IssueTicketRequest> = {}): IssueTicketRequest {
  return { slotId, grade: '高校3年', themes: ['入試'], memo: '指定校推薦について', ...over };
}

async function seedVisitors(eid: string, uids: string[]): Promise<void> {
  const batch = db.batch();
  const expireAt = Timestamp.fromDate(new Date('2027-03-21T00:00:00Z'));
  for (const uid of uids) {
    const doc: VisitorDoc = { enteredAt: Timestamp.fromDate(NOW), activeTicketId: null, expireAt };
    batch.set(db.doc(paths.visitor(eid, uid)), doc);
  }
  await batch.commit();
}

beforeEach(async () => {
  await clearFirestore();
});

// ---------------------------------------------------------------------------

describe('V-01 入場コード照合', () => {
  it('正しいコードで入場記録を作り、クレーム { eid, role: visitor } を付ける', async () => {
    await seedEvent();
    const uid = `v-enter-${Date.now()}`;
    await auth.createUser({ uid });

    const res = await visitor.enterEvent(deps, anonymous(uid), { code: '038-4712' });
    expect(res).toEqual({ eid: 'e1', activeTicketId: null });
    expect((await auth.getUser(uid)).customClaims).toEqual({ eid: 'e1', role: 'visitor' });
    expect(await read<VisitorDoc>(paths.visitor('e1', uid))).toMatchObject({ activeTicketId: null });
  });

  it('再入場では有効な整理券の ID を返す', async () => {
    await seedEvent();
    const uid = `v-reenter-${Date.now()}`;
    await auth.createUser({ uid });
    await visitor.enterEvent(deps, anonymous(uid), { code: ENTRY_CODE });
    const { ticketId } = await visitor.issueTicket(deps, visitorCaller(uid), req('s1'));

    const res = await visitor.enterEvent(deps, visitorCaller(uid), { code: ENTRY_CODE });
    expect(res.activeTicketId).toBe(ticketId);
  });

  it('コードが違えば wrongCode', async () => {
    await seedEvent();
    await expectReason(visitor.enterEvent(deps, anonymous('v-wrong'), { code: '1234567' }), 'wrongCode');
    await expectReason(visitor.enterEvent(deps, anonymous('v-wrong'), { code: 'abc' }), 'wrongCode');
  });

  it('匿名ログイン以外は拒否する', async () => {
    await seedEvent();
    const caller = { ...anonymous('pw-user'), provider: 'password' };
    await expectReason(visitor.enterEvent(deps, caller, { code: ENTRY_CODE }), 'notAnonymous');
    await expectReason(visitor.enterEvent(deps, null, { code: ENTRY_CODE }), 'notAnonymous');
  });

  it('開場前・開場中のイベントがなければ noEvent', async () => {
    await seedEvent({ state: 'closed' });
    await expectReason(visitor.enterEvent(deps, anonymous('v-x'), { code: ENTRY_CODE }), 'noEvent');
  });

  it('端末ごと 5回/10分: 5回失敗すると正しいコードでも止まり、10分後に戻る', async () => {
    await seedEvent();
    const uid = `v-limit-${Date.now()}`;
    await auth.createUser({ uid });
    for (let i = 0; i < 5; i++) {
      await expectReason(visitor.enterEvent(deps, anonymous(uid, `198.51.100.${i}`), { code: '0000000' }), 'wrongCode');
    }
    const err = await expectReason(visitor.enterEvent(deps, anonymous(uid, '198.51.100.99'), { code: ENTRY_CODE }), 'rateLimited');
    expect((err.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(600);

    const later = makeDeps(new Date(NOW.getTime() + 600_000 + 1000));
    await expect(visitor.enterEvent(later, anonymous(uid), { code: ENTRY_CODE })).resolves.toMatchObject({ eid: 'e1' });
  });

  it('IP ごと 50回/10分: 別の端末でも同じ IP なら止まる。成功は数えない', async () => {
    await seedEvent();
    const ip = '192.0.2.10';
    // 成功は何回でも数えない（会場 Wi-Fi で大勢が同じ IP になるため）
    for (let i = 0; i < 3; i++) {
      const uid = `v-ok-${i}-${Date.now()}`;
      await auth.createUser({ uid });
      await visitor.enterEvent(deps, anonymous(uid, ip), { code: ENTRY_CODE });
    }
    for (let i = 0; i < 50; i++) {
      await expectReason(visitor.enterEvent(deps, anonymous(`v-ip-${i}`, ip), { code: '0000000' }), 'wrongCode');
    }
    await expectReason(visitor.enterEvent(deps, anonymous('v-ip-new', ip), { code: ENTRY_CODE }), 'rateLimited');
    // 別の IP は通る
    const uid = `v-other-ip-${Date.now()}`;
    await auth.createUser({ uid });
    await expect(visitor.enterEvent(deps, anonymous(uid, '192.0.2.11'), { code: ENTRY_CODE })).resolves.toBeTruthy();
  });

  it('試行の記録に uid・IP をそのまま残さない', async () => {
    await seedEvent();
    await expectReason(visitor.enterEvent(deps, anonymous('v-raw', '192.0.2.77'), { code: '0000000' }), 'wrongCode');
    const docs = await db.collection('events/e1/rateLimits').get();
    expect(docs.size).toBe(2);
    for (const d of docs.docs) {
      expect(d.id).not.toContain('v-raw');
      expect(d.id).not.toContain('192.0.2.77');
      expect(JSON.stringify(d.data())).not.toContain('192.0.2.77');
      expect(d.data().expireAt).toBeInstanceOf(Timestamp);
    }
  });
});

// ---------------------------------------------------------------------------

describe('V-03 発券', () => {
  it('整理券・列・採番・入場記録・board を1つのトランザクションで更新する', async () => {
    await seedEvent();
    await seedVisitors('e1', ['v1']);
    const res = await visitor.issueTicket(deps, visitorCaller('v1'), req('s1'));
    expect(res.number).toBe(DEFAULTS.firstTicketNumber);

    const ticket = await read<TicketDoc>(paths.ticket('e1', res.ticketId));
    expect(ticket).toMatchObject({ state: 'waiting', slotId: 's1', kind: 'student', visitorUid: 'v1', number: 101, memo: '指定校推薦について' });
    expect(ticket.expireAt.toMillis()).toBe(new Date('2027-03-20T09:00:00Z').getTime());
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).waiting).toEqual([{ ticketId: res.ticketId, number: 101 }]);
    expect((await read<EventDoc>(paths.event('e1'))).nextTicketNumber).toBe(102);
    expect((await read<VisitorDoc>(paths.visitor('e1', 'v1'))).activeTicketId).toBe(res.ticketId);
    const board = await read<BoardDoc>(paths.board('e1'));
    expect(board.slots['s1']).toMatchObject({ status: 'accepting', waitingNumbers: [101], activeBooths: 1 });
  });

  it('同時発券: 20人が同時に上限5の枠へ → 5人だけ発券、番号は重複しない', async () => {
    await seedEvent({ studentSlots: [{ id: 's1', queueLimit: 5 }] });
    const uids = Array.from({ length: 20 }, (_, i) => `v${i}`);
    await seedVisitors('e1', uids);

    const results = await Promise.allSettled(uids.map((u) => visitor.issueTicket(deps, visitorCaller(u), req('s1'))));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ number: number }>).value);
    const reasons = results.filter((r) => r.status === 'rejected').map((r) => reasonOf((r as PromiseRejectedResult).reason));

    expect(ok).toHaveLength(5);
    expect(reasons).toEqual(Array(15).fill('full'));
    expect(ok.map((r) => r.number).sort()).toEqual([101, 102, 103, 104, 105]);

    const queue = await read<QueueDoc>(paths.queue('e1', 's1'));
    expect(queue.waiting.map((e) => e.number)).toEqual([101, 102, 103, 104, 105]);
    expect((await read<EventDoc>(paths.event('e1'))).nextTicketNumber).toBe(106);
    const board = await read<BoardDoc>(paths.board('e1'));
    expect(board.slots['s1']).toMatchObject({ status: 'paused', pauseReason: 'limit', waitingNumbers: [101, 102, 103, 104, 105] });
    expect((await db.collection(paths.tickets('e1')).get()).size).toBe(5);
  });

  it('同時発券: 複数の枠へ同時に発券しても番号はイベント全体で重複しない', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
    const targets = ['s1', 's2', 's3', FACULTY_SLOT_ID];
    const uids = Array.from({ length: 16 }, (_, i) => `m${i}`);
    await seedVisitors('e1', uids);

    const res = await Promise.all(uids.map((u, i) => visitor.issueTicket(deps, visitorCaller(u), req(targets[i % 4]!))));
    const numbers = res.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 16 }, (_, i) => 101 + i));

    const board = await read<BoardDoc>(paths.board('e1'));
    for (const t of targets) {
      const queue = await read<QueueDoc>(paths.queue('e1', t));
      expect(queue.waiting).toHaveLength(4);
      expect(board.slots[t]!.waitingNumbers).toEqual(queue.waiting.map((e) => e.number));
    }
  });

  it('二重発券: 同じ端末から同時に5回 → 1枚だけ', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2' }] });
    await seedVisitors('e1', ['dup']);
    const targets = ['s1', 's2', FACULTY_SLOT_ID, 's1', 's2'];
    const results = await Promise.allSettled(targets.map((t) => visitor.issueTicket(deps, visitorCaller('dup'), req(t))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reasons = results.filter((r) => r.status === 'rejected').map((r) => reasonOf((r as PromiseRejectedResult).reason));
    expect(reasons).toEqual(Array(4).fill('alreadyHasTicket'));
    expect((await db.collection(paths.tickets('e1')).where('visitorUid', '==', 'dup').get()).size).toBe(1);
  });

  it('キャンセル後は再び発券できる', async () => {
    await seedEvent();
    await seedVisitors('e1', ['re']);
    const first = await visitor.issueTicket(deps, visitorCaller('re'), req('s1'));
    await expectReason(visitor.issueTicket(deps, visitorCaller('re'), req(FACULTY_SLOT_ID)), 'alreadyHasTicket');
    await visitor.cancelTicket(deps, visitorCaller('re'), { ticketId: first.ticketId });
    const second = await visitor.issueTicket(deps, visitorCaller('re'), req(FACULTY_SLOT_ID));
    expect(second.number).toBe(102);
  });

  it('受付できないときは理由を返す', async () => {
    await seedEvent({ studentSlots: [{ id: 's1', paused: true }, { id: 's2', occupied: false }] });
    await seedVisitors('e1', ['why']);
    await expectReason(visitor.issueTicket(deps, visitorCaller('why'), req('s1')), 'slotPaused');
    await expectReason(visitor.issueTicket(deps, visitorCaller('why'), req('s2')), 'preparing');
    await expectReason(visitor.issueTicket(deps, visitorCaller('why'), req('nope')), 'notFound');

    await clearFirestore();
    await seedEvent({ paused: true });
    await seedVisitors('e1', ['why']);
    await expectReason(visitor.issueTicket(deps, visitorCaller('why'), req('s1')), 'globalPaused');

    await clearFirestore();
    await seedEvent({ state: 'scheduled' });
    await seedVisitors('e1', ['why']);
    await expectReason(visitor.issueTicket(deps, visitorCaller('why'), req('s1')), 'eventNotOpen');
  });

  it('来場者のクレームがなければ拒否、入場記録がなければ notFound', async () => {
    await seedEvent();
    await expectReason(visitor.issueTicket(deps, anonymous('noclaim'), req('s1')), 'notAnonymous');
    await expectReason(
      visitor.issueTicket(deps, { ...visitorCaller('st'), role: 'student' }, req('s1')),
      'notAnonymous',
    );
    await expectReason(visitor.issueTicket(deps, visitorCaller('never-entered'), req('s1')), 'notFound');
  });

  it('問診の検証: 学年・テーマ（5個まで、選択肢のみ）・自由記述（200字）', async () => {
    await seedEvent();
    await seedVisitors('e1', ['q']);
    const bad: Partial<IssueTicketRequest>[] = [
      { grade: '大学1年' as never },
      { themes: ['入試', '入試'] },
      { themes: ['存在しないテーマ'] },
      { themes: ['入試', '授業', '学生生活', '就職', '留学', '資格'] },
      { memo: 'あ'.repeat(201) },
      { memo: 123 as never },
    ];
    for (const b of bad) {
      await expectReason(visitor.issueTicket(deps, visitorCaller('q'), req('s1', b)), 'invalidInput');
    }
    // 200字ちょうど・空白だけ（null になる）は通る
    const r = await visitor.issueTicket(deps, visitorCaller('q'), req('s1', { grade: null, themes: [], memo: '   ' }));
    expect((await read<TicketDoc>(paths.ticket('e1', r.ticketId))).memo).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('V-06 キャンセル・V-05 いま向かいます', () => {
  it('キャンセルで列から外し、memo を消し、board を更新する', async () => {
    await seedEvent();
    await seedVisitors('e1', ['c1', 'c2']);
    const a = await visitor.issueTicket(deps, visitorCaller('c1'), req('s1'));
    const b = await visitor.issueTicket(deps, visitorCaller('c2'), req('s1'));
    await visitor.cancelTicket(deps, visitorCaller('c1'), { ticketId: a.ticketId });

    const ticket = await read<TicketDoc>(paths.ticket('e1', a.ticketId));
    expect(ticket).toMatchObject({ state: 'canceled', memo: null });
    expect(ticket.canceledAt).toBeInstanceOf(Timestamp);
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).waiting).toEqual([{ ticketId: b.ticketId, number: b.number }]);
    expect((await read<VisitorDoc>(paths.visitor('e1', 'c1'))).activeTicketId).toBeNull();
    expect((await read<BoardDoc>(paths.board('e1'))).slots['s1']!.waitingNumbers).toEqual([b.number]);
  });

  it('他人の整理券はキャンセルできない、終わった整理券もできない', async () => {
    await seedEvent();
    await seedVisitors('e1', ['own', 'other']);
    const t = await visitor.issueTicket(deps, visitorCaller('own'), req('s1'));
    await expectReason(visitor.cancelTicket(deps, visitorCaller('other'), { ticketId: t.ticketId }), 'notFound');
    await visitor.cancelTicket(deps, visitorCaller('own'), { ticketId: t.ticketId });
    await expectReason(visitor.cancelTicket(deps, visitorCaller('own'), { ticketId: t.ticketId }), 'invalidState');
    await expectReason(visitor.cancelTicket(deps, visitorCaller('own'), { ticketId: '../x' }), 'invalidInput');
  });

  it('同時キャンセル: 同じ整理券を同時に3回 → 1回だけ成功', async () => {
    await seedEvent();
    await seedVisitors('e1', ['cc']);
    const t = await visitor.issueTicket(deps, visitorCaller('cc'), req('s1'));
    const results = await Promise.allSettled([1, 2, 3].map(() => visitor.cancelTicket(deps, visitorCaller('cc'), { ticketId: t.ticketId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('呼出中の整理券だけ「いま向かいます」を記録できる', async () => {
    await seedEvent();
    await seedVisitors('e1', ['ar']);
    const t = await visitor.issueTicket(deps, visitorCaller('ar'), req('s1'));
    await expectReason(visitor.markArriving(deps, visitorCaller('ar'), { ticketId: t.ticketId }), 'invalidState');
    await db.doc(paths.ticket('e1', t.ticketId)).update({ state: 'calling' });
    await visitor.markArriving(deps, visitorCaller('ar'), { ticketId: t.ticketId });
    expect((await read<TicketDoc>(paths.ticket('e1', t.ticketId))).arrivingAt).toBeInstanceOf(Timestamp);
  });
});

// ---------------------------------------------------------------------------

describe('部品', () => {
  const event = { paused: false, consultMinutes: 10 } as EventDoc;
  const slot = { kind: 'student', paused: false, queueLimit: 5 } as never;
  const queue = (over: Partial<QueueDoc> = {}): QueueDoc =>
    ({ kind: 'student', booths: [{ staffUid: 'x', booth: 'A-1' }], waiting: [], skipped: [], serving: [], recentDurations: [], ...over }) as QueueDoc;
  const w = (n: number) => ({ ticketId: `t${n}`, number: n });

  it('board の状態: すぐ案内可／受付中／一時停止中（理由つき）／準備中', () => {
    expect(computeBoardSlot(event, slot, queue()).status).toBe('available');
    expect(computeBoardSlot(event, slot, queue({ waiting: [w(1)] })).status).toBe('accepting');
    expect(computeBoardSlot(event, slot, queue({ booths: [] })).status).toBe('preparing');
    expect(computeBoardSlot(event, { ...(slot as object), paused: true } as never, queue())).toMatchObject({ status: 'paused', pauseReason: 'staff' });
    expect(computeBoardSlot(event, slot, queue({ waiting: [1, 2, 3, 4, 5].map(w) }))).toMatchObject({ status: 'paused', pauseReason: 'limit' });
    expect(computeBoardSlot({ ...event, paused: true }, slot, queue())).toMatchObject({ status: 'paused', pauseReason: 'global' });
  });

  it('目安時間の材料: 実績がなければ相談時間、あれば直近の平均', () => {
    expect(computeBoardSlot(event, slot, queue()).avgConsultSeconds).toBe(600);
    expect(computeBoardSlot(event, slot, queue({ recentDurations: [300, 500] })).avgConsultSeconds).toBe(400);
  });

  it('IP は X-Forwarded-For の末尾を使う（7.4-3）', () => {
    expect(clientIp('1.2.3.4, 202.13.156.120')).toBe('202.13.156.120');
    expect(clientIp(['1.2.3.4', '::ffff:10.0.0.1'])).toBe('10.0.0.1');
    expect(clientIp(undefined)).toBeNull();
  });

  it('新規登録は匿名だけ通す', () => {
    expect(isAnonymousSignUp({ providerData: [] } as never)).toBe(true);
    expect(isAnonymousSignUp({ providerData: [{ providerId: 'password' }], email: 'a@example.com' } as never)).toBe(false);
    expect(isAnonymousSignUp({ providerData: [], email: 'a@example.com' } as never)).toBe(false);
    expect(isAnonymousSignUp(undefined)).toBe(false);
  });
});
