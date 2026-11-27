// P2 の関数テストの共通部分。関数の本体（functions/src/core）を Admin SDK で Emulator に対して直接呼ぶ。
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { expect } from 'vitest';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  paths,
  type ErrorReason,
  type EventDoc,
  type QueueDoc,
  type SlotDoc,
} from '@nt/shared';
import { computeBoardSlot } from '../../../functions/src/core/board.js';
import type { Caller, Deps } from '../../../functions/src/core/context.js';

export const PROJECT_ID = 'demo-numbered-ticket';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Firestore・Auth の Emulator の中で実行すること（npm run test:functions）');
}

export const BUCKET = `${PROJECT_ID}.appspot.com`;
const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
export const db = getFirestore(app);
export const auth = getAuth(app);

/** テストの「現在時刻」。開場中に入る */
export const NOW = new Date('2027-03-20T02:00:00Z'); // 11:00 JST

export function makeDeps(now: Date = NOW): Deps {
  return { db, auth, rateLimitSecret: () => 'test-secret', now: () => now, bucket: () => getStorage(app).bucket() };
}

export const ENTRY_CODE = '0384712';
/** 教員のスタッフコード（教員共通） */
export const FACULTY_CODE = '03847125';
/** 学生枠ごとのスタッフコード。seedEvent はここにある枠のコードを作る */
export const SLOT_CODES: Record<string, string> = { s1: '51829364', s2: '62930475', s3: '73041586' };
export const THEMES = ['入試', '授業', '学生生活', '就職', '留学', '資格'];

export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`clear failed: ${res.status}`);
}

export interface SeedOptions {
  eid?: string;
  state?: EventDoc['state'];
  paused?: boolean;
  /** 学生枠の ID と上限 */
  studentSlots?: { id: string; queueLimit?: number; occupied?: boolean; paused?: boolean }[];
  /** 教員相談のブース数（0 なら準備中） */
  facultyBooths?: number;
}

/** イベント・コード・枠・列・board を作る */
export async function seedEvent(opts: SeedOptions = {}): Promise<string> {
  const eid = opts.eid ?? 'e1';
  const ts = Timestamp.fromDate(NOW);
  const event: EventDoc = {
    title: 'テスト',
    state: opts.state ?? 'open',
    opensAt: Timestamp.fromDate(new Date('2027-03-20T01:00:00Z')),
    closesAt: Timestamp.fromDate(new Date('2027-03-20T07:00:00Z')),
    consultMinutes: DEFAULTS.consultMinutes,
    skipReturnMinutes: DEFAULTS.skipReturnMinutes,
    themes: THEMES,
    nextTicketNumber: DEFAULTS.firstTicketNumber,
    paused: opts.paused ?? false,
    updatedAt: ts,
  };
  const batch = db.batch();
  batch.set(db.doc(paths.event(eid)), event);
  const studentSlots = opts.studentSlots ?? [{ id: 's1' }];
  const slotCodes = Object.fromEntries(studentSlots.filter((s) => SLOT_CODES[s.id]).map((s) => [s.id, SLOT_CODES[s.id]!]));
  batch.set(db.doc(paths.secretCodes(eid)), { entryCode: ENTRY_CODE, facultyCode: FACULTY_CODE, slotCodes, updatedAt: ts });

  // 管理者の準備（P2-3）と同じく、board も最初から作っておく
  const boardSlots: Record<string, ReturnType<typeof computeBoardSlot>> = {};
  studentSlots.forEach((s, i) => {
    const occupied = s.occupied ?? true;
    const slot: SlotDoc = {
      kind: 'student',
      order: i,
      paused: s.paused ?? false,
      queueLimit: s.queueLimit ?? DEFAULTS.studentQueueLimit.default,
      updatedAt: ts,
      profile: { nickname: `学生${i}`, department: '心理学部 2年', bio: '', tags: [], avatarPath: null },
      location: `A-${i + 1}`,
      occupant: occupied ? { uid: `staff-${s.id}`, since: ts } : null,
    };
    const queue: QueueDoc = {
      kind: 'student',
      booths: occupied ? [{ staffUid: `staff-${s.id}`, booth: `A-${i + 1}` }] : [],
      waiting: [],
      skipped: [],
      serving: [],
      recentDurations: [],
      updatedAt: ts,
    };
    batch.set(db.doc(paths.slot(eid, s.id)), slot);
    batch.set(db.doc(paths.queue(eid, s.id)), queue);
    boardSlots[s.id] = computeBoardSlot(event, slot, queue);
  });

  const booths = opts.facultyBooths ?? 3;
  const faculty: SlotDoc = {
    kind: 'faculty',
    order: 100,
    paused: false,
    queueLimit: DEFAULTS.facultyQueueLimit.default,
    updatedAt: ts,
    profile: { title: '教員による個別相談', fields: [], description: '' },
    location: null,
    occupant: null,
  };
  const facultyQueue: QueueDoc = {
    kind: 'faculty',
    booths: Array.from({ length: booths }, (_, i) => ({ staffUid: `fac-${i}`, booth: `F-${i + 1}` })),
    waiting: [],
    skipped: [],
    serving: [],
    recentDurations: [],
    updatedAt: ts,
  };
  batch.set(db.doc(paths.slot(eid, FACULTY_SLOT_ID)), faculty);
  batch.set(db.doc(paths.queue(eid, FACULTY_SLOT_ID)), facultyQueue);
  boardSlots[FACULTY_SLOT_ID] = computeBoardSlot(event, faculty, facultyQueue);
  batch.set(db.doc(paths.board(eid)), { slots: boardSlots, paused: event.paused, updatedAt: ts });
  await batch.commit();
  return eid;
}

/** 匿名ログイン直後（クレームなし）の呼び出し元 */
export function anonymous(uid: string, ip: string | null = '203.0.113.1'): Caller {
  return { uid, provider: 'anonymous', eid: null, role: null, admin: false, secondFactor: null, ip };
}

export function visitorCaller(uid: string, eid = 'e1'): Caller {
  return { uid, provider: 'anonymous', eid, role: 'visitor', admin: false, secondFactor: null, ip: '203.0.113.1' };
}

/** HttpsError の details.reason を確かめる */
export async function expectReason(p: Promise<unknown>, reason: ErrorReason): Promise<HttpsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `${reason} で失敗するはず`).toBeInstanceOf(HttpsError);
  expect((err as HttpsError).details).toMatchObject({ reason });
  return err as HttpsError;
}

export function reasonOf(e: unknown): string | null {
  return e instanceof HttpsError ? ((e.details as { reason?: string })?.reason ?? null) : null;
}

export async function read<T>(path: string): Promise<T> {
  const snap = await db.doc(path).get();
  return snap.data() as T;
}

export function staffCaller(uid: string, role: 'student' | 'faculty', eid = 'e1'): Caller {
  return { uid, provider: 'anonymous', eid, role, admin: false, secondFactor: null, ip: '203.0.113.1' };
}

/**
 * seedEvent が作った担当に合わせてスタッフの記録を作る。
 * 学生 `staff-<slotId>` は枠を占有済み、教員 `fac-<i>` はブース `F-<i+1>` を設定済み。
 */
export async function seedStaff(
  eid: string,
  entries: { uid: string; role: 'student' | 'faculty'; slotId?: string | null; allowedSlotId?: string | null; booth?: string | null }[],
): Promise<void> {
  const batch = db.batch();
  const ts = Timestamp.fromDate(NOW);
  for (const e of entries) {
    batch.set(db.doc(paths.staff(eid, e.uid)), {
      role: e.role,
      // 学生は、占有中の枠のコードでログインしたことにする
      allowedSlotId: e.allowedSlotId !== undefined ? e.allowedSlotId : e.role === 'student' ? (e.slotId ?? null) : null,
      slotId: e.slotId ?? null,
      booth: e.booth ?? null,
      loggedInAt: ts,
      lastSeenAt: ts,
      expireAt: Timestamp.fromDate(new Date('2027-03-21T00:00:00Z')),
    });
  }
  await batch.commit();
}

/** 来場者の入場記録を作る */
export async function seedVisitors(eid: string, uids: string[]): Promise<void> {
  const batch = db.batch();
  const expireAt = Timestamp.fromDate(new Date('2027-03-21T00:00:00Z'));
  for (const uid of uids) {
    batch.set(db.doc(paths.visitor(eid, uid)), { enteredAt: Timestamp.fromDate(NOW), activeTicketId: null, expireAt });
  }
  await batch.commit();
}

/** 管理者（admin クレーム＋パスワードのログイン。TOTP なし） */
export function adminCaller(uid = 'admin1'): Caller {
  return { uid, provider: 'password', eid: null, role: null, admin: true, secondFactor: null, ip: '203.0.113.9' };
}
