// スタッフの関数（S-01〜S-09）。
// 列（queues）を書き換える操作は、すべて1つのトランザクションで整理券・列・board をそろえて更新する。
import { Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  RATE_LIMITS,
  paths,
  type AuditLogDoc,
  type CallNextResponse,
  type ClaimSlotRequest,
  type EventDoc,
  type QueueDoc,
  type SecretCodesDoc,
  type ServingEntry,
  type SetBoothRequest,
  type SetQueueLimitRequest,
  type SetSlotPausedRequest,
  type SlotDoc,
  type StaffDoc,
  type StaffLoginRequest,
  type StaffLoginResponse,
  type StaffRole,
  type StudentSlotDoc,
  type TicketDoc,
  type TicketRequest,
  type VisitorDoc,
} from '@nt/shared';
import { writeBoardSlot } from './board.js';
import { SLOT_ID, expireAtFor, getOrFail, normalizeCode, ticketIdOf, runTx } from './common.js';
import { requireAnonymous, type Caller, type Deps } from './context.js';
import { fail } from './errors.js';
import { findActiveEvent } from './event.js';
import { rateLimitRef, readRateLimit, recordFailure, retryAfterSeconds } from './rateLimit.js';
import { assertTransition } from './transitions.js';
import { sameCode } from './visitor.js';

const BOOTH = /^[0-9A-Za-z-]{1,16}$/;

type StaffCaller = Caller & { eid: string; role: StaffRole };

function requireStaff(caller: Caller | null): StaffCaller {
  if (!caller) fail('unauthenticated', 'forbidden');
  if (!caller.eid || (caller.role !== 'student' && caller.role !== 'faculty')) fail('permission-denied', 'forbidden');
  return caller as StaffCaller;
}

/** スタッフが操作できるのは開場前・開場中だけ */
function requireStaffEvent(event: EventDoc): void {
  if (event.state !== 'scheduled' && event.state !== 'open') fail('failed-precondition', 'eventNotOpen');
}

// ---------------------------------------------------------------------------
// S-01 ログイン
// ---------------------------------------------------------------------------

/** コードがどの担当のものか。学生枠のコードならその枠 ID、教員のコードなら FACULTY_SLOT_ID。違えば null */
function matchStaffCode(codes: SecretCodesDoc | null, code: string | null): { role: StaffRole; slotId: string | null } | null {
  if (!codes || !code) return null;
  let hit: { role: StaffRole; slotId: string | null } | null = null;
  // 一致しても途中で抜けない（何番目で一致したかで時間が変わらないように）
  if (codes.facultyCode && sameCode(code, codes.facultyCode)) hit = { role: 'faculty', slotId: null };
  for (const [slotId, c] of Object.entries(codes.slotCodes ?? {})) {
    if (sameCode(code, c)) hit = { role: 'student', slotId };
  }
  return hit;
}

/**
 * S-01 ログイン。役割と担当はコードで決まる。
 * - 学生枠のコード: その枠だけを担当できる。枠が空いていれば、そのまま占有する（別の端末が担当中なら待つ）
 * - 教員のコード: 教員相談の列。ブースはこのあと設定する
 */
export async function staffLogin(deps: Deps, caller: Caller | null, req: StaffLoginRequest): Promise<StaffLoginResponse> {
  const me = requireAnonymous(caller);
  const now = deps.now();
  const { db } = deps;
  const { eid, event } = await findActiveEvent(db);
  const deviceRef = rateLimitRef(db, eid, deps.rateLimitSecret(), 'staffDevice', me.uid);
  const code = normalizeCode(req?.code, 8);

  const result = await runTx(db, async (tx) => {
    const device = await readRateLimit(tx, deviceRef, RATE_LIMITS.staffPerDevice, now);
    const wait = retryAfterSeconds(device, now);
    if (wait) return { ok: false as const, retryAfterSeconds: wait };

    const secrets = await tx.get(db.doc(paths.secretCodes(eid)));
    const staffRef = db.doc(paths.staff(eid, me.uid));
    const staffSnap = await tx.get(staffRef);
    const hit = matchStaffCode(secrets.exists ? (secrets.data() as SecretCodesDoc) : null, code);
    if (!hit) {
      recordFailure(tx, device, now);
      return { ok: false as const, retryAfterSeconds: null };
    }
    const { role, slotId: allowedSlotId } = hit;
    const prev = staffSnap.exists ? (staffSnap.data() as StaffDoc) : null;
    // 担当を持ったまま別の担当のコードで入り直すと、枠やブースが残ってしまう
    if (prev && (prev.slotId || prev.booth) && (prev.role !== role || (prev.slotId && prev.slotId !== allowedSlotId))) {
      fail('failed-precondition', 'alreadyAssigned');
    }

    // 学生: 枠が空いていればそのまま担当する
    let claim: Loaded | null = null;
    if (allowedSlotId && prev?.slotId !== allowedSlotId) {
      const l = await loadSlot(tx, db, eid, allowedSlotId);
      if (l.slot.kind === 'student' && !l.slot.occupant && (l.event.state === 'scheduled' || l.event.state === 'open')) claim = l;
    }

    const ts = Timestamp.fromDate(now);
    const slotId = claim ? allowedSlotId : prev?.role === role ? (prev.slotId ?? null) : null;
    const booth = prev?.role === role ? (prev.booth ?? null) : null;
    if (prev) tx.update(staffRef, { role, allowedSlotId, slotId, booth, loggedInAt: ts, lastSeenAt: ts });
    else tx.create(staffRef, { role, allowedSlotId, slotId, booth: null, loggedInAt: ts, lastSeenAt: ts, expireAt: expireAtFor(event) } satisfies StaffDoc);
    if (claim && allowedSlotId) occupy(tx, db, eid, allowedSlotId, claim, me.uid, now);
    return { ok: true as const, role, slotId, booth };
  });

  if (!result.ok) {
    if (result.retryAfterSeconds) fail('resource-exhausted', 'rateLimited', { retryAfterSeconds: result.retryAfterSeconds });
    fail('permission-denied', 'wrongCode');
  }
  if (me.eid !== eid || me.role !== result.role) {
    await deps.auth.setCustomUserClaims(me.uid, { eid, role: result.role });
  }
  return { eid, role: result.role, slotId: result.slotId, booth: result.booth };
}

// ---------------------------------------------------------------------------
// S-02 担当設定・S-09 担当を外れる
// ---------------------------------------------------------------------------

interface Loaded {
  event: EventDoc;
  slot: SlotDoc;
  queue: QueueDoc;
}

async function loadSlot(tx: Transaction, db: Firestore, eid: string, slotId: string): Promise<Loaded> {
  const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
  const slot = await getOrFail<SlotDoc>(tx, db.doc(paths.slot(eid, slotId)));
  const queue = await getOrFail<QueueDoc>(tx, db.doc(paths.queue(eid, slotId)));
  return { event, slot, queue };
}

function saveQueue(tx: Transaction, db: Firestore, eid: string, slotId: string, l: Loaded, queue: QueueDoc, now: Date, slot: SlotDoc = l.slot): void {
  tx.set(db.doc(paths.queue(eid, slotId)), queue);
  writeBoardSlot(tx, db, eid, slotId, l.event, slot, queue, now);
}

/** 枠を占有し、列の案内先ブースをそろえる（読み取りはすべて済ませてから呼ぶ） */
function occupy(tx: Transaction, db: Firestore, eid: string, slotId: string, l: Loaded, uid: string, now: Date): void {
  const ts = Timestamp.fromDate(now);
  const prev = l.slot as StudentSlotDoc;
  const slot: StudentSlotDoc = { ...prev, occupant: { uid, since: ts }, updatedAt: ts };
  const queue: QueueDoc = { ...l.queue, booths: [{ staffUid: uid, booth: prev.location }], updatedAt: ts };
  tx.update(db.doc(paths.slot(eid, slotId)), { occupant: slot.occupant, updatedAt: ts });
  tx.update(db.doc(paths.staff(eid, uid)), { slotId, lastSeenAt: ts });
  saveQueue(tx, db, eid, slotId, l, queue, now, slot);
}

/** 学生: スタッフコードで決まった枠を占有する（1枠1台）。ほかの枠は取れない */
export async function claimSlot(deps: Deps, caller: Caller | null, req: ClaimSlotRequest): Promise<void> {
  const me = requireStaff(caller);
  if (me.role !== 'student') fail('permission-denied', 'forbidden');
  const slotId = req?.slotId;
  if (typeof slotId !== 'string' || !SLOT_ID.test(slotId) || slotId === FACULTY_SLOT_ID) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  const staffRef = db.doc(paths.staff(me.eid, me.uid));

  await runTx(db, async (tx) => {
    const staff = await getOrFail<StaffDoc>(tx, staffRef);
    if (staff.allowedSlotId !== slotId) fail('permission-denied', 'forbidden');
    const l = await loadSlot(tx, db, me.eid, slotId);
    requireStaffEvent(l.event);
    if (l.slot.kind !== 'student') fail('invalid-argument', 'invalidInput');
    if (staff.slotId === slotId && l.slot.occupant?.uid === me.uid) return; // 同じ枠を取り直しただけ
    if (staff.slotId) fail('failed-precondition', 'alreadyAssigned');
    if (l.slot.occupant) fail('failed-precondition', 'slotTaken');
    occupy(tx, db, me.eid, slotId, l, me.uid, now);
  });
}

/** 教員: ブース番号を設定する。教員相談の列を受け持つブースが1つ増える */
export async function setBooth(deps: Deps, caller: Caller | null, req: SetBoothRequest): Promise<void> {
  const me = requireStaff(caller);
  if (me.role !== 'faculty') fail('permission-denied', 'forbidden');
  const booth = typeof req?.booth === 'string' ? req.booth.trim() : '';
  if (!BOOTH.test(booth)) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  const staffRef = db.doc(paths.staff(me.eid, me.uid));

  await runTx(db, async (tx) => {
    const staff = await getOrFail<StaffDoc>(tx, staffRef);
    const l = await loadSlot(tx, db, me.eid, FACULTY_SLOT_ID);
    requireStaffEvent(l.event);
    if (l.queue.booths.some((b) => b.booth === booth && b.staffUid !== me.uid)) fail('failed-precondition', 'boothTaken');
    if (l.queue.serving.some((s) => s.staffUid === me.uid)) fail('failed-precondition', 'busy');
    if (staff.booth === booth) return;

    const ts = Timestamp.fromDate(now);
    const queue: QueueDoc = {
      ...l.queue,
      booths: [...l.queue.booths.filter((b) => b.staffUid !== me.uid), { staffUid: me.uid, booth }],
      updatedAt: ts,
    };
    tx.update(staffRef, { booth, lastSeenAt: ts });
    saveQueue(tx, db, me.eid, FACULTY_SLOT_ID, l, queue, now);
  });
}

/** S-09 担当を外れる。対応中がないときのみ。列は残る */
export async function releaseAssignment(deps: Deps, caller: Caller | null): Promise<void> {
  const me = requireStaff(caller);
  const { db } = deps;
  const now = deps.now();
  const staffRef = db.doc(paths.staff(me.eid, me.uid));

  await runTx(db, async (tx) => {
    const staff = await getOrFail<StaffDoc>(tx, staffRef);
    const slotId = me.role === 'faculty' ? FACULTY_SLOT_ID : staff.slotId;
    if (!slotId || (me.role === 'faculty' && !staff.booth)) return; // 担当なし
    const l = await loadSlot(tx, db, me.eid, slotId);
    if (l.queue.serving.some((s) => s.staffUid === me.uid)) fail('failed-precondition', 'busy');

    const ts = Timestamp.fromDate(now);
    const queue: QueueDoc = { ...l.queue, booths: l.queue.booths.filter((b) => b.staffUid !== me.uid), updatedAt: ts };
    let slot = l.slot;
    if (me.role === 'student') {
      tx.update(staffRef, { slotId: null, lastSeenAt: ts });
      if (l.slot.occupant?.uid === me.uid) {
        slot = { ...l.slot, occupant: null, updatedAt: ts };
        tx.update(db.doc(paths.slot(me.eid, slotId)), { occupant: null, updatedAt: ts });
      }
    } else {
      tx.update(staffRef, { booth: null, lastSeenAt: ts });
    }
    saveQueue(tx, db, me.eid, slotId, l, queue, now, slot);
  });
}

/** 生存確認。画面を開いている間、定期的に呼ぶ */
export async function heartbeat(deps: Deps, caller: Caller | null): Promise<void> {
  const me = requireStaff(caller);
  const ref = deps.db.doc(paths.staff(me.eid, me.uid));
  await ref.update({ lastSeenAt: Timestamp.fromDate(deps.now()) }).catch(() => fail('not-found', 'notFound'));
}

// ---------------------------------------------------------------------------
// 担当している列
// ---------------------------------------------------------------------------

interface Assignment extends Loaded {
  slotId: string;
  /** 案内先のブース。学生は枠の位置、教員は設定したブース番号 */
  booth: string | null;
  staffRef: DocumentReference;
}

/**
 * 自分が担当している列を読む。
 * 学生は占有中の枠（強制解除されていれば notAssigned）、教員は教員相談の列。
 * requireBooth が true なら、教員はブース番号の設定も必須（呼出のため）。
 */
async function loadAssignment(tx: Transaction, db: Firestore, me: StaffCaller, requireBooth: boolean): Promise<Assignment> {
  const staffRef = db.doc(paths.staff(me.eid, me.uid));
  const staff = await getOrFail<StaffDoc>(tx, staffRef);
  if (me.role === 'student') {
    if (!staff.slotId) fail('failed-precondition', 'notAssigned');
    const l = await loadSlot(tx, db, me.eid, staff.slotId);
    if (l.slot.occupant?.uid !== me.uid) fail('failed-precondition', 'notAssigned');
    requireStaffEvent(l.event);
    return { ...l, slotId: staff.slotId, booth: l.slot.location, staffRef };
  }
  if (requireBooth && !staff.booth) fail('failed-precondition', 'notAssigned');
  const l = await loadSlot(tx, db, me.eid, FACULTY_SLOT_ID);
  requireStaffEvent(l.event);
  return { ...l, slotId: FACULTY_SLOT_ID, booth: staff.booth, staffRef };
}

// ---------------------------------------------------------------------------
// S-04 呼出・開始・完了、S-05 不在スキップと復帰
// ---------------------------------------------------------------------------

/** 列の先頭を呼ぶ。1人のスタッフが同時に対応できるのは1組まで */
export async function callNext(deps: Deps, caller: Caller | null): Promise<CallNextResponse> {
  const me = requireStaff(caller);
  const { db } = deps;
  const now = deps.now();

  return runTx(db, async (tx) => {
    const a = await loadAssignment(tx, db, me, true);
    if (a.event.state !== 'open') fail('failed-precondition', 'eventNotOpen');
    if (a.queue.serving.some((s) => s.staffUid === me.uid)) fail('failed-precondition', 'busy');
    const head = a.queue.waiting[0];
    if (!head) fail('failed-precondition', 'queueEmpty');

    const ticketRef = db.doc(paths.ticket(me.eid, head.ticketId));
    const ticket = await getOrFail<TicketDoc>(tx, ticketRef);
    assertTransition(ticket.state, 'calling');

    const ts = Timestamp.fromDate(now);
    const entry: ServingEntry = { ...head, state: 'calling', booth: a.booth, staffUid: me.uid, since: ts };
    const queue: QueueDoc = { ...a.queue, waiting: a.queue.waiting.slice(1), serving: [...a.queue.serving, entry], updatedAt: ts };
    tx.update(ticketRef, { state: 'calling', booth: a.booth, staffUid: me.uid, calledAt: ts });
    tx.update(a.staffRef, { lastSeenAt: ts });
    saveQueue(tx, db, me.eid, a.slotId, a, queue, now);
    return { ticketId: head.ticketId, number: head.number };
  });
}

/** 自分が対応中の整理券を読む */
async function loadServing(tx: Transaction, db: Firestore, me: StaffCaller, ticketId: string) {
  const a = await loadAssignment(tx, db, me, false);
  const entry = a.queue.serving.find((s) => s.ticketId === ticketId);
  // staffUid が null なのは、管理者が前の担当を強制解除した整理券。その列の担当なら引き継げる
  if (!entry || (entry.staffUid !== me.uid && entry.staffUid !== null)) fail('failed-precondition', 'invalidState');
  const ticketRef = db.doc(paths.ticket(me.eid, ticketId));
  const ticket = await getOrFail<TicketDoc>(tx, ticketRef);
  return { a, entry, ticketRef, ticket };
}

export async function startConsult(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireStaff(caller);
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const { a, ticketRef, ticket } = await loadServing(tx, db, me, ticketId);
    assertTransition(ticket.state, 'in_progress');
    const ts = Timestamp.fromDate(now);
    const queue: QueueDoc = {
      ...a.queue,
      serving: a.queue.serving.map((s) =>
        s.ticketId === ticketId ? { ...s, state: 'in_progress' as const, staffUid: me.uid, since: ts } : s,
      ),
      updatedAt: ts,
    };
    tx.update(ticketRef, { state: 'in_progress', startedAt: ts, staffUid: me.uid });
    saveQueue(tx, db, me.eid, a.slotId, a, queue, now);
  });
}

/** 完了。問診メモをすぐ消し、相談時間を目安時間の材料にする */
export async function completeConsult(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireStaff(caller);
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const { a, ticketRef, ticket } = await loadServing(tx, db, me, ticketId);
    assertTransition(ticket.state, 'completed');
    const visitorRef = db.doc(paths.visitor(me.eid, ticket.visitorUid));
    const visitorSnap = await tx.get(visitorRef);

    const ts = Timestamp.fromDate(now);
    const seconds = ticket.startedAt ? Math.max(0, Math.round((now.getTime() - ticket.startedAt.toMillis()) / 1000)) : null;
    const queue: QueueDoc = {
      ...a.queue,
      serving: a.queue.serving.filter((s) => s.ticketId !== ticketId),
      recentDurations: seconds === null ? a.queue.recentDurations : [seconds, ...a.queue.recentDurations].slice(0, DEFAULTS.recentDurationsSize),
      updatedAt: ts,
    };
    tx.update(ticketRef, { state: 'completed', completedAt: ts, memo: null, staffUid: me.uid });
    if (visitorSnap.exists && (visitorSnap.data() as VisitorDoc).activeTicketId === ticketId) {
      tx.update(visitorRef, { activeTicketId: null });
    }
    saveQueue(tx, db, me.eid, a.slotId, a, queue, now);
  });
}

/** 不在スキップ。skipReturnMinutes 以内なら復帰できる */
export async function skipTicket(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireStaff(caller);
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const { a, entry, ticketRef, ticket } = await loadServing(tx, db, me, ticketId);
    assertTransition(ticket.state, 'skipped');
    const ts = Timestamp.fromDate(now);
    const deadline = Timestamp.fromMillis(now.getTime() + a.event.skipReturnMinutes * 60_000);
    const queue: QueueDoc = {
      ...a.queue,
      serving: a.queue.serving.filter((s) => s.ticketId !== ticketId),
      skipped: [...a.queue.skipped, { ticketId, number: entry.number, skippedAt: ts, returnDeadline: deadline }],
      updatedAt: ts,
    };
    // booth は残す（来場者が復帰のために向かう先。V-07）
    tx.update(ticketRef, { state: 'skipped', skippedAt: ts, returnDeadline: deadline, staffUid: null });
    saveQueue(tx, db, me.eid, a.slotId, a, queue, now);
  });
}

/** 復帰。期限内なら列の先頭へ戻す（上限を超えてもよい） */
export async function returnTicket(deps: Deps, caller: Caller | null, req: TicketRequest): Promise<void> {
  const me = requireStaff(caller);
  const ticketId = ticketIdOf(req);
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const a = await loadAssignment(tx, db, me, false);
    const entry = a.queue.skipped.find((s) => s.ticketId === ticketId);
    if (!entry) fail('failed-precondition', 'invalidState');
    const ticketRef = db.doc(paths.ticket(me.eid, ticketId));
    const ticket = await getOrFail<TicketDoc>(tx, ticketRef);
    assertTransition(ticket.state, 'waiting');
    if (now.getTime() > entry.returnDeadline.toMillis()) fail('failed-precondition', 'returnExpired');

    const ts = Timestamp.fromDate(now);
    const queue: QueueDoc = {
      ...a.queue,
      skipped: a.queue.skipped.filter((s) => s.ticketId !== ticketId),
      waiting: [{ ticketId, number: entry.number }, ...a.queue.waiting],
      updatedAt: ts,
    };
    tx.update(ticketRef, { state: 'waiting', returnDeadline: null });
    saveQueue(tx, db, me.eid, a.slotId, a, queue, now);
  });
}

// ---------------------------------------------------------------------------
// S-07 受付停止、S-08 列の上限
// ---------------------------------------------------------------------------

export async function setSlotPaused(deps: Deps, caller: Caller | null, req: SetSlotPausedRequest): Promise<void> {
  const me = requireStaff(caller);
  if (typeof req?.paused !== 'boolean') fail('invalid-argument', 'invalidInput');
  const paused = req.paused;
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const a = await loadAssignment(tx, db, me, false);
    if (a.slot.paused === paused) return;
    const ts = Timestamp.fromDate(now);
    const slot: SlotDoc = { ...a.slot, paused, updatedAt: ts };
    tx.update(db.doc(paths.slot(me.eid, a.slotId)), { paused, updatedAt: ts });
    writeBoardSlot(tx, db, me.eid, a.slotId, a.event, slot, a.queue, now);
  });
}

export function validQueueLimit(kind: SlotDoc['kind'], value: unknown): value is number {
  const r = kind === 'faculty' ? DEFAULTS.facultyQueueLimit : DEFAULTS.studentQueueLimit;
  return typeof value === 'number' && Number.isInteger(value) && value >= r.min && value <= r.max && (value - r.min) % r.step === 0;
}

/** 列の上限を変える。変更履歴を auditLog に残す */
export async function setQueueLimit(deps: Deps, caller: Caller | null, req: SetQueueLimitRequest): Promise<void> {
  const me = requireStaff(caller);
  const { db } = deps;
  const now = deps.now();

  await runTx(db, async (tx) => {
    const a = await loadAssignment(tx, db, me, false);
    const queueLimit = req?.queueLimit;
    if (!validQueueLimit(a.slot.kind, queueLimit)) fail('invalid-argument', 'invalidInput');
    if (a.slot.queueLimit === queueLimit) return;

    const ts = Timestamp.fromDate(now);
    const slot: SlotDoc = { ...a.slot, queueLimit, updatedAt: ts };
    const log: AuditLogDoc = {
      at: ts,
      action: 'queueLimit.change',
      actor: { uid: me.uid, role: me.role },
      target: a.slotId,
      detail: { from: a.slot.queueLimit, to: queueLimit },
      expireAt: expireAtFor(a.event),
    };
    tx.update(db.doc(paths.slot(me.eid, a.slotId)), { queueLimit, updatedAt: ts });
    tx.create(db.collection(paths.auditLog(me.eid)).doc(), log);
    writeBoardSlot(tx, db, me.eid, a.slotId, a.event, slot, a.queue, now);
  });
}
