// 管理者の関数（A-01〜A-07）。callable は `admin` の1つで、op で振り分ける。
// 呼べるのは運営アカウントのログイン（カスタムトークン）だけで、op ごとに必要な権限はロールで決まる（authorizeOperator・shared の roles.ts）。
import { FieldPath, FieldValue, Timestamp, type Firestore, type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  paths,
  storagePaths,
  type AdminRequest,
  type AuditAction,
  type AuditLogDoc,
  type CreateEventResponse,
  type DashboardResponse,
  type EventDoc,
  type EventSettings,
  type FacultyProfile,
  type FacultySlotDoc,
  type ImportSlotsResponse,
  type PreviewStatsResponse,
  type QueueDoc,
  type SecretCodesDoc,
  type SlotDoc,
  type SlotRowError,
  type StaffDoc,
  type StudentSlotDoc,
  type StudentSlotInput,
  type TicketDoc,
  type ViewCodesResponse,
} from '@nt/shared';
import { rebuildBoard, writeBoardSlot, type BoardOverrides } from './board.js';
import { generateCode } from './codes.js';
import { SLOT_ID, expireAtFor, getOrFail, runTx } from './common.js';
import type { Caller, Deps } from './context.js';
import { fail } from './errors.js';
import { closeEvent, openEvent } from './lifecycle.js';
import * as operators from './operators.js';
import { containsContact, csvToSlots, normalizeFacultyProfile, normalizeStudentSlot } from './slotInput.js';
import { validQueueLimit } from './staff.js';
import { buildStats } from './stats.js';

const EID = /^[A-Za-z0-9_-]{1,64}$/;

type Writer = Transaction | WriteBatch;

function audit(
  w: Writer,
  db: Firestore,
  eid: string,
  event: EventDoc,
  me: Caller,
  action: AuditAction,
  target: string | null,
  detail: AuditLogDoc['detail'],
  now: Date,
): void {
  const doc: AuditLogDoc = {
    at: Timestamp.fromDate(now),
    action,
    actor: { uid: me.uid, role: 'admin' },
    target,
    detail,
    expireAt: expireAtFor(event),
  };
  (w as Transaction).create(db.collection(paths.auditLog(eid)).doc(), doc);
}

function eidOf(req: { eid?: unknown }): string {
  if (typeof req.eid !== 'string' || !EID.test(req.eid)) fail('invalid-argument', 'invalidInput');
  return req.eid;
}

// ---------------------------------------------------------------------------
// A-02 イベント設定
// ---------------------------------------------------------------------------

function parseTime(value: unknown): Timestamp {
  if (typeof value !== 'string') fail('invalid-argument', 'invalidInput');
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail('invalid-argument', 'invalidInput');
  return Timestamp.fromMillis(ms);
}

function intIn(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail('invalid-argument', 'invalidInput');
  return value;
}

export function validateSettings(s: EventSettings) {
  const title = typeof s.title === 'string' ? s.title.trim() : '';
  if (title === '' || [...title].length > 60) fail('invalid-argument', 'invalidInput');
  const opensAt = parseTime(s.opensAt);
  const closesAt = parseTime(s.closesAt);
  if (closesAt.toMillis() <= opensAt.toMillis()) fail('invalid-argument', 'invalidInput');
  const consultMinutes = intIn(s.consultMinutes, 1, 60);
  const skipReturnMinutes = intIn(s.skipReturnMinutes, 1, 60);
  if (!Array.isArray(s.themes) || s.themes.length === 0 || s.themes.length > 20) fail('invalid-argument', 'invalidInput');
  const themes = s.themes.map((t) => (typeof t === 'string' ? t.trim() : ''));
  if (themes.some((t) => t === '' || [...t].length > 20) || new Set(themes).size !== themes.length) fail('invalid-argument', 'invalidInput');
  if (containsContact(title) || themes.some(containsContact)) fail('invalid-argument', 'containsContact');
  return { title, opensAt, closesAt, consultMinutes, skipReturnMinutes, themes };
}

const DEFAULT_FACULTY_PROFILE: FacultyProfile = {
  title: '教員による個別相談',
  fields: ['カリキュラム', '入試', '卒業後の進路'],
  description: '',
};

async function createEvent(deps: Deps, me: Caller, settings: EventSettings): Promise<CreateEventResponse> {
  const { db } = deps;
  const now = deps.now();
  const v = validateSettings(settings ?? ({} as EventSettings));
  const ts = Timestamp.fromDate(now);
  const ref = db.collection('events').doc();
  const event: EventDoc = { ...v, state: 'scheduled', nextTicketNumber: DEFAULTS.firstTicketNumber, paused: false, updatedAt: ts };
  const entryCode = generateCode(7);
  const codes: SecretCodesDoc = { entryCode, facultyCode: generateCode(8, [entryCode]), slotCodes: {}, updatedAt: ts };
  const faculty: FacultySlotDoc = {
    kind: 'faculty',
    order: 1000,
    paused: false,
    queueLimit: DEFAULTS.facultyQueueLimit.default,
    updatedAt: ts,
    profile: DEFAULT_FACULTY_PROFILE,
    location: null,
    occupant: null,
  };

  await runTx(db, async (tx) => {
    tx.create(ref, event);
    tx.create(db.doc(paths.secretCodes(ref.id)), codes);
    tx.create(db.doc(paths.slot(ref.id, FACULTY_SLOT_ID)), faculty);
    tx.create(db.doc(paths.queue(ref.id, FACULTY_SLOT_ID)), emptyQueue('faculty', ts));
    writeBoardSlot(tx, db, ref.id, FACULTY_SLOT_ID, event, faculty, emptyQueue('faculty', ts), now);
    audit(tx, db, ref.id, event, me, 'event.create', ref.id, { title: v.title }, now);
  });
  return { eid: ref.id };
}

function emptyQueue(kind: SlotDoc['kind'], ts: Timestamp): QueueDoc {
  return { kind, booths: [], waiting: [], skipped: [], serving: [], recentDurations: [], updatedAt: ts };
}

async function updateEvent(deps: Deps, me: Caller, eid: string, patch: Partial<EventSettings>): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const ref = db.doc(paths.event(eid));
  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, ref);
    if (event.state === 'closed' || event.state === 'purged') fail('failed-precondition', 'invalidState');
    const current: EventSettings = {
      title: event.title,
      opensAt: new Date(event.opensAt.toMillis()).toISOString(),
      closesAt: new Date(event.closesAt.toMillis()).toISOString(),
      consultMinutes: event.consultMinutes,
      skipReturnMinutes: event.skipReturnMinutes,
      themes: event.themes,
    };
    const v = validateSettings({ ...current, ...(patch ?? {}) });
    // 開場中に開場時刻を未来へ変えたら開場前に戻す（入力違いで開場してしまったときの戻し方）。
    // 入場した方・整理券があるときは、締め出すことになるので断る
    let state = event.state;
    if (state === 'open' && v.opensAt.toMillis() > now.getTime()) {
      const [visitors, tickets] = await Promise.all([
        tx.get(db.collection(`events/${eid}/visitors`).limit(1)),
        tx.get(db.collection(paths.tickets(eid)).limit(1)),
      ]);
      if (!visitors.empty || !tickets.empty) fail('failed-precondition', 'eventStarted');
      state = 'scheduled';
    }
    const next: EventDoc = { ...event, ...v, state, updatedAt: Timestamp.fromDate(now) };
    await rebuildBoard(tx, db, eid, next, now);
    tx.update(ref, { ...v, state, updatedAt: next.updatedAt });
    const detail: Record<string, string> = { fields: Object.keys(patch ?? {}).sort().join(',') };
    if (state !== event.state) detail.state = state;
    audit(tx, db, eid, event, me, 'event.update', eid, detail, now);
  });
}

// ---------------------------------------------------------------------------
// A-03 コード
// ---------------------------------------------------------------------------

/** いま使われているすべてのコード（新しいコードの先頭4桁を重ねないため） */
export function allCodes(codes: SecretCodesDoc): string[] {
  return [codes.entryCode, codes.facultyCode, ...Object.values(codes.slotCodes ?? {})];
}

async function codesResponse(tx: Transaction, db: Firestore, eid: string, codes: SecretCodesDoc): Promise<ViewCodesResponse> {
  const slots = await tx.get(db.collection(paths.slots(eid)).orderBy('order'));
  const slotCodes = slots.docs
    .map((d) => ({ id: d.id, slot: d.data() as SlotDoc }))
    .filter((x): x is { id: string; slot: StudentSlotDoc } => x.slot.kind === 'student')
    .map(({ id, slot }) => ({
      slotId: id,
      label: [slot.location, slot.profile.nickname].filter(Boolean).join(' '),
      code: codes.slotCodes?.[id] ?? '',
    }));
  return { entryCode: codes.entryCode, facultyCode: codes.facultyCode, slotCodes };
}

async function viewCodes(deps: Deps, me: Caller, eid: string): Promise<ViewCodesResponse> {
  const { db } = deps;
  const now = deps.now();
  return runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    const codes = await getOrFail<SecretCodesDoc>(tx, db.doc(paths.secretCodes(eid)));
    const res = await codesResponse(tx, db, eid, codes);
    audit(tx, db, eid, event, me, 'code.view', null, {}, now);
    return res;
  });
}

/** 再発行。入場済みの来場者・ログイン済みのスタッフはそのまま使える（クレームは付いたまま） */
async function reissueCode(deps: Deps, me: Caller, eid: string, kind: 'entry' | 'faculty' | 'slot', slotId: unknown): Promise<ViewCodesResponse> {
  if (kind !== 'entry' && kind !== 'faculty' && kind !== 'slot') fail('invalid-argument', 'invalidInput');
  if (kind === 'slot' && (typeof slotId !== 'string' || !SLOT_ID.test(slotId))) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  return runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    const ref = db.doc(paths.secretCodes(eid));
    const codes = await getOrFail<SecretCodesDoc>(tx, ref);
    const avoid = allCodes(codes);
    const next: SecretCodesDoc = { ...codes, slotCodes: { ...(codes.slotCodes ?? {}) }, updatedAt: Timestamp.fromDate(now) };
    if (kind === 'entry') next.entryCode = generateCode(7, avoid);
    else if (kind === 'faculty') next.facultyCode = generateCode(8, avoid);
    else {
      const slot = await getOrFail<SlotDoc>(tx, db.doc(paths.slot(eid, slotId as string)));
      if (slot.kind !== 'student') fail('invalid-argument', 'invalidInput');
      next.slotCodes[slotId as string] = generateCode(8, avoid);
    }
    const res = await codesResponse(tx, db, eid, next);
    tx.set(ref, next);
    audit(tx, db, eid, event, me, 'code.reissue', kind === 'slot' ? (slotId as string) : null, { kind }, now);
    return res;
  });
}

// ---------------------------------------------------------------------------
// A-04 枠の登録
// ---------------------------------------------------------------------------

function failRows(rows: SlotRowError[]): never {
  const contact = rows.some((r) => r.message.includes('URL'));
  fail('invalid-argument', contact ? 'containsContact' : 'invalidInput', { rows });
}

/** 学生枠をまとめて登録・更新する。1件でも誤りがあれば何も書かない */
async function saveStudentSlots(deps: Deps, me: Caller, eid: string, inputs: StudentSlotInput[], action: AuditAction): Promise<string[]> {
  const { db } = deps;
  const now = deps.now();
  const ts = Timestamp.fromDate(now);
  return runTx(db, async (tx) => {
    // ---- 読み取り ----
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    if (event.state === 'closed' || event.state === 'purged') fail('failed-precondition', 'invalidState');
    const codesRef = db.doc(paths.secretCodes(eid));
    const codes = await getOrFail<SecretCodesDoc>(tx, codesRef);
    const existing = await Promise.all(
      inputs.map(async (s) => {
        if (!s.id) return null;
        const [slot, queue] = await Promise.all([tx.get(db.doc(paths.slot(eid, s.id))), tx.get(db.doc(paths.queue(eid, s.id)))]);
        return slot.exists && queue.exists ? { slot: slot.data() as SlotDoc, queue: queue.data() as QueueDoc } : null;
      }),
    );
    const rows: SlotRowError[] = [];
    existing.forEach((e, i) => {
      if (e && e.slot.kind !== 'student') rows.push({ row: i + 1, field: 'id', message: '学生枠ではありません' });
    });
    if (rows.length > 0) failRows(rows);

    // ---- 書く内容を決める ----
    const overrides: BoardOverrides = new Map();
    const writes: { id: string; slot: StudentSlotDoc; queue: QueueDoc; created: boolean }[] = [];
    inputs.forEach((s, i) => {
      const id = s.id ?? db.collection(paths.slots(eid)).doc().id;
      const old = existing[i];
      const profileBase = { nickname: s.nickname, department: s.department, bio: s.bio, tags: s.tags };
      if (old) {
        const prev = old.slot as StudentSlotDoc;
        const slot: StudentSlotDoc = { ...prev, profile: { ...profileBase, avatarPath: prev.profile.avatarPath }, location: s.location, order: s.order, updatedAt: ts };
        // 占有中なら、案内先のブース（queues.booths）も新しい位置にそろえる
        const queue: QueueDoc = { ...old.queue, booths: old.queue.booths.map((b) => ({ ...b, booth: s.location })) };
        writes.push({ id, slot, queue, created: false });
      } else {
        const slot: StudentSlotDoc = {
          kind: 'student',
          order: s.order,
          paused: false,
          queueLimit: DEFAULTS.studentQueueLimit.default,
          updatedAt: ts,
          profile: { ...profileBase, avatarPath: null },
          location: s.location,
          occupant: null,
        };
        writes.push({ id, slot, queue: emptyQueue('student', ts), created: true });
      }
    });
    for (const w of writes) overrides.set(w.id, { slot: w.slot, queue: w.queue });
    await rebuildBoard(tx, db, eid, event, now, overrides);

    // 新しい枠には、その枠専用のスタッフコードを作る
    const slotCodes = { ...(codes.slotCodes ?? {}) };
    for (const w of writes) {
      if (!slotCodes[w.id]) slotCodes[w.id] = generateCode(8, allCodes({ ...codes, slotCodes }));
    }

    // ---- 書き込み ----
    for (const w of writes) {
      tx.set(db.doc(paths.slot(eid, w.id)), w.slot);
      if (w.created) tx.create(db.doc(paths.queue(eid, w.id)), w.queue);
      else tx.update(db.doc(paths.queue(eid, w.id)), { booths: w.queue.booths });
    }
    tx.update(codesRef, { slotCodes, updatedAt: ts });
    audit(tx, db, eid, event, me, action, inputs.length === 1 ? writes[0]!.id : null, { count: inputs.length }, now);
    return writes.map((w) => w.id);
  });
}

async function importSlots(deps: Deps, me: Caller, eid: string, csv: unknown): Promise<ImportSlotsResponse> {
  if (typeof csv !== 'string' || csv.length > 200_000) fail('invalid-argument', 'invalidInput');
  const { slots, errors } = csvToSlots(csv);
  if (errors.length > 0) failRows(errors);
  return { slotIds: await saveStudentSlots(deps, me, eid, slots, 'slot.import') };
}

async function upsertSlot(deps: Deps, me: Caller, eid: string, input: StudentSlotInput): Promise<ImportSlotsResponse> {
  const errors: SlotRowError[] = [];
  const slot = normalizeStudentSlot(input ?? ({} as StudentSlotInput), 1, errors);
  if (errors.length > 0) failRows(errors);
  return { slotIds: await saveStudentSlots(deps, me, eid, [slot], 'slot.update') };
}

async function updateFacultyProfile(deps: Deps, me: Caller, eid: string, input: FacultyProfile): Promise<void> {
  const errors: SlotRowError[] = [];
  const profile = normalizeFacultyProfile(input, errors);
  if (errors.length > 0) failRows(errors);
  const { db } = deps;
  const now = deps.now();
  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    await getOrFail<SlotDoc>(tx, db.doc(paths.slot(eid, FACULTY_SLOT_ID)));
    tx.update(db.doc(paths.slot(eid, FACULTY_SLOT_ID)), { profile, updatedAt: Timestamp.fromDate(now) });
    audit(tx, db, eid, event, me, 'slot.update', FACULTY_SLOT_ID, {}, now);
  });
}

function slotIdOf(value: unknown): string {
  if (typeof value !== 'string' || !SLOT_ID.test(value)) fail('invalid-argument', 'invalidInput');
  return value;
}

async function deleteSlot(deps: Deps, me: Caller, eid: string, slotId: string): Promise<void> {
  if (slotId === FACULTY_SLOT_ID) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  let avatarPath: string | null = null;
  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    const slot = await getOrFail<StudentSlotDoc>(tx, db.doc(paths.slot(eid, slotId)));
    const queue = await getOrFail<QueueDoc>(tx, db.doc(paths.queue(eid, slotId)));
    if (slot.occupant || queue.booths.length + queue.waiting.length + queue.serving.length + queue.skipped.length > 0) {
      fail('failed-precondition', 'slotInUse');
    }
    const codesRef = db.doc(paths.secretCodes(eid));
    await getOrFail<SecretCodesDoc>(tx, codesRef);
    avatarPath = slot.profile.avatarPath;
    await rebuildBoard(tx, db, eid, event, now, new Map([[slotId, null]]));
    tx.update(codesRef, new FieldPath('slotCodes', slotId), FieldValue.delete(), 'updatedAt', Timestamp.fromDate(now));
    tx.delete(db.doc(paths.slot(eid, slotId)));
    tx.delete(db.doc(paths.queue(eid, slotId)));
    audit(tx, db, eid, event, me, 'slot.delete', slotId, {}, now);
  });
  if (avatarPath) await deps.bucket().file(avatarPath).delete({ ignoreNotFound: true });
}

const AVATAR_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
export const AVATAR_MAX_BYTES = 512 * 1024;

/** プロフィール画像。画面で縮小してから送る前提で 512KB まで。中身の形式も確かめる */
async function uploadAvatar(deps: Deps, me: Caller, eid: string, slotId: string, contentType: unknown, dataBase64: unknown): Promise<void> {
  const check = typeof contentType === 'string' ? AVATAR_TYPES[contentType] : undefined;
  if (!check || typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4) fail('invalid-argument', 'invalidInput');
  const data = Buffer.from(dataBase64, 'base64');
  if (data.length === 0 || data.length > AVATAR_MAX_BYTES || !check(data)) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  const path = storagePaths.avatar(eid, slotId);

  const slot = (await db.doc(paths.slot(eid, slotId)).get()).data() as SlotDoc | undefined;
  if (!slot) fail('not-found', 'notFound');
  if (slot.kind !== 'student') fail('invalid-argument', 'invalidInput');
  await deps.bucket().file(path).save(data, { contentType: contentType as string, resumable: false, metadata: { cacheControl: 'private, max-age=300' } });

  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    await getOrFail<StudentSlotDoc>(tx, db.doc(paths.slot(eid, slotId)));
    tx.update(db.doc(paths.slot(eid, slotId)), { 'profile.avatarPath': path, updatedAt: Timestamp.fromDate(now) });
    audit(tx, db, eid, event, me, 'slot.update', slotId, { avatar: true }, now);
  });
}

// ---------------------------------------------------------------------------
// A-05 当日の操作
// ---------------------------------------------------------------------------

async function withAudit(deps: Deps, me: Caller, eid: string, action: AuditAction, detail: AuditLogDoc['detail'] = {}): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const event = (await db.doc(paths.event(eid)).get()).data() as EventDoc | undefined;
  if (!event) return;
  const batch = db.batch();
  audit(batch, db, eid, event, me, action, eid, detail, now);
  await batch.commit();
}

/** 会場全体の受付の一時停止（列ごとの停止設定は再開後も残る） */
async function setGlobalPaused(deps: Deps, me: Caller, eid: string, paused: unknown): Promise<void> {
  if (typeof paused !== 'boolean') fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  await runTx(db, async (tx) => {
    const ref = db.doc(paths.event(eid));
    const event = await getOrFail<EventDoc>(tx, ref);
    if (event.paused === paused) return;
    const next: EventDoc = { ...event, paused, updatedAt: Timestamp.fromDate(now) };
    await rebuildBoard(tx, db, eid, next, now);
    tx.update(ref, { paused, updatedAt: next.updatedAt });
    audit(tx, db, eid, event, me, paused ? 'event.pause' : 'event.resume', eid, {}, now);
  });
}

/** 列ごとの受付停止と上限変更（管理者はどの列でも） */
async function updateSlotSettings(deps: Deps, me: Caller, eid: string, slotId: string, paused: unknown, queueLimit: unknown): Promise<void> {
  if (paused !== undefined && typeof paused !== 'boolean') fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    const slot = await getOrFail<SlotDoc>(tx, db.doc(paths.slot(eid, slotId)));
    const queue = await getOrFail<QueueDoc>(tx, db.doc(paths.queue(eid, slotId)));
    if (queueLimit !== undefined && !validQueueLimit(slot.kind, queueLimit)) fail('invalid-argument', 'invalidInput');
    const ts = Timestamp.fromDate(now);
    const next: SlotDoc = {
      ...slot,
      ...(paused !== undefined ? { paused } : {}),
      ...(queueLimit !== undefined ? { queueLimit: queueLimit as number } : {}),
      updatedAt: ts,
    };
    tx.update(db.doc(paths.slot(eid, slotId)), { paused: next.paused, queueLimit: next.queueLimit, updatedAt: ts });
    writeBoardSlot(tx, db, eid, slotId, event, next, queue, now);
    if (next.queueLimit !== slot.queueLimit) {
      audit(tx, db, eid, event, me, 'queueLimit.change', slotId, { from: slot.queueLimit, to: next.queueLimit }, now);
    }
    if (next.paused !== slot.paused) audit(tx, db, eid, event, me, 'slot.update', slotId, { paused: next.paused }, now);
  });
}

/**
 * 占有の強制解除（端末の故障・電池切れなど）。
 * 対応中の整理券は列に残し、staffUid を null にする。次にその列を担当したスタッフが引き継げる。
 */
async function forceRelease(deps: Deps, me: Caller, eid: string, slotId: string, staffUid: unknown): Promise<void> {
  if (typeof staffUid !== 'string' || staffUid === '' || staffUid.length > 128) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, db.doc(paths.event(eid)));
    const slot = await getOrFail<SlotDoc>(tx, db.doc(paths.slot(eid, slotId)));
    const queue = await getOrFail<QueueDoc>(tx, db.doc(paths.queue(eid, slotId)));
    const staffRef = db.doc(paths.staff(eid, staffUid));
    const staffSnap = await tx.get(staffRef);
    const ts = Timestamp.fromDate(now);

    const holds = slot.kind === 'student' ? slot.occupant?.uid === staffUid : queue.booths.some((b) => b.staffUid === staffUid);
    if (!holds) fail('failed-precondition', 'notAssigned');

    const orphaned = queue.serving.filter((s) => s.staffUid === staffUid);
    const nextQueue: QueueDoc = {
      ...queue,
      booths: queue.booths.filter((b) => b.staffUid !== staffUid),
      serving: queue.serving.map((s) => (s.staffUid === staffUid ? { ...s, staffUid: null } : s)),
      updatedAt: ts,
    };
    let nextSlot: SlotDoc = slot;
    if (slot.kind === 'student') {
      nextSlot = { ...slot, occupant: null, updatedAt: ts };
      tx.update(db.doc(paths.slot(eid, slotId)), { occupant: null, updatedAt: ts });
    }
    if (staffSnap.exists) {
      const staff = staffSnap.data() as StaffDoc;
      tx.update(staffRef, slot.kind === 'student' ? { slotId: staff.slotId === slotId ? null : staff.slotId } : { booth: null });
    }
    for (const s of orphaned) tx.update(db.doc(paths.ticket(eid, s.ticketId)), { staffUid: null });
    tx.set(db.doc(paths.queue(eid, slotId)), nextQueue);
    writeBoardSlot(tx, db, eid, slotId, event, nextSlot, nextQueue, now);
    audit(tx, db, eid, event, me, 'slot.forceRelease', slotId, { orphaned: orphaned.length }, now);
  });
}

// ---------------------------------------------------------------------------
// A-06 ダッシュボード・A-07 統計
// ---------------------------------------------------------------------------

/** 警告のしきい値（10分あたり）。1時間に約84組の処理なので、10分で30件の発券は明らかに多い */
export const WARN = { issuedLast10m: 30, staffFailuresLast10m: 10, entryFailuresLast10m: 30 } as const;

async function dashboard(deps: Deps, eid: string): Promise<DashboardResponse> {
  const { db } = deps;
  const now = deps.now();
  const since = Timestamp.fromMillis(now.getTime() - 10 * 60_000);
  const [issued, limits] = await Promise.all([
    db.collection(paths.tickets(eid)).where('createdAt', '>=', since).count().get(),
    db.collection(`events/${eid}/rateLimits`).get(),
  ]);
  let entry = 0;
  let staff = 0;
  for (const d of limits.docs) {
    const n = ((d.get('failures') as Timestamp[] | undefined) ?? []).filter((t) => t.toMillis() >= since.toMillis()).length;
    if (d.id.startsWith('entryDevice_')) entry += n; // IP 側と二重に数えないよう端末側だけ
    if (d.id.startsWith('staffDevice_')) staff += n;
  }
  const res: DashboardResponse = {
    issuedLast10m: issued.data().count,
    entryFailuresLast10m: entry,
    staffFailuresLast10m: staff,
    warnings: [],
  };
  if (res.issuedLast10m >= WARN.issuedLast10m) res.warnings.push('issueSpike');
  if (staff >= WARN.staffFailuresLast10m) res.warnings.push('staffCodeFailures');
  if (entry >= WARN.entryFailuresLast10m) res.warnings.push('entryCodeFailures');
  return res;
}

async function previewStats(deps: Deps, eid: string): Promise<PreviewStatsResponse> {
  const { db } = deps;
  const event = (await db.doc(paths.event(eid)).get()).data() as EventDoc | undefined;
  if (!event) fail('not-found', 'notFound');
  const tickets = await db.collection(paths.tickets(eid)).get();
  return buildStats(event, tickets.docs.map((d) => d.data() as TicketDoc));
}

// ---------------------------------------------------------------------------

export async function admin(deps: Deps, caller: Caller | null, req: AdminRequest): Promise<unknown> {
  if (!req || typeof req !== 'object' || typeof req.op !== 'string') fail('invalid-argument', 'invalidInput');
  const ctx = await operators.authorizeOperator(deps, caller, req.op);
  const me = caller as Caller;
  switch (req.op) {
    case 'me':
      return operators.me(ctx);
    case 'changePassword':
      return operators.changePassword(deps, ctx, req);
    case 'listOperators':
      return operators.listOperators(deps);
    case 'createOperator':
      return operators.createOperator(deps, ctx, req);
    case 'operatorAction':
      return operators.operatorAction(deps, ctx, req);
    case 'setOperatorRole':
      return operators.setOperatorRole(deps, ctx, req);
    case 'recordLogin':
      return withAudit(deps, me, eidOf(req), 'admin.login');
    case 'createEvent':
      return createEvent(deps, me, req.settings);
    case 'updateEvent':
      return updateEvent(deps, me, eidOf(req), req.settings);
    case 'viewCodes':
      return viewCodes(deps, me, eidOf(req));
    case 'reissueCode':
      return reissueCode(deps, me, eidOf(req), req.kind, req.slotId);
    case 'importSlots':
      return importSlots(deps, me, eidOf(req), req.csv);
    case 'upsertSlot':
      return upsertSlot(deps, me, eidOf(req), req.slot);
    case 'updateFacultyProfile':
      return updateFacultyProfile(deps, me, eidOf(req), req.profile);
    case 'deleteSlot':
      return deleteSlot(deps, me, eidOf(req), slotIdOf(req.slotId));
    case 'uploadAvatar':
      return uploadAvatar(deps, me, eidOf(req), slotIdOf(req.slotId), req.contentType, req.dataBase64);
    case 'openEvent': {
      const eid = eidOf(req);
      if (await openEvent(deps.db, eid, deps.now())) await withAudit(deps, me, eid, 'event.open');
      return;
    }
    case 'closeEvent': {
      const eid = eidOf(req);
      if (await closeEvent(deps.db, eid, deps.now())) await withAudit(deps, me, eid, 'event.close');
      return;
    }
    case 'setGlobalPaused':
      return setGlobalPaused(deps, me, eidOf(req), req.paused);
    case 'updateSlotSettings':
      return updateSlotSettings(deps, me, eidOf(req), slotIdOf(req.slotId), req.paused, req.queueLimit);
    case 'forceRelease':
      return forceRelease(deps, me, eidOf(req), slotIdOf(req.slotId), req.staffUid);
    case 'dashboard':
      return dashboard(deps, eidOf(req));
    case 'previewStats':
      return previewStats(deps, eidOf(req));
    default:
      fail('invalid-argument', 'invalidInput');
  }
}
