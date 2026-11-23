// 来場者の関数（V-01 入場、V-03 発券、V-05「いま向かいます」、V-06 キャンセル）。
// 書き込みはすべてトランザクションで行い、待ち上限・二重発券をサーバ側で防ぐ。
import { timingSafeEqual } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import {
  CANCELABLE_TICKET_STATES,
  DEFAULTS,
  GRADES,
  RATE_LIMITS,
  paths,
  type EnterEventRequest,
  type EnterEventResponse,
  type EventDoc,
  type IssueTicketRequest,
  type IssueTicketResponse,
  type QueueDoc,
  type SecretCodesDoc,
  type SlotDoc,
  type TicketDoc,
  type TicketRequest,
  type TicketState,
  type VisitorDoc,
} from '@nt/shared';
import { writeBoardSlot } from './board.js';
import { SLOT_ID, expireAtFor, getOrFail, isActive, normalizeCode, ticketIdOf, runTx } from './common.js';
import { requireAnonymous, requireRole, type Caller, type Deps } from './context.js';
import { fail } from './errors.js';
import { findActiveEvent } from './event.js';
import { assertTransition } from './transitions.js';
import { rateLimitRef, readRateLimit, recordFailure, retryAfterSeconds } from './rateLimit.js';

/** 7桁の数字に正規化する（区切りのハイフン・空白は取り除く）。形が違えば null */
export function normalizeEntryCode(raw: unknown): string | null {
  return normalizeCode(raw, 7);
}

export function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// V-01 入場コード照合
// ---------------------------------------------------------------------------

export async function enterEvent(deps: Deps, caller: Caller | null, req: EnterEventRequest): Promise<EnterEventResponse> {
  const me = requireAnonymous(caller);
  const now = deps.now();
  const { db } = deps;
  const { eid, event } = await findActiveEvent(db);

  const secret = deps.rateLimitSecret();
  const deviceRef = rateLimitRef(db, eid, secret, 'entryDevice', me.uid);
  const ipRef = rateLimitRef(db, eid, secret, 'entryIp', me.ip ?? 'unknown');
  const code = normalizeEntryCode(req?.code);

  const result = await runTx(db, async (tx) => {
    const device = await readRateLimit(tx, deviceRef, RATE_LIMITS.entryPerDevice, now);
    const ip = await readRateLimit(tx, ipRef, RATE_LIMITS.entryPerIp, now);
    const wait = Math.max(retryAfterSeconds(device, now) ?? 0, retryAfterSeconds(ip, now) ?? 0);
    if (wait > 0) return { ok: false as const, retryAfterSeconds: wait };

    const secrets = await tx.get(db.doc(paths.secretCodes(eid)));
    const visitorRef = db.doc(paths.visitor(eid, me.uid));
    const visitorSnap = await tx.get(visitorRef);
    const expected = secrets.exists ? (secrets.data() as SecretCodesDoc).entryCode : null;

    if (!code || !expected || !sameCode(code, expected)) {
      recordFailure(tx, device, now);
      recordFailure(tx, ip, now);
      return { ok: false as const, retryAfterSeconds: null };
    }

    if (!visitorSnap.exists) {
      const doc: VisitorDoc = { enteredAt: Timestamp.fromDate(now), activeTicketId: null, expireAt: expireAtFor(event) };
      tx.create(visitorRef, doc);
      return { ok: true as const, activeTicketId: null };
    }
    return { ok: true as const, activeTicketId: (visitorSnap.data() as VisitorDoc).activeTicketId };
  });

  if (!result.ok) {
    if (result.retryAfterSeconds) fail('resource-exhausted', 'rateLimited', { retryAfterSeconds: result.retryAfterSeconds });
    fail('permission-denied', 'wrongCode');
  }

  // クレームはトランザクションの外で付ける。失敗しても再試行すれば同じ結果になる
  if (me.eid !== eid || me.role !== 'visitor') {
    await deps.auth.setCustomUserClaims(me.uid, { eid, role: 'visitor' });
  }
  return { eid, activeTicketId: result.activeTicketId };
}

// ---------------------------------------------------------------------------
// V-03 発券
// ---------------------------------------------------------------------------

interface Answers {
  grade: TicketDoc['grade'];
  themes: string[];
  memo: string | null;
}

export function validateAnswers(event: EventDoc, req: IssueTicketRequest): Answers {
  const grade = req.grade ?? null;
  if (grade !== null && !(GRADES as readonly string[]).includes(grade)) fail('invalid-argument', 'invalidInput');

  const themes = req.themes ?? [];
  if (
    !Array.isArray(themes) ||
    themes.length > DEFAULTS.maxThemes ||
    new Set(themes).size !== themes.length ||
    themes.some((t) => typeof t !== 'string' || !event.themes.includes(t))
  ) {
    fail('invalid-argument', 'invalidInput');
  }

  let memo = req.memo ?? null;
  if (memo !== null) {
    if (typeof memo !== 'string') fail('invalid-argument', 'invalidInput');
    memo = memo.trim();
    if ([...memo].length > DEFAULTS.memoMaxLength) fail('invalid-argument', 'invalidInput');
    if (memo === '') memo = null;
  }
  return { grade, themes, memo };
}

export async function issueTicket(deps: Deps, caller: Caller | null, req: IssueTicketRequest): Promise<IssueTicketResponse> {
  const me = requireRole(caller, 'visitor');
  const slotId = req?.slotId;
  if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const eid = me.eid;
  const now = deps.now();

  const eventRef = db.doc(paths.event(eid));
  const slotRef = db.doc(paths.slot(eid, slotId));
  const queueRef = db.doc(paths.queue(eid, slotId));
  const visitorRef = db.doc(paths.visitor(eid, me.uid));

  return runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, eventRef);
    const slot = await getOrFail<SlotDoc>(tx, slotRef);
    const queue = await getOrFail<QueueDoc>(tx, queueRef);
    const visitor = await getOrFail<VisitorDoc>(tx, visitorRef);

    // 1端末1枚（V-03）
    if (visitor.activeTicketId) {
      const current = await tx.get(db.doc(paths.ticket(eid, visitor.activeTicketId)));
      if (current.exists && isActive((current.data() as TicketDoc).state)) fail('already-exists', 'alreadyHasTicket');
    }

    if (event.state !== 'open') fail('failed-precondition', 'eventNotOpen');
    if (event.paused) fail('failed-precondition', 'globalPaused');
    if (queue.booths.length === 0) fail('failed-precondition', 'preparing');
    if (slot.paused) fail('failed-precondition', 'slotPaused');
    if (queue.waiting.length >= slot.queueLimit) fail('failed-precondition', 'full');

    const answers = validateAnswers(event, req);
    const number = event.nextTicketNumber;
    const ticketRef = db.collection(paths.tickets(eid)).doc();
    const ts = Timestamp.fromDate(now);

    const ticket: TicketDoc = {
      number,
      slotId,
      kind: slot.kind,
      visitorUid: me.uid,
      state: 'waiting',
      booth: null,
      staffUid: null,
      ...answers,
      createdAt: ts,
      calledAt: null,
      arrivingAt: null,
      startedAt: null,
      completedAt: null,
      skippedAt: null,
      returnDeadline: null,
      canceledAt: null,
      expiredAt: null,
      expireAt: expireAtFor(event),
    };
    const nextQueue: QueueDoc = {
      ...queue,
      waiting: [...queue.waiting, { ticketId: ticketRef.id, number }],
      updatedAt: ts,
    };

    tx.create(ticketRef, ticket);
    tx.update(eventRef, { nextTicketNumber: number + 1, updatedAt: ts });
    tx.set(queueRef, nextQueue);
    tx.update(visitorRef, { activeTicketId: ticketRef.id });
    writeBoardSlot(tx, db, eid, slotId, event, slot, nextQueue, now);
    return { ticketId: ticketRef.id, number };
  });
}

// ---------------------------------------------------------------------------
// V-06 キャンセル
// ---------------------------------------------------------------------------

export async function cancelTicket(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireRole(caller, 'visitor');
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const eid = me.eid;
  const now = deps.now();
  const ticketRef = db.doc(paths.ticket(eid, ticketId));

  await runTx(db, async (tx) => {
    const ticket = await getOrFail<TicketDoc>(tx, ticketRef);
    if (ticket.visitorUid !== me.uid) fail('not-found', 'notFound');
    if (!(CANCELABLE_TICKET_STATES as readonly TicketState[]).includes(ticket.state)) {
      fail('failed-precondition', 'invalidState');
    }
    assertTransition(ticket.state, 'canceled');

    const eventRef = db.doc(paths.event(eid));
    const slotRef = db.doc(paths.slot(eid, ticket.slotId));
    const queueRef = db.doc(paths.queue(eid, ticket.slotId));
    const visitorRef = db.doc(paths.visitor(eid, me.uid));
    const event = await getOrFail<EventDoc>(tx, eventRef);
    const slot = await getOrFail<SlotDoc>(tx, slotRef);
    const queue = await getOrFail<QueueDoc>(tx, queueRef);
    const visitorSnap = await tx.get(visitorRef);

    const ts = Timestamp.fromDate(now);
    const nextQueue: QueueDoc = {
      ...queue,
      waiting: queue.waiting.filter((e) => e.ticketId !== ticketId),
      skipped: queue.skipped.filter((e) => e.ticketId !== ticketId),
      serving: queue.serving.filter((e) => e.ticketId !== ticketId),
      updatedAt: ts,
    };

    tx.update(ticketRef, { state: 'canceled', canceledAt: ts, memo: null, returnDeadline: null });
    tx.set(queueRef, nextQueue);
    if (visitorSnap.exists && (visitorSnap.data() as VisitorDoc).activeTicketId === ticketId) {
      tx.update(visitorRef, { activeTicketId: null });
    }
    writeBoardSlot(tx, db, eid, ticket.slotId, event, slot, nextQueue, now);
  });
}

// ---------------------------------------------------------------------------
// V-05「いま向かいます」
// ---------------------------------------------------------------------------

export async function markArriving(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireRole(caller, 'visitor');
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const ticketRef = db.doc(paths.ticket(me.eid, ticketId));

  await runTx(db, async (tx) => {
    const ticket = await getOrFail<TicketDoc>(tx, ticketRef);
    if (ticket.visitorUid !== me.uid) fail('not-found', 'notFound');
    if (ticket.state !== 'calling') fail('failed-precondition', 'invalidState');
    if (ticket.arrivingAt) return;
    tx.update(ticketRef, { arrivingAt: Timestamp.fromDate(deps.now()) });
  });
}
