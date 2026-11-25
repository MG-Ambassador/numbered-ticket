// P2 スタッフの関数（S-01〜S-09）。
// 完了条件（設計書 6章）のうち「同時呼出」をここで確かめる。
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FACULTY_SLOT_ID,
  paths,
  type AuditLogDoc,
  type BoardDoc,
  type QueueDoc,
  type SlotDoc,
  type StaffDoc,
  type TicketDoc,
  type VisitorDoc,
} from '@nt/shared';
import * as staff from '../../../functions/src/core/staff.js';
import * as visitor from '../../../functions/src/core/visitor.js';
import {
  FACULTY_CODE,
  NOW,
  SLOT_CODES,
  anonymous,
  auth,
  clearFirestore,
  db,
  expectReason,
  makeDeps,
  read,
  reasonOf,
  seedEvent,
  seedStaff,
  seedVisitors,
  staffCaller,
  visitorCaller,
  type SeedOptions,
} from './fixture.js';

const deps = makeDeps();
const at = (minutes: number) => makeDeps(new Date(NOW.getTime() + minutes * 60_000));

const S1 = staffCaller('staff-s1', 'student');
const FAC = [0, 1, 2].map((i) => staffCaller(`fac-${i}`, 'faculty'));

/** 担当つきのイベントを作り、slotId の列に n 人並べる。整理券 ID を待ち順で返す */
async function setup(opts: { slotId?: string; n?: number; studentSlots?: SeedOptions['studentSlots'] } = {}) {
  const slotId = opts.slotId ?? 's1';
  await seedEvent({ studentSlots: opts.studentSlots ?? [{ id: 's1', queueLimit: 10 }, { id: 's2', occupied: false }] });
  await seedStaff('e1', [
    { uid: 'staff-s1', role: 'student', slotId: 's1' },
    ...FAC.map((f, i) => ({ uid: f.uid, role: 'faculty' as const, booth: `F-${i + 1}` })),
  ]);
  const n = opts.n ?? 0;
  const uids = Array.from({ length: n }, (_, i) => `q${i}`);
  await seedVisitors('e1', uids);
  const ids: string[] = [];
  for (const u of uids) {
    ids.push((await visitor.issueTicket(deps, visitorCaller(u), { slotId, grade: null, themes: [], memo: 'メモ' })).ticketId);
  }
  return ids;
}

const queueOf = (slotId: string) => read<QueueDoc>(paths.queue('e1', slotId));
const ticketOf = (id: string) => read<TicketDoc>(paths.ticket('e1', id));
const boardOf = async (slotId: string) => (await read<BoardDoc>(paths.board('e1'))).slots[slotId]!;

beforeEach(async () => {
  await clearFirestore();
});

// ---------------------------------------------------------------------------

describe('S-01 ログイン', () => {
  it('学生枠のコードでログインすると role: student になり、空いていればその枠をそのまま担当する', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2', occupied: false }] });
    const uid = `st-${Date.now()}`;
    await auth.createUser({ uid });
    const res = await staff.staffLogin(deps, anonymous(uid), { code: `${SLOT_CODES.s2!.slice(0, 4)}-${SLOT_CODES.s2!.slice(4)}` });
    expect(res).toEqual({ eid: 'e1', role: 'student', slotId: 's2', booth: null });
    expect((await auth.getUser(uid)).customClaims).toEqual({ eid: 'e1', role: 'student' });
    expect(await read<StaffDoc>(paths.staff('e1', uid))).toMatchObject({ role: 'student', allowedSlotId: 's2', slotId: 's2' });
    expect((await read<SlotDoc>(paths.slot('e1', 's2'))).occupant?.uid).toBe(uid);
    expect(await boardOf('s2')).toMatchObject({ status: 'available', activeBooths: 1 });
  });

  it('枠が別の端末で担当中なら、ログインはできるが担当は待ち（ほかの枠は取れない）', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }, { id: 's2', occupied: false }] });
    const uid = `st-busy-${Date.now()}`;
    await auth.createUser({ uid });
    await expect(staff.staffLogin(deps, anonymous(uid), { code: SLOT_CODES.s1! })).resolves.toMatchObject({ role: 'student', slotId: null });
    expect(await read<StaffDoc>(paths.staff('e1', uid))).toMatchObject({ allowedSlotId: 's1', slotId: null });
    expect((await read<SlotDoc>(paths.slot('e1', 's1'))).occupant?.uid).toBe('staff-s1');
    const me = staffCaller(uid, 'student');
    await expectReason(staff.claimSlot(deps, me, { slotId: 's1' }), 'slotTaken');
    await expectReason(staff.claimSlot(deps, me, { slotId: 's2' }), 'forbidden');
  });

  it('教員のコードでログインすると role: faculty。ブースはこのあと設定する', async () => {
    await seedEvent();
    const uid = `fac-${Date.now()}`;
    await auth.createUser({ uid });
    await expect(staff.staffLogin(deps, anonymous(uid), { code: FACULTY_CODE })).resolves.toEqual({ eid: 'e1', role: 'faculty', slotId: null, booth: null });
    expect((await auth.getUser(uid)).customClaims).toEqual({ eid: 'e1', role: 'faculty' });
    expect(await read<StaffDoc>(paths.staff('e1', uid))).toMatchObject({ role: 'faculty', allowedSlotId: null, booth: null });
  });

  it('端末ごと 3回/10分', async () => {
    await seedEvent();
    for (let i = 0; i < 3; i++) {
      await expectReason(staff.staffLogin(deps, anonymous('st-x'), { code: '00000000' }), 'wrongCode');
    }
    await expectReason(staff.staffLogin(deps, anonymous('st-x'), { code: FACULTY_CODE }), 'rateLimited');
  });

  it('入場コード（来場者用）ではログインできない', async () => {
    await seedEvent();
    await expectReason(staff.staffLogin(deps, anonymous('st-y'), { code: '0384712' }), 'wrongCode');
  });

  it('担当を持ったまま別の担当のコードでは入り直せない。同じコードなら担当を返す', async () => {
    await setup({ studentSlots: [{ id: 's1', queueLimit: 10 }, { id: 's2', occupied: false }] });
    await auth.createUser({ uid: 'staff-s1' }).catch(() => undefined);
    await expectReason(staff.staffLogin(deps, anonymous('staff-s1'), { code: FACULTY_CODE }), 'alreadyAssigned');
    await expectReason(staff.staffLogin(deps, anonymous('staff-s1'), { code: SLOT_CODES.s2! }), 'alreadyAssigned');
    await expect(staff.staffLogin(deps, anonymous('staff-s1'), { code: SLOT_CODES.s1! })).resolves.toMatchObject({ role: 'student', slotId: 's1' });
    // 担当を外れたあとなら、別の枠のコードで入り直せる
    await staff.releaseAssignment(deps, S1);
    await expect(staff.staffLogin(deps, anonymous('staff-s1'), { code: SLOT_CODES.s2! })).resolves.toMatchObject({ role: 'student', slotId: 's2' });
    expect((await read<SlotDoc>(paths.slot('e1', 's1'))).occupant).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('S-02 担当設定・S-09 担当を外れる', () => {
  it('学生はコードで決まった未占有の枠を占有し、board が準備中から すぐ案内可 になる', async () => {
    await setup();
    await seedStaff('e1', [{ uid: 'st-new', role: 'student', allowedSlotId: 's2' }]);
    expect((await boardOf('s2')).status).toBe('preparing');

    await staff.claimSlot(deps, staffCaller('st-new', 'student'), { slotId: 's2' });
    expect((await read<SlotDoc>(paths.slot('e1', 's2'))).occupant?.uid).toBe('st-new');
    expect((await read<StaffDoc>(paths.staff('e1', 'st-new'))).slotId).toBe('s2');
    expect(await boardOf('s2')).toMatchObject({ status: 'available', activeBooths: 1 });
  });

  it('1枠1台: 2台が同時に同じ枠を取ると1台だけ成功', async () => {
    await setup();
    await seedStaff('e1', [{ uid: 'a', role: 'student', allowedSlotId: 's2' }, { uid: 'b', role: 'student', allowedSlotId: 's2' }]);
    const results = await Promise.allSettled(['a', 'b'].map((u) => staff.claimSlot(deps, staffCaller(u, 'student'), { slotId: 's2' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reasonOf((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toBe('slotTaken');
  });

  it('占有中の枠は取れない、コードの枠以外は取れない、教員は枠を取れない', async () => {
    await setup();
    await seedStaff('e1', [{ uid: 'c', role: 'student', allowedSlotId: 's1' }]);
    await expectReason(staff.claimSlot(deps, staffCaller('c', 'student'), { slotId: 's1' }), 'slotTaken');
    await expectReason(staff.claimSlot(deps, staffCaller('c', 'student'), { slotId: 's2' }), 'forbidden');
    await expectReason(staff.claimSlot(deps, S1, { slotId: 's2' }), 'forbidden');
    await expectReason(staff.claimSlot(deps, FAC[0]!, { slotId: 's2' }), 'forbidden');
  });

  it('教員はブース番号を設定し、稼働ブース数が増える。同じ番号は使えない', async () => {
    await setup();
    await seedStaff('e1', [{ uid: 'fnew', role: 'faculty' }]);
    await expectReason(staff.setBooth(deps, staffCaller('fnew', 'faculty'), { booth: 'F-1' }), 'boothTaken');
    await staff.setBooth(deps, staffCaller('fnew', 'faculty'), { booth: 'F-9' });
    expect((await boardOf(FACULTY_SLOT_ID)).activeBooths).toBe(4);
    await expectReason(staff.setBooth(deps, staffCaller('fnew', 'faculty'), { booth: 'F 9 <script>' }), 'invalidInput');
  });

  it('担当を外れる: 対応中があればできない。外れても列は残る', async () => {
    const [t1] = await setup({ n: 2 });
    await staff.callNext(deps, S1);
    await expectReason(staff.releaseAssignment(deps, S1), 'busy');
    await staff.startConsult(deps, S1, { ticketId: t1! });
    await staff.completeConsult(deps, S1, { ticketId: t1! });

    await staff.releaseAssignment(deps, S1);
    expect((await read<SlotDoc>(paths.slot('e1', 's1'))).occupant).toBeNull();
    expect((await queueOf('s1')).waiting).toHaveLength(1);
    expect(await boardOf('s1')).toMatchObject({ status: 'preparing', activeBooths: 0, waitingNumbers: [102] });
    // 外れたあとは呼べない
    await expectReason(staff.callNext(deps, S1), 'notAssigned');
  });

  it('強制解除された学生（occupant が別人）は操作できない', async () => {
    await setup({ n: 1 });
    await db.doc(paths.slot('e1', 's1')).update({ occupant: null });
    await expectReason(staff.callNext(deps, S1), 'notAssigned');
  });
});

// ---------------------------------------------------------------------------

describe('S-04 呼出・開始・完了', () => {
  it('呼出 → 開始 → 完了: 整理券・列・board・入場記録・相談時間', async () => {
    const [t1, t2] = await setup({ n: 2 });

    const called = await staff.callNext(deps, S1);
    expect(called).toEqual({ ticketId: t1, number: 101 });
    expect(await ticketOf(t1!)).toMatchObject({ state: 'calling', booth: 'A-1', staffUid: 'staff-s1' });
    expect(await boardOf('s1')).toMatchObject({ waitingNumbers: [102], servingNumbers: [101] });

    await staff.startConsult(deps, S1, { ticketId: t1! });
    expect((await queueOf('s1')).serving[0]).toMatchObject({ state: 'in_progress' });

    await staff.completeConsult(at(8), S1, { ticketId: t1! });
    const done = await ticketOf(t1!);
    expect(done).toMatchObject({ state: 'completed', memo: null });
    expect((await read<VisitorDoc>(paths.visitor('e1', 'q0'))).activeTicketId).toBeNull();
    const queue = await queueOf('s1');
    expect(queue.serving).toEqual([]);
    expect(queue.recentDurations).toEqual([480]);
    expect(await boardOf('s1')).toMatchObject({ waitingNumbers: [102], servingNumbers: [], avgConsultSeconds: 480 });
    expect((await ticketOf(t2!)).memo).toBe('メモ');
  });

  it('対応中のまま次は呼べない、列が空なら queueEmpty', async () => {
    await setup({ n: 1 });
    await staff.callNext(deps, S1);
    await expectReason(staff.callNext(deps, S1), 'busy');

    await clearFirestore();
    await setup({ n: 0 });
    await expectReason(staff.callNext(deps, S1), 'queueEmpty');
  });

  it('同時呼出: 教員3人が同時に呼ぶ → 別々の整理券を先頭から順に1枚ずつ', async () => {
    const ids = await setup({ slotId: FACULTY_SLOT_ID, n: 6 });
    const res = await Promise.all(FAC.map((f) => staff.callNext(deps, f)));
    expect(new Set(res.map((r) => r.ticketId)).size).toBe(3);
    expect(res.map((r) => r.number).sort()).toEqual([101, 102, 103]);

    const queue = await queueOf(FACULTY_SLOT_ID);
    expect(queue.waiting.map((e) => e.ticketId)).toEqual(ids.slice(3));
    expect(queue.serving).toHaveLength(3);
    // 呼んだ教員と案内先のブースが整理券と列で一致する
    for (const s of queue.serving) {
      const t = await ticketOf(s.ticketId);
      expect(t).toMatchObject({ state: 'calling', staffUid: s.staffUid, booth: s.booth });
      expect(s.booth).toBe(`F-${Number(s.staffUid!.split('-')[1]) + 1}`);
    }
    expect(await boardOf(FACULTY_SLOT_ID)).toMatchObject({ waitingNumbers: [104, 105, 106], activeBooths: 3 });
  });

  it('同時呼出: 同じスタッフが同時に3回押しても1組だけ呼ぶ', async () => {
    await setup({ n: 3 });
    const results = await Promise.allSettled([1, 2, 3].map(() => staff.callNext(deps, S1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => reasonOf((r as PromiseRejectedResult).reason))).toEqual(['busy', 'busy']);
    expect((await queueOf('s1')).waiting).toHaveLength(2);
  });

  it('同時呼出: 呼出と発券・キャンセルが同時に起きても列と board がそろう', async () => {
    const ids = await setup({ slotId: FACULTY_SLOT_ID, n: 4 });
    await seedVisitors('e1', ['late1', 'late2']);
    await Promise.all([
      ...FAC.map((f) => staff.callNext(deps, f)),
      visitor.issueTicket(deps, visitorCaller('late1'), { slotId: FACULTY_SLOT_ID, grade: null, themes: [], memo: null }),
      visitor.issueTicket(deps, visitorCaller('late2'), { slotId: FACULTY_SLOT_ID, grade: null, themes: [], memo: null }),
      visitor.cancelTicket(deps, visitorCaller('q3'), { ticketId: ids[3]! }),
    ]);
    const queue = await queueOf(FACULTY_SLOT_ID);
    const board = await boardOf(FACULTY_SLOT_ID);
    expect(queue.serving).toHaveLength(3);
    expect(queue.waiting.map((e) => e.number).sort()).toEqual([105, 106]);
    expect(board.waitingNumbers).toEqual(queue.waiting.map((e) => e.number));
    expect(board.servingNumbers).toEqual(queue.serving.map((e) => e.number));
    // 列にある整理券の状態が列と一致する
    for (const e of queue.waiting) expect((await ticketOf(e.ticketId)).state).toBe('waiting');
    for (const e of queue.serving) expect((await ticketOf(e.ticketId)).state).toBe('calling');
  });

  it('他人が対応中の整理券は開始・完了・スキップできない', async () => {
    const ids = await setup({ slotId: FACULTY_SLOT_ID, n: 1 });
    await staff.callNext(deps, FAC[0]!);
    await expectReason(staff.startConsult(deps, FAC[1]!, { ticketId: ids[0]! }), 'invalidState');
    await expectReason(staff.skipTicket(deps, FAC[1]!, { ticketId: ids[0]! }), 'invalidState');
    // 学生は教員の列を触れない
    await expectReason(staff.completeConsult(deps, S1, { ticketId: ids[0]! }), 'invalidState');
  });

  it('呼出前の完了・開始前の完了は状態遷移で拒否する', async () => {
    const [t1] = await setup({ n: 1 });
    await staff.callNext(deps, S1);
    await expectReason(staff.completeConsult(deps, S1, { ticketId: t1! }), 'invalidState');
  });

  it('開場前は呼べない', async () => {
    await setup({ n: 1 });
    await db.doc(paths.event('e1')).update({ state: 'scheduled' });
    await expectReason(staff.callNext(deps, S1), 'eventNotOpen');
  });
});

// ---------------------------------------------------------------------------

describe('S-05 不在スキップと復帰', () => {
  it('スキップで列から外れ、10分以内の復帰で先頭へ（上限を超えてもよい）', async () => {
    await seedEvent({ studentSlots: [{ id: 's1', queueLimit: 2 }] });
    await seedStaff('e1', [{ uid: 'staff-s1', role: 'student', slotId: 's1' }]);
    await seedVisitors('e1', ['a', 'b', 'c']);
    const issue = (u: string) => visitor.issueTicket(deps, visitorCaller(u), { slotId: 's1', grade: null, themes: [], memo: null });
    const a = await issue('a');
    await issue('b');
    await staff.callNext(deps, S1);
    await staff.skipTicket(deps, S1, { ticketId: a.ticketId });

    const skipped = await ticketOf(a.ticketId);
    expect(skipped).toMatchObject({ state: 'skipped', booth: 'A-1' });
    expect(skipped.returnDeadline!.toMillis()).toBe(NOW.getTime() + 10 * 60_000);
    expect((await read<VisitorDoc>(paths.visitor('e1', 'a'))).activeTicketId).toBe(a.ticketId);
    await issue('c'); // 上限 2 まで埋める

    await staff.returnTicket(at(10), S1, { ticketId: a.ticketId });
    const queue = await queueOf('s1');
    expect(queue.waiting.map((e) => e.number)).toEqual([101, 102, 103]);
    expect(queue.skipped).toEqual([]);
    expect(await ticketOf(a.ticketId)).toMatchObject({ state: 'waiting', returnDeadline: null });
    expect(await boardOf('s1')).toMatchObject({ waitingNumbers: [101, 102, 103], pauseReason: 'limit' });
  });

  it('期限を過ぎると復帰できない', async () => {
    const [t1] = await setup({ n: 1 });
    await staff.callNext(deps, S1);
    await staff.skipTicket(deps, S1, { ticketId: t1! });
    await expectReason(staff.returnTicket(makeDeps(new Date(NOW.getTime() + 10 * 60_000 + 1)), S1, { ticketId: t1! }), 'returnExpired');
  });

  it('スキップ中の来場者はキャンセルでき、スキップ一覧からも外れる', async () => {
    const [t1] = await setup({ n: 1 });
    await staff.callNext(deps, S1);
    await staff.skipTicket(deps, S1, { ticketId: t1! });
    await visitor.cancelTicket(deps, visitorCaller('q0'), { ticketId: t1! });
    expect((await queueOf('s1')).skipped).toEqual([]);
  });

  it('同時に復帰を2回押しても先頭に1回だけ入る', async () => {
    const [t1] = await setup({ n: 2 });
    await staff.callNext(deps, S1);
    await staff.skipTicket(deps, S1, { ticketId: t1! });
    await Promise.allSettled([1, 2].map(() => staff.returnTicket(deps, S1, { ticketId: t1! })));
    expect((await queueOf('s1')).waiting.map((e) => e.number)).toEqual([101, 102]);
  });
});

// ---------------------------------------------------------------------------

describe('S-07 受付停止・S-08 列の上限', () => {
  it('停止中は発券できないが、並んでいる方は呼べる。再開で戻る', async () => {
    await setup({ n: 1 });
    await seedVisitors('e1', ['p']);
    await staff.setSlotPaused(deps, S1, { paused: true });
    expect(await boardOf('s1')).toMatchObject({ status: 'paused', pauseReason: 'staff' });
    await expectReason(visitor.issueTicket(deps, visitorCaller('p'), { slotId: 's1', grade: null, themes: [], memo: null }), 'slotPaused');
    await expect(staff.callNext(deps, S1)).resolves.toMatchObject({ number: 101 });

    await staff.setSlotPaused(deps, S1, { paused: false });
    await expect(visitor.issueTicket(deps, visitorCaller('p'), { slotId: 's1', grade: null, themes: [], memo: null })).resolves.toBeTruthy();
  });

  it('教員スタッフは教員相談の列を停止できる（ブース未設定でも可）', async () => {
    await setup();
    await seedStaff('e1', [{ uid: 'fx', role: 'faculty' }]);
    await staff.setSlotPaused(deps, staffCaller('fx', 'faculty'), { paused: true });
    expect((await read<SlotDoc>(paths.slot('e1', FACULTY_SLOT_ID))).paused).toBe(true);
  });

  it('上限の変更: 範囲と刻みを守り、変更履歴を残し、board に反映する', async () => {
    await setup();
    for (const bad of [0, 11, 2.5, '5']) {
      await expectReason(staff.setQueueLimit(deps, S1, { queueLimit: bad as number }), 'invalidInput');
    }
    for (const bad of [5, 85, 42]) {
      await expectReason(staff.setQueueLimit(deps, FAC[0]!, { queueLimit: bad }), 'invalidInput');
    }
    await staff.setQueueLimit(deps, S1, { queueLimit: 6 });
    await staff.setQueueLimit(deps, FAC[0]!, { queueLimit: 45 });

    expect((await read<SlotDoc>(paths.slot('e1', 's1'))).queueLimit).toBe(6);
    expect((await boardOf('s1')).queueLimit).toBe(6);
    expect((await boardOf(FACULTY_SLOT_ID)).queueLimit).toBe(45);
    const logs = (await db.collection(paths.auditLog('e1')).get()).docs.map((d) => d.data() as AuditLogDoc);
    expect(logs.map((l) => [l.target, l.detail.from, l.detail.to, l.actor.role]).sort()).toEqual([
      ['faculty', 40, 45, 'faculty'],
      ['s1', 10, 6, 'student'],
    ]);
    expect(logs[0]!.expireAt).toBeInstanceOf(Timestamp);
  });

  it('上限を下げても並んでいる方はそのまま。新しい発券だけ止まる', async () => {
    await setup({ n: 3 });
    await seedVisitors('e1', ['over']);
    await staff.setQueueLimit(deps, S1, { queueLimit: 2 });
    expect((await queueOf('s1')).waiting).toHaveLength(3);
    await expectReason(visitor.issueTicket(deps, visitorCaller('over'), { slotId: 's1', grade: null, themes: [], memo: null }), 'full');
  });

  it('来場者のクレームではスタッフの操作はできない', async () => {
    await setup();
    await expectReason(staff.callNext(deps, visitorCaller('q0')), 'forbidden');
    await expectReason(staff.setQueueLimit(deps, anonymous('x'), { queueLimit: 5 }), 'forbidden');
  });
});
