// P2 定期処理（設計書 3.4）。完了条件（設計書 6章）のうち「スキップ期限」をここで確かめる。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  paths,
  type AuditLogDoc,
  type BoardDoc,
  type EventDoc,
  type QueueDoc,
  type RuntimeStatusDoc,
  type StatsDoc,
  type TicketDoc,
  type VisitorDoc,
} from '@nt/shared';
import {
  HOT_RESYNC_MS,
  PURGE_AFTER_CLOSE_MS,
  READS_REFRESH_MS,
  WARMUP_BEFORE_OPEN_MS,
  tick,
} from '../../../functions/src/core/scheduler.js';
import * as staff from '../../../functions/src/core/staff.js';
import * as visitor from '../../../functions/src/core/visitor.js';
import {
  NOW,
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
} from './fixture.js';

const deps = makeDeps();
const S1 = staffCaller('staff-s1', 'student');
const OPENS = new Date('2027-03-20T01:00:00Z');
const CLOSES = new Date('2027-03-20T07:00:00Z');
const at = (ms: number) => makeDeps(new Date(ms));
const issue = (uid: string, slotId = 's1', memo: string | null = 'メモ') =>
  visitor.issueTicket(deps, visitorCaller(uid), { slotId, grade: '高校3年', themes: ['入試'], memo });

/** s1 の列に n 人並べ、先頭を呼んでスキップする。スキップした整理券の ID を返す */
async function skipOne(n = 2): Promise<{ skipped: string; others: string[] }> {
  await seedEvent();
  await seedStaff('e1', [{ uid: 'staff-s1', role: 'student', slotId: 's1' }]);
  const uids = Array.from({ length: n }, (_, i) => `v${i}`);
  await seedVisitors('e1', uids);
  const ids: string[] = [];
  for (const u of uids) ids.push((await issue(u)).ticketId);
  await staff.callNext(deps, S1);
  await staff.skipTicket(deps, S1, { ticketId: ids[0]! });
  return { skipped: ids[0]!, others: ids.slice(1) };
}

const DEADLINE = NOW.getTime() + 10 * 60_000;

beforeEach(async () => {
  await clearFirestore();
});

// ---------------------------------------------------------------------------

describe('スキップの復帰期限', () => {
  it('期限を過ぎると expired にし、列・board・入場記録から外す。来場者は新しく発券できる', async () => {
    const { skipped } = await skipOne();
    const res = await tick(at(DEADLINE + 1));
    expect(res.expiredSkipped).toBe(1);

    expect(await read<TicketDoc>(paths.ticket('e1', skipped))).toMatchObject({ state: 'expired', memo: null, returnDeadline: null });
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).skipped).toEqual([]);
    expect((await read<VisitorDoc>(paths.visitor('e1', 'v0'))).activeTicketId).toBeNull();
    expect((await read<BoardDoc>(paths.board('e1'))).slots['s1']!.waitingNumbers).toEqual([102]);
    await expect(issue('v0')).resolves.toMatchObject({ number: 103 });
  });

  it('期限ちょうどまでは無効化せず、復帰できる', async () => {
    const { skipped } = await skipOne();
    expect((await tick(at(DEADLINE))).expiredSkipped).toBe(0);
    expect((await read<TicketDoc>(paths.ticket('e1', skipped))).state).toBe('skipped');
    await staff.returnTicket(at(DEADLINE), S1, { ticketId: skipped });
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).waiting.map((e) => e.number)).toEqual([101, 102]);
  });

  it('期限を過ぎてからの復帰は拒否する（定期処理の前でも後でも）', async () => {
    const { skipped } = await skipOne();
    await expectReason(staff.returnTicket(at(DEADLINE + 1), S1, { ticketId: skipped }), 'returnExpired');
    await tick(at(DEADLINE + 1));
    await expectReason(staff.returnTicket(at(DEADLINE + 1), S1, { ticketId: skipped }), 'invalidState');
  });

  it('期限の直後に定期処理と復帰が同時に走っても、どちらか一方だけが通る', async () => {
    const { skipped } = await skipOne();
    const later = at(DEADLINE + 1);
    const [t, r] = await Promise.allSettled([tick(later), staff.returnTicket(later, S1, { ticketId: skipped })]);
    expect(t.status).toBe('fulfilled');
    expect(r.status).toBe('rejected');
    expect(reasonOf((r as PromiseRejectedResult).reason)).toMatch(/returnExpired|invalidState/);
    const queue = await read<QueueDoc>(paths.queue('e1', 's1'));
    expect(queue.skipped).toEqual([]);
    expect(queue.waiting.map((e) => e.ticketId)).not.toContain(skipped);
    expect((await read<TicketDoc>(paths.ticket('e1', skipped))).state).toBe('expired');
  });

  it('期限前に復帰と定期処理が同時に走っても、復帰が勝ち、無効化されない', async () => {
    const { skipped } = await skipOne();
    const before = at(DEADLINE - 1000);
    await Promise.all([tick(before), staff.returnTicket(before, S1, { ticketId: skipped })]);
    expect((await read<TicketDoc>(paths.ticket('e1', skipped))).state).toBe('waiting');
    expect((await read<QueueDoc>(paths.queue('e1', 's1'))).waiting[0]!.ticketId).toBe(skipped);
  });

  it('複数の列・複数の整理券をまとめて処理し、期限前のものは残す', async () => {
    await seedEvent({ studentSlots: [{ id: 's1' }], facultyBooths: 2 });
    await seedStaff('e1', [
      { uid: 'staff-s1', role: 'student', slotId: 's1' },
      { uid: 'fac-0', role: 'faculty', booth: 'F-1' },
      { uid: 'fac-1', role: 'faculty', booth: 'F-2' },
    ]);
    await seedVisitors('e1', ['a', 'b', 'c']);
    const a = await issue('a');
    const b = await issue('b', 'faculty');
    const c = await issue('c', 'faculty');
    await staff.callNext(deps, S1);
    await staff.skipTicket(deps, S1, { ticketId: a.ticketId });
    await staff.callNext(deps, staffCaller('fac-0', 'faculty'));
    await staff.skipTicket(deps, staffCaller('fac-0', 'faculty'), { ticketId: b.ticketId });
    // c は 5 分後にスキップ（期限も 5 分遅い）
    await staff.callNext(at(NOW.getTime() + 5 * 60_000), staffCaller('fac-1', 'faculty'));
    await staff.skipTicket(at(NOW.getTime() + 5 * 60_000), staffCaller('fac-1', 'faculty'), { ticketId: c.ticketId });

    expect((await tick(at(DEADLINE + 1))).expiredSkipped).toBe(2);
    expect((await read<TicketDoc>(paths.ticket('e1', c.ticketId))).state).toBe('skipped');
    expect((await read<QueueDoc>(paths.queue('e1', 'faculty'))).skipped.map((s) => s.ticketId)).toEqual([c.ticketId]);
    expect((await tick(at(DEADLINE + 5 * 60_000 + 1))).expiredSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('開場・閉場', () => {
  it('開場時刻で open にし、閉場時刻で closed にして問診メモを全削除する', async () => {
    await seedEvent({ state: 'scheduled' });
    expect((await tick(at(OPENS.getTime() - 1))).opened).toEqual([]);
    expect((await tick(at(OPENS.getTime()))).opened).toEqual(['e1']);
    expect((await tick(at(OPENS.getTime() + 60_000))).opened).toEqual([]); // 2回目は何もしない
    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('open');

    await seedVisitors('e1', ['a']);
    const a = await issue('a');
    expect((await tick(at(CLOSES.getTime() - 1))).closed).toEqual([]);
    expect((await tick(at(CLOSES.getTime()))).closed).toEqual(['e1']);
    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('closed');
    expect(await read<TicketDoc>(paths.ticket('e1', a.ticketId))).toMatchObject({ state: 'expired', memo: null });

    const logs = (await db.collection(paths.auditLog('e1')).get()).docs.map((d) => d.data() as AuditLogDoc);
    expect(logs.map((l) => [l.action, l.actor.role]).sort()).toEqual([
      ['event.close', 'system'],
      ['event.open', 'system'],
    ]);
  });

  it('開場しないまま閉場時刻を過ぎたら、そのまま閉場にする', async () => {
    await seedEvent({ state: 'scheduled' });
    const res = await tick(at(CLOSES.getTime() + 1000));
    expect(res).toMatchObject({ opened: [], closed: ['e1'] });
  });

  it('閉場の後片付けが途中で止まっていたら、次の回で続きを行う', async () => {
    await seedEvent();
    await seedVisitors('e1', ['a']);
    const a = await issue('a');
    // 状態だけ closed になり、整理券の無効化が済んでいない状態
    await db.doc(paths.event('e1')).update({ state: 'closed' });
    await tick(at(CLOSES.getTime() + 60_000));
    expect(await read<TicketDoc>(paths.ticket('e1', a.ticketId))).toMatchObject({ state: 'expired', memo: null });
  });
});

// ---------------------------------------------------------------------------

describe('閉場＋1時間の削除', () => {
  async function closedEventWithData() {
    await seedEvent();
    await seedStaff('e1', [{ uid: 'staff-s1', role: 'student', slotId: 's1' }]);
    const visitors = [`pv-${Date.now()}`, `pw-${Date.now()}`];
    for (const uid of visitors) await auth.createUser({ uid });
    await auth.createUser({ uid: 'staff-s1' }).catch(() => undefined);
    // 管理者が visitors に紛れていても消さない
    const adminUid = `adm-${Date.now()}`;
    await auth.createUser({ uid: adminUid, email: `${adminUid}@example.com`, password: 'abcdefghijklmn' });
    await auth.setCustomUserClaims(adminUid, { admin: true });
    await seedVisitors('e1', [...visitors, adminUid]);

    const a = await issue(visitors[0]!);
    await issue(visitors[1]!);
    await staff.callNext(deps, S1);
    await staff.startConsult(deps, S1, { ticketId: a.ticketId });
    await staff.completeConsult(at(NOW.getTime() + 8 * 60_000), S1, { ticketId: a.ticketId });
    await tick(at(CLOSES.getTime()));
    return { visitors, adminUid };
  }

  it('閉場から1時間たつまでは消さない', async () => {
    await closedEventWithData();
    expect((await tick(at(CLOSES.getTime() + PURGE_AFTER_CLOSE_MS - 1))).purged).toEqual([]);
    expect((await db.collection(paths.tickets('e1')).get()).size).toBe(2);
  });

  it('統計を保存し、統計以外（整理券・枠・匿名ユーザーなど）を削除して purged にする', async () => {
    const { visitors, adminUid } = await closedEventWithData();
    const res = await tick(at(CLOSES.getTime() + PURGE_AFTER_CLOSE_MS));
    expect(res.purged).toEqual(['e1']);

    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('purged');
    const stats = await read<StatsDoc>(paths.stats('e1', '2027-03-20'));
    expect(stats).toMatchObject({ issued: 2, completed: 1, expired: 1, avgConsultSeconds: 480, gradeTheme: { 高校3年: { 入試: 2 } } });

    for (const c of ['tickets', 'queues', 'slots', 'board', 'visitors', 'staff', 'rateLimits', 'auditLog', 'secrets']) {
      expect((await db.collection(`events/e1/${c}`).get()).size, c).toBe(0);
    }

    const { users, notFound } = await auth.getUsers([...visitors, 'staff-s1', adminUid].map((uid) => ({ uid })));
    expect(notFound).toHaveLength(3);
    expect(users.map((u) => u.uid)).toEqual([adminUid]);

    // もう一度呼んでも何もしない（統計も上書きしない）
    expect((await tick(at(CLOSES.getTime() + PURGE_AFTER_CLOSE_MS + 60_000))).purged).toEqual([]);
    expect((await read<StatsDoc>(paths.stats('e1', '2027-03-20'))).createdAt).toEqual(stats.createdAt);
  });

  it('削除が途中で止まっても、次の回で最後まで進み、統計は最初のものを残す', async () => {
    await closedEventWithData();
    const first = makeDeps(new Date(CLOSES.getTime() + PURGE_AFTER_CLOSE_MS));
    // 匿名ユーザーの削除で失敗させる（統計の保存までは済む）
    const broken = {
      ...first,
      auth: {
        getUsers: first.auth.getUsers.bind(first.auth),
        deleteUsers: async () => Promise.reject(new Error('auth down')),
      } as never,
    };
    expect((await tick(broken)).purged).toEqual([]);
    expect((await read<EventDoc>(paths.event('e1'))).state).toBe('closed');
    const saved = await read<StatsDoc>(paths.stats('e1', '2027-03-20'));
    expect(saved.issued).toBe(2);

    expect((await tick(at(CLOSES.getTime() + PURGE_AFTER_CLOSE_MS + 60_000))).purged).toEqual(['e1']);
    expect((await read<StatsDoc>(paths.stats('e1', '2027-03-20'))).createdAt).toEqual(saved.createdAt);
  });

  it('1つのイベントで失敗しても、ほかのイベントは処理する', async () => {
    await seedEvent({ eid: 'e1', state: 'scheduled' });
    await seedEvent({ eid: 'e2', state: 'scheduled' });
    await db.doc(paths.event('e1')).update({ opensAt: 'こわれた値' as never });
    const res = await tick(at(OPENS.getTime()));
    expect(res.opened).toEqual(['e2']);
  });
});

// ---------------------------------------------------------------------------

describe('常駐設定の自動切替とDB読み取り回数の記録', () => {
  function makeOps(reads = 1234) {
    const hotCalls: (0 | 1)[] = [];
    let currentHot: 0 | 1 = 0;
    let readsCalls = 0;
    const setHotInstances = async (count: 0 | 1) => {
      hotCalls.push(count);
      const changed = currentHot !== count;
      currentHot = count;
      return changed;
    };
    const getTodayFirestoreReads = async () => {
      readsCalls++;
      return { today: reads, date: '2027-03-20' };
    };
    return {
      hotCalls,
      get readsCalls() {
        return readsCalls;
      },
      depsAt: (ms: number) => ({ ...at(ms), setHotInstances, getTodayFirestoreReads }),
    };
  }

  it('開場30分前より前は0、開場30分前で1になり、閉場で0に戻る', async () => {
    await seedEvent({ state: 'scheduled' });
    const ops = makeOps(500);

    // 開場31分前: まだ0
    const before = await tick(ops.depsAt(OPENS.getTime() - WARMUP_BEFORE_OPEN_MS - 60_000));
    expect(before.hotInstances).toBeNull();
    expect(ops.hotCalls).toEqual([0]);
    expect((await read<RuntimeStatusDoc>(paths.runtimeStatus)).hotInstances).toMatchObject({ desired: 0, applied: 0 });

    // 開場30分前ちょうど: 1に切り替わる
    const warmup = await tick(ops.depsAt(OPENS.getTime() - WARMUP_BEFORE_OPEN_MS));
    expect(warmup.hotInstances).toBe(1);
    expect(ops.hotCalls).toEqual([0, 1]);
    expect((await read<RuntimeStatusDoc>(paths.runtimeStatus)).hotInstances).toMatchObject({ desired: 1, applied: 1 });

    // 開場中（1分後）: 同じ1なので API は再呼び出ししない
    const during = await tick(ops.depsAt(OPENS.getTime() - WARMUP_BEFORE_OPEN_MS + 60_000));
    expect(during.hotInstances).toBeNull();
    expect(ops.hotCalls).toEqual([0, 1]);

    // 閉場時刻: 自動閉場と同時に0に戻る
    const closed = await tick(ops.depsAt(CLOSES.getTime()));
    expect(closed.closed).toEqual(['e1']);
    expect(closed.hotInstances).toBe(0);
    expect(ops.hotCalls).toEqual([0, 1, 0]);
    expect((await read<RuntimeStatusDoc>(paths.runtimeStatus)).hotInstances).toMatchObject({ desired: 0, applied: 0 });
  });

  it('複数イベントがあるとき、片方が閉場しても他方が開場中なら1を維持し、両方閉場で0に戻る', async () => {
    await seedEvent({ eid: 'e1', state: 'open' });
    await seedEvent({ eid: 'e2', state: 'open' });
    // e2 は e1 より1時間遅く閉場する
    const { Timestamp } = await import('firebase-admin/firestore');
    await db.doc(paths.event('e2')).update({ closesAt: Timestamp.fromMillis(CLOSES.getTime() + 60 * 60_000) });

    const ops = makeOps();
    await tick(ops.depsAt(OPENS.getTime() + 60_000));
    expect(ops.hotCalls).toEqual([1]);

    // e1 が閉場しても e2 が開場中なので1のまま（15分以上経過しているため再確認は走るが変更なし）
    const r1 = await tick(ops.depsAt(CLOSES.getTime()));
    expect(r1.closed).toEqual(['e1']);
    expect(r1.hotInstances).toBeNull();
    expect((await read<RuntimeStatusDoc>(paths.runtimeStatus)).hotInstances).toMatchObject({ desired: 1, applied: 1 });

    // e2 も閉場すると0に戻る
    const r2 = await tick(ops.depsAt(CLOSES.getTime() + 60 * 60_000));
    expect(r2.closed).toEqual(['e2']);
    expect(r2.hotInstances).toBe(0);
    expect(ops.hotCalls.at(-1)).toBe(0);
  });

  it('状態が同じでも15分ごとに再確認し、DB読み取り回数は5分ごとに更新する', async () => {
    await seedEvent({ state: 'open' });
    const ops = makeOps(12345);
    const t0 = OPENS.getTime() + 60_000;

    await tick(ops.depsAt(t0));
    expect(ops.hotCalls).toHaveLength(1);
    expect(ops.readsCalls).toBe(1);
    expect((await read<RuntimeStatusDoc>(paths.runtimeStatus)).firestoreReads).toMatchObject({ today: 12345, date: '2027-03-20' });

    // 4分後: どちらもスキップ
    await tick(ops.depsAt(t0 + READS_REFRESH_MS - 60_000));
    expect(ops.hotCalls).toHaveLength(1);
    expect(ops.readsCalls).toBe(1);

    // 5分後: DB読み取りだけ更新
    await tick(ops.depsAt(t0 + READS_REFRESH_MS));
    expect(ops.hotCalls).toHaveLength(1);
    expect(ops.readsCalls).toBe(2);

    // 15分後: 常駐状態も再確認
    await tick(ops.depsAt(t0 + HOT_RESYNC_MS));
    expect(ops.hotCalls).toHaveLength(2);
    expect(ops.readsCalls).toBe(3);
  });

  it('GCP API が失敗しても、イベントの開場・閉場処理には影響しない', async () => {
    await seedEvent({ state: 'scheduled' });
    const failingDeps = {
      ...at(OPENS.getTime()),
      setHotInstances: async () => Promise.reject(new Error('run api error')),
      getTodayFirestoreReads: async () => Promise.reject(new Error('monitoring error')),
    };
    const res = await tick(failingDeps);
    expect(res.opened).toEqual(['e1']);
    expect(res.hotInstances).toBeNull();
  });
});

