// 定期処理（設計書 3.4）。1分ごとに tick を呼ぶ。何度呼んでも同じ結果になるように書く。
// - 開場時刻で受付開始、閉場時刻で残りの整理券を無効化し問診メモを全削除（lifecycle.ts）
// - スキップから復帰期限を過ぎた整理券を無効化
// - 閉場から1時間後に統計を集計し、整理券・枠・匿名ユーザーなどを削除
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  ACTIVE_TICKET_STATES,
  paths,
  type AuditAction,
  type AuditLogDoc,
  type EventDoc,
  type QueueDoc,
  type RuntimeStatusDoc,
  type SlotDoc,
  type StatsDoc,
  type TicketDoc,
  type VisitorDoc,
} from '@nt/shared';
import { writeBoardSlot } from './board.js';
import { expireAtFor, runTx } from './common.js';
import type { Deps } from './context.js';
import { closeEvent, expireRemaining, openEvent } from './lifecycle.js';
import { buildStats } from './stats.js';
import { assertTransition } from './transitions.js';

/** 閉場からこの時間が過ぎたら削除する */
export const PURGE_AFTER_CLOSE_MS = 60 * 60_000;
/** 開場のこの時間前から常駐（minInstances=1）にする */
export const WARMUP_BEFORE_OPEN_MS = 30 * 60_000;
/** 常駐設定に変化がなくても Cloud Run の実状態を再確認する間隔 */
export const HOT_RESYNC_MS = 15 * 60_000;
/** 本日の Firestore 読み取り回数を Cloud Monitoring から取り直す間隔 */
export const READS_REFRESH_MS = 5 * 60_000;

export interface TickResult {
  opened: string[];
  closed: string[];
  /** 復帰期限切れで expired にした整理券の数 */
  expiredSkipped: number;
  purged: string[];
  /** 今回 Cloud Run の常駐台数を変更したときだけ 0 または 1。変更なしなら null */
  hotInstances: 0 | 1 | null;
}

async function systemAudit(db: Firestore, eid: string, action: AuditAction, now: Date): Promise<void> {
  const event = (await db.doc(paths.event(eid)).get()).data() as EventDoc | undefined;
  if (!event) return;
  const doc: AuditLogDoc = {
    at: Timestamp.fromDate(now),
    action,
    actor: { uid: 'system', role: 'system' },
    target: eid,
    detail: {},
    expireAt: expireAtFor(event),
  };
  await db.collection(paths.auditLog(eid)).add(doc);
}

export async function tick(deps: Deps): Promise<TickResult> {
  const { db } = deps;
  const now = deps.now();
  const t = now.getTime();
  const result: TickResult = { opened: [], closed: [], expiredSkipped: 0, purged: [], hotInstances: null };
  const events = await db.collection('events').where('state', 'in', ['scheduled', 'open', 'closed']).get();
  let needHot = false;

  for (const doc of events.docs) {
    const eid = doc.id;
    const event = doc.data() as EventDoc;
    // 1つのイベントの失敗で、ほかのイベントの処理を止めない
    try {
      const opensAt = event.opensAt.toMillis();
      const closesAt = event.closesAt.toMillis();
      let state = event.state;
      if (state === 'scheduled' && t >= opensAt && t < closesAt) {
        if (await openEvent(db, eid, now)) {
          result.opened.push(eid);
          await systemAudit(db, eid, 'event.open', now);
        }
        state = 'open';
      }
      if ((state === 'scheduled' || state === 'open') && t >= closesAt) {
        if (await closeEvent(db, eid, now)) {
          result.closed.push(eid);
          await systemAudit(db, eid, 'event.close', now);
        }
        state = 'closed';
      }
      if (state === 'open') {
        result.expiredSkipped += await expireSkipped(db, eid, now);
      }
      if (state === 'closed') {
        // 閉場の後片付けが途中で止まっていたら続きを行う（有効な整理券が1枚でも残っていれば）
        const left = await db.collection(paths.tickets(eid)).where('state', 'in', [...ACTIVE_TICKET_STATES]).limit(1).get();
        if (!left.empty) await expireRemaining(db, eid, now);
        if (t >= closesAt + PURGE_AFTER_CLOSE_MS) {
          await purgeEvent(deps, eid, now);
          result.purged.push(eid);
          state = 'purged';
        }
      }
      // 開場中、または開場30分前〜閉場前のイベントが1つでもあれば常駐オン
      if (state === 'open' || (state === 'scheduled' && t >= opensAt - WARMUP_BEFORE_OPEN_MS && t < closesAt)) {
        needHot = true;
      }
    } catch (e) {
      console.error(`tick failed for event ${eid}`, e);
    }
  }

  result.hotInstances = await syncRuntimeStatus(deps, needHot ? 1 : 0, now);
  return result;
}

/**
 * 常駐設定の自動切替と、本日の Firestore 読み取り回数の更新。
 * 失敗してもイベントの開場・閉場には影響させない。
 */
async function syncRuntimeStatus(deps: Deps, desired: 0 | 1, now: Date): Promise<0 | 1 | null> {
  if (!deps.setHotInstances && !deps.getTodayFirestoreReads) return null;
  const ref = deps.db.doc(paths.runtimeStatus);
  const t = now.getTime();
  const ts = Timestamp.fromDate(now);

  let current: Partial<RuntimeStatusDoc> = {};
  try {
    const snap = await ref.get();
    if (snap.exists) current = snap.data() as Partial<RuntimeStatusDoc>;
  } catch (e) {
    console.error('failed to read runtimeStatus', e);
  }

  const patch: Partial<RuntimeStatusDoc> = {};
  let changedHot: 0 | 1 | null = null;

  if (deps.setHotInstances) {
    const prev = current.hotInstances;
    const due = !prev || prev.applied !== desired || t - prev.checkedAt.toMillis() >= HOT_RESYNC_MS;
    if (due) {
      try {
        const changed = await deps.setHotInstances(desired);
        if (changed) changedHot = desired;
        patch.hotInstances = { desired, applied: desired, checkedAt: ts };
      } catch (e) {
        console.error('syncHotInstances failed', e);
      }
    }
  }

  if (deps.getTodayFirestoreReads) {
    const prev = current.firestoreReads;
    const due = !prev || t - prev.updatedAt.toMillis() >= READS_REFRESH_MS;
    if (due) {
      try {
        const { today, date } = await deps.getTodayFirestoreReads(now);
        patch.firestoreReads = { today, date, updatedAt: ts };
      } catch (e) {
        console.error('refreshFirestoreReads failed', e);
      }
    }
  }

  if (Object.keys(patch).length > 0) {
    try {
      await ref.set(patch, { merge: true });
    } catch (e) {
      console.error('failed to write runtimeStatus', e);
    }
  }
  return changedHot;
}

// ---------------------------------------------------------------------------
// スキップの復帰期限切れ
// ---------------------------------------------------------------------------

/**
 * returnDeadline を過ぎたスキップ中の整理券を expired にする。
 * 復帰（returnTicket）は now <= returnDeadline、こちらは now > returnDeadline なので、境目で両方が成り立つことはない。
 */
export async function expireSkipped(db: Firestore, eid: string, now: Date): Promise<number> {
  const due = await db
    .collection(paths.tickets(eid))
    .where('state', '==', 'skipped')
    .where('returnDeadline', '<', Timestamp.fromDate(now))
    .get();
  let count = 0;
  for (const d of due.docs) {
    const done = await runTx(db, async (tx) => {
      const ticketSnap = await tx.get(d.ref);
      const ticket = ticketSnap.data() as TicketDoc | undefined;
      // 読んでから今までのあいだに復帰・キャンセルされていたら何もしない
      if (!ticket || ticket.state !== 'skipped' || !ticket.returnDeadline || ticket.returnDeadline.toMillis() >= now.getTime()) return false;
      assertTransition(ticket.state, 'expired');

      const eventSnap = await tx.get(db.doc(paths.event(eid)));
      const slotSnap = await tx.get(db.doc(paths.slot(eid, ticket.slotId)));
      const queueRef = db.doc(paths.queue(eid, ticket.slotId));
      const queueSnap = await tx.get(queueRef);
      const visitorRef = db.doc(paths.visitor(eid, ticket.visitorUid));
      const visitorSnap = await tx.get(visitorRef);

      const ts = Timestamp.fromDate(now);
      tx.update(d.ref, { state: 'expired', expiredAt: ts, memo: null, returnDeadline: null });
      if (visitorSnap.exists && (visitorSnap.data() as VisitorDoc).activeTicketId === d.id) {
        tx.update(visitorRef, { activeTicketId: null });
      }
      if (queueSnap.exists && slotSnap.exists && eventSnap.exists) {
        const queue = queueSnap.data() as QueueDoc;
        const next: QueueDoc = { ...queue, skipped: queue.skipped.filter((s) => s.ticketId !== d.id), updatedAt: ts };
        tx.set(queueRef, next);
        writeBoardSlot(tx, db, eid, ticket.slotId, eventSnap.data() as EventDoc, slotSnap.data() as SlotDoc, next, now);
      }
      return true;
    });
    if (done) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 閉場＋1時間の削除
// ---------------------------------------------------------------------------

/** 削除するサブコレクション（stats だけ残す） */
const PURGED_COLLECTIONS = ['tickets', 'queues', 'slots', 'board', 'visitors', 'staff', 'rateLimits', 'auditLog', 'secrets'] as const;

/**
 * 統計を保存してから、統計以外を物理削除する（設計書 4章 プライバシー）。
 * 途中で失敗しても、次の tick でもう一度最初から進む（統計は一度保存したら上書きしない）。
 */
export async function purgeEvent(deps: Deps, eid: string, now: Date): Promise<void> {
  const { db, auth } = deps;
  const eventRef = db.doc(paths.event(eid));
  const event = (await eventRef.get()).data() as EventDoc | undefined;
  if (!event || event.state !== 'closed') return;

  // 1. 統計
  const tickets = await db.collection(paths.tickets(eid)).get();
  const stats = buildStats(event, tickets.docs.map((d) => d.data() as TicketDoc));
  const statsRef = db.doc(paths.stats(eid, stats.date));
  await runTx(db, async (tx) => {
    if ((await tx.get(statsRef)).exists) return;
    const doc: StatsDoc = { ...stats, createdAt: Timestamp.fromDate(now) };
    tx.create(statsRef, doc);
  });

  // 2. 匿名ユーザー（来場者・スタッフ）。管理者などメール・外部 IdP を持つユーザーは消さない
  const uids = new Set<string>();
  for (const c of ['visitors', 'staff'] as const) {
    (await db.collection(`events/${eid}/${c}`).select().get()).docs.forEach((d) => uids.add(d.id));
  }
  const ids = [...uids];
  for (let i = 0; i < ids.length; i += 100) {
    const { users } = await auth.getUsers(ids.slice(i, i + 100).map((uid) => ({ uid })));
    const anonymous = users.filter((u) => u.providerData.length === 0 && !u.email && !u.phoneNumber && !u.customClaims?.admin);
    if (anonymous.length > 0) await auth.deleteUsers(anonymous.map((u) => u.uid));
  }

  // 3. Firestore（stats 以外のサブコレクション）
  for (const c of PURGED_COLLECTIONS) {
    await db.recursiveDelete(db.collection(`events/${eid}/${c}`));
  }

  // 4. 最後に状態を purged にする（ここまで済んで初めて次の tick の対象から外れる）
  await eventRef.update({ state: 'purged', updatedAt: Timestamp.fromDate(now) });
}
