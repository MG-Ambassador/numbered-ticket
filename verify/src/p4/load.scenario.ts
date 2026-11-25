// P4 負荷シナリオ: 150組の来場者と10人前後のスタッフで、入場→発券→呼出→開始→完了を同時に流す。
// クライアントから見た関数の応答時間（p50・p95・最大）と、購読で受け取ったドキュメント数（読み取り件数の目安）を出す。
//
//   Emulator:  npm run test:load
//   本番:      docs/p4-integration.md の「本番での負荷テスト」の手順で（LOAD_PROJECT などを指定）
//
// 設定（環境変数。括弧内は既定値）
//   LOAD_GROUPS(150)  LOAD_STUDENT_SLOTS(7)  LOAD_FACULTY_BOOTHS(4)
//   LOAD_CONSULT_MS(3000)   1組の相談時間（実際の10分を縮めたもの）
//   LOAD_ARRIVAL_MS(600)    来場の間隔（0.5〜1.5倍）。最初の LOAD_RUSH(20) 組は同時に来る（開場直後の混雑）
//   LOAD_FUNCTIONS_PORT(5001)  Functions Emulator のポート（ほかの Emulator とぶつかるとき）
//   Emulator では関数の呼び出しを1件ずつ順に流す（serialized を参照）
//   LOAD_PROJECT / LOAD_API_KEY / LOAD_CONFIRM   本番で流すときだけ（下の target を参照）
import { mkdirSync, writeFileSync } from 'node:fs';
import { deleteApp, initializeApp as initClientApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth as getClientAuth, signInAnonymously } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  type Firestore as ClientFirestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions';
import { getApps, initializeApp as initAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  FUNCTION_NAMES,
  REGION,
  paths,
  type BoardDoc,
  type CallNextResponse,
  type EventDoc,
  type IssueTicketResponse,
  type QueueDoc,
  type SlotDoc,
  type TicketDoc,
} from '@nt/shared';
import { computeBoardSlot } from '../../../functions/src/core/board.js';

// ---- 実行先 ---------------------------------------------------------------------

const env = process.env;
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);

const PROD_PROJECT = env.LOAD_PROJECT;
const onEmulator = !PROD_PROJECT;
if (onEmulator && !env.FIRESTORE_EMULATOR_HOST) throw new Error('Emulator の中で実行すること（npm run test:load）');
if (PROD_PROJECT) {
  // 本番に書き込むので、プロジェクト名をもう一度書かせる
  if (env.LOAD_CONFIRM !== PROD_PROJECT) throw new Error(`本番で流すときは LOAD_CONFIRM=${PROD_PROJECT} も指定すること`);
  if (!env.LOAD_API_KEY) throw new Error('LOAD_API_KEY（Web の API キー）を指定すること');
  if (env.FIRESTORE_EMULATOR_HOST) throw new Error('本番で流すときは Emulator の環境変数を外すこと');
}
const PROJECT_ID = PROD_PROJECT ?? 'demo-numbered-ticket';

const CFG = {
  groups: num('LOAD_GROUPS', 150),
  studentSlots: num('LOAD_STUDENT_SLOTS', 7),
  facultyBooths: num('LOAD_FACULTY_BOOTHS', 4),
  consultMs: num('LOAD_CONSULT_MS', 3000),
  // 相談 10分 → 3秒（1/200）に合わせ、開催5時間で150組（平均2分間隔）を 0.6秒間隔に縮める
  arrivalMs: num('LOAD_ARRIVAL_MS', 600),
  rush: num('LOAD_RUSH', 20),
  /** 学生相談を選ぶ割合（残りは教員相談） */
  studentShare: 0.4,
  cancelShare: 0.05,
  skipShare: 0.03,
};
const EID = `load-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
const ENTRY_CODE = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
const STAFF_CODE = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const THEMES = ['入試・選抜方法', '学部・学科の学び', '学生生活'];

const adminApp = getApps()[0] ?? initAdminApp({ projectId: PROJECT_ID });
const adminDb = getAdminFirestore(adminApp);
const adminAuth = getAdminAuth(adminApp);

// ---- 計測 -----------------------------------------------------------------------

const latencies = new Map<string, number[]>();
const errors = new Map<string, number>();
const reads = { board: 0, ticket: 0, queue: 0 };
const createdUids = new Set<string>();

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const list = latencies.get(name) ?? [];
    list.push(performance.now() - t0);
    latencies.set(name, list);
  }
}

function countError(name: string, e: unknown): string {
  const reason = (e as { details?: { reason?: string } }).details?.reason ?? (e as { code?: string }).code ?? 'unknown';
  const key = `${name}:${reason}`;
  errors.set(key, (errors.get(key) ?? 0) + 1);
  return reason;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- クライアント ---------------------------------------------------------------

interface Client {
  app: FirebaseApp;
  db: ClientFirestore;
  fns: Functions;
  uid: string;
  refresh: () => Promise<void>;
  call: <Req, Res = unknown>(name: string, data?: Req) => Promise<Res>;
}

/**
 * Emulator では関数の呼び出しを1件ずつ順に流す。発券・呼出などはどれも同じドキュメント（採番の events、board）を
 * 読んでから書くので、同時に2件走ると、本番なら片方が中断・再試行されるところを、Emulator ではロックの待ち合いで
 * 時間切れ（60秒）まで止まる。Emulator では流れが正しいことだけを確かめ、速さと同時実行は本番で測る
 */
let emulatorChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  if (!onEmulator) return fn();
  const next = emulatorChain.then(fn, fn);
  emulatorChain = next.catch(() => undefined);
  return next;
}

let seq = 0;
async function newClient(): Promise<Client> {
  const app = initClientApp(
    { apiKey: env.LOAD_API_KEY ?? 'demo-key', projectId: PROJECT_ID, appId: 'load', authDomain: `${PROJECT_ID}.firebaseapp.com` },
    `load-${seq++}`,
  );
  const auth = getClientAuth(app);
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  const fns = getFunctions(app, REGION);
  if (onEmulator) {
    connectAuthEmulator(auth, `http://${env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    const [host, port] = env.FIRESTORE_EMULATOR_HOST!.split(':');
    connectFirestoreEmulator(db, host!, Number(port));
    connectFunctionsEmulator(fns, '127.0.0.1', num('LOAD_FUNCTIONS_PORT', 5001));
  }
  const { user } = await timed('signInAnonymously', () => signInAnonymously(auth));
  createdUids.add(user.uid);
  return {
    app,
    db,
    fns,
    uid: user.uid,
    refresh: async () => {
      await timed('getIdToken(refresh)', () => user.getIdToken(true));
    },
    call: async <Req, Res>(name: string, data?: Req) => {
      const res = await serialized(() => timed(name, () => httpsCallable<Req, Res>(fns, name)(data as Req)));
      return res.data;
    },
  };
}

/** 購読して、届いたドキュメント数を数える（初回は全件、以降は変更分が読み取りとして課金される） */
function watch<T>(c: Client, path: string, kind: keyof typeof reads, onData: (d: T | undefined) => void): Unsubscribe {
  return onSnapshot(
    doc(c.db, path),
    (snap) => {
      reads[kind] += 1;
      onData(snap.data() as T | undefined);
    },
    (e) => countError(`listen:${kind}`, e),
  );
}

// ---- イベントの準備（seed-emulator.mjs と同じ形。本番でも管理画面を通さず Admin SDK で作る） ----

async function seed(): Promise<void> {
  const others = await adminDb.collection('events').where('state', 'in', ['scheduled', 'open']).get();
  if (!others.empty) throw new Error(`開催中・開催予定のイベントがあるため流せない: ${others.docs.map((d) => d.id).join(', ')}`);

  const now = Date.now();
  const ts = Timestamp.fromMillis(now);
  const event: EventDoc = {
    title: `負荷テスト ${EID}`,
    state: 'open',
    opensAt: Timestamp.fromMillis(now - 60_000),
    closesAt: Timestamp.fromMillis(now + 3 * 3600_000),
    consultMinutes: DEFAULTS.consultMinutes,
    skipReturnMinutes: DEFAULTS.skipReturnMinutes,
    themes: THEMES,
    nextTicketNumber: DEFAULTS.firstTicketNumber,
    paused: false,
    updatedAt: ts,
  };
  const emptyQueue = (kind: QueueDoc['kind']): QueueDoc => ({ kind, booths: [], waiting: [], skipped: [], serving: [], recentDurations: [], updatedAt: ts });
  const batch = adminDb.batch();
  batch.set(adminDb.doc(paths.event(EID)), event);
  batch.set(adminDb.doc(paths.secretCodes(EID)), { entryCode: ENTRY_CODE, staffCode: STAFF_CODE, updatedAt: ts });
  const board: BoardDoc['slots'] = {};
  for (let i = 0; i < CFG.studentSlots; i++) {
    const id = `s${i + 1}`;
    const slot: SlotDoc = {
      kind: 'student',
      order: i,
      paused: false,
      queueLimit: DEFAULTS.studentQueueLimit.default,
      updatedAt: ts,
      profile: { nickname: `学生${i + 1}`, department: '負荷テスト', bio: '', tags: [], avatarPath: null },
      location: `A-${i + 1}`,
      occupant: null,
    };
    batch.set(adminDb.doc(paths.slot(EID, id)), slot);
    batch.set(adminDb.doc(paths.queue(EID, id)), emptyQueue('student'));
    board[id] = computeBoardSlot(event, slot, emptyQueue('student'));
  }
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
  batch.set(adminDb.doc(paths.slot(EID, FACULTY_SLOT_ID)), faculty);
  batch.set(adminDb.doc(paths.queue(EID, FACULTY_SLOT_ID)), emptyQueue('faculty'));
  board[FACULTY_SLOT_ID] = computeBoardSlot(event, faculty, emptyQueue('faculty'));
  batch.set(adminDb.doc(paths.board(EID)), { slots: board, paused: false, updatedAt: ts });
  await batch.commit();
}

async function cleanup(): Promise<void> {
  await adminDb.recursiveDelete(adminDb.doc(paths.event(EID)));
  const uids = [...createdUids];
  for (let i = 0; i < uids.length; i += 1000) await adminAuth.deleteUsers(uids.slice(i, i + 1000));
}

// ---- スタッフ -------------------------------------------------------------------

interface StaffRun {
  stop: () => void;
  done: Promise<void>;
  served: number;
}

async function startStaff(kind: 'student' | 'faculty', index: number, isFinished: () => boolean): Promise<StaffRun> {
  const c = await newClient();
  await c.call(FUNCTION_NAMES.staffLogin, { code: STAFF_CODE, role: kind });
  await c.refresh();
  const slotId = kind === 'student' ? `s${index + 1}` : FACULTY_SLOT_ID;
  if (kind === 'student') await c.call(FUNCTION_NAMES.claimSlot, { slotId });
  else await c.call(FUNCTION_NAMES.setBooth, { booth: `F-${index + 1}` });

  let stopped = false;
  let waiting = 0;
  const unsub = watch<QueueDoc>(c, paths.queue(EID, slotId), 'queue', (q) => {
    waiting = q?.waiting.length ?? 0;
  });
  const run: StaffRun = { stop: () => (stopped = true), served: 0, done: Promise.resolve() };

  run.done = (async () => {
    while (!stopped && !isFinished()) {
      if (waiting === 0) {
        await sleep(300);
        continue;
      }
      let ticket: CallNextResponse;
      try {
        ticket = await c.call<void, CallNextResponse>(FUNCTION_NAMES.callNext);
      } catch (e) {
        countError(FUNCTION_NAMES.callNext, e);
        await sleep(300);
        continue;
      }
      await sleep(300); // 来場者がブースに来るまで
      const req = { ticketId: ticket.ticketId };
      try {
        if (Math.random() < CFG.skipShare) {
          await c.call(FUNCTION_NAMES.skipTicket, req);
          await sleep(1000);
          await c.call(FUNCTION_NAMES.returnTicket, req); // 戻ってきた（列の先頭へ）
          continue;
        }
        await c.call(FUNCTION_NAMES.startConsult, req);
        await sleep(CFG.consultMs * (0.5 + Math.random()));
        await c.call(FUNCTION_NAMES.completeConsult, req);
        run.served++;
      } catch (e) {
        // 来場者のキャンセルと重なったときなど
        countError('staffFlow', e);
      }
    }
    unsub();
    await deleteApp(c.app);
  })();
  return run;
}

// ---- 来場者 ---------------------------------------------------------------------

type Outcome = 'completed' | 'canceled' | 'gaveUp' | 'error' | 'timeout';

async function visitor(deadline: number): Promise<Outcome> {
  let c: Client | null = null;
  const unsubs: Unsubscribe[] = [];
  try {
    c = await newClient();
    await c.call(FUNCTION_NAMES.enterEvent, { code: ENTRY_CODE });
    await c.refresh();

    // 一覧を見てから選ぶ
    const board = await new Promise<BoardDoc>((resolve) => {
      unsubs.push(watch<BoardDoc>(c!, paths.board(EID), 'board', (b) => b && resolve(b)));
    });
    const students = Object.entries(board.slots)
      .filter(([id, s]) => id !== FACULTY_SLOT_ID && (s.status === 'available' || s.status === 'accepting'))
      .map(([id]) => id);
    const choices = Math.random() < CFG.studentShare && students.length > 0
      ? [students[Math.floor(Math.random() * students.length)]!, FACULTY_SLOT_ID]
      : [FACULTY_SLOT_ID];

    let issued: IssueTicketResponse | null = null;
    for (const slotId of choices) {
      try {
        issued = await c.call(FUNCTION_NAMES.issueTicket, { slotId, grade: '高校3年', themes: [THEMES[0]], memo: null });
        break;
      } catch (e) {
        // 上限・停止・準備中なら別の列に回る。それ以外（時間切れ・混雑など）はエラー
        const reason = countError(FUNCTION_NAMES.issueTicket, e);
        if (!['full', 'slotPaused', 'preparing'].includes(reason)) return 'error';
      }
    }
    if (!issued) return 'gaveUp';

    const final = await new Promise<Outcome>((resolve) => {
      let canceling = false;
      let arriving = false;
      const timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      unsubs.push(
        watch<TicketDoc>(c!, paths.ticket(EID, issued!.ticketId), 'ticket', (t) => {
          if (!t) return;
          if (t.state === 'completed' || t.state === 'canceled' || t.state === 'expired') {
            clearTimeout(timer);
            resolve(t.state === 'completed' ? 'completed' : 'canceled');
          } else if (t.state === 'calling' && !arriving) {
            arriving = true;
            c!.call(FUNCTION_NAMES.markArriving, { ticketId: issued!.ticketId }).catch((e) => countError(FUNCTION_NAMES.markArriving, e));
          } else if (t.state === 'waiting' && !canceling && Math.random() < CFG.cancelShare / 3) {
            canceling = true;
            c!.call(FUNCTION_NAMES.cancelTicket, { ticketId: issued!.ticketId }).catch((e) => countError(FUNCTION_NAMES.cancelTicket, e));
          }
        }),
      );
    });
    return final;
  } catch (e) {
    countError('visitorFlow', e);
    return 'error';
  } finally {
    unsubs.forEach((u) => u());
    if (c) await deleteApp(c.app);
  }
}

// ---- 本体 -----------------------------------------------------------------------

const TIMEOUT_MS = num('LOAD_TIMEOUT_MS', 25 * 60_000);

describe(`負荷シナリオ（${onEmulator ? 'Emulator' : PROJECT_ID}）`, () => {
  beforeAll(seed, 60_000);
  afterAll(cleanup, 300_000);

  it(`${CFG.groups}組が入場から完了まで流れる`, async () => {
    const startedAt = new Date();
    const deadline = Date.now() + TIMEOUT_MS - 60_000;
    let finished = 0;
    const isFinished = () => finished >= CFG.groups;

    const staff = await Promise.all([
      ...Array.from({ length: CFG.studentSlots }, (_, i) => startStaff('student', i, isFinished)),
      ...Array.from({ length: CFG.facultyBooths }, (_, i) => startStaff('faculty', i, isFinished)),
    ]);

    const outcomes: Promise<Outcome>[] = [];
    for (let i = 0; i < CFG.groups; i++) {
      if (i >= CFG.rush) await sleep(CFG.arrivalMs * (0.5 + Math.random()));
      outcomes.push(
        visitor(deadline).then((o) => {
          finished++;
          return o;
        }),
      );
    }
    const results = await Promise.all(outcomes);
    staff.forEach((s) => s.stop());
    await Promise.all(staff.map((s) => s.done));
    const endedAt = new Date();

    // ---- 結果 ----
    const count = (o: Outcome) => results.filter((r) => r === o).length;
    const summary = {
      target: onEmulator ? 'emulator' : PROJECT_ID,
      eid: EID,
      config: CFG,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      outcomes: { completed: count('completed'), canceled: count('canceled'), gaveUp: count('gaveUp'), error: count('error'), timeout: count('timeout') },
      served: staff.reduce((a, s) => a + s.served, 0),
      latencyMs: Object.fromEntries(
        [...latencies.entries()].sort().map(([name, list]) => {
          const s = [...list].sort((a, b) => a - b);
          return [name, { n: s.length, p50: Math.round(percentile(s, 50)), p95: Math.round(percentile(s, 95)), max: Math.round(s[s.length - 1]!) }];
        }),
      ),
      errors: Object.fromEntries([...errors.entries()].sort()),
      /** 購読で受け取ったスナップショット数（各1ドキュメント）。関数側の読み取りは含まない */
      listenerReads: reads,
    };
    console.table(summary.latencyMs);
    console.log(JSON.stringify({ ...summary, latencyMs: undefined }, null, 2));
    mkdirSync('out', { recursive: true });
    writeFileSync(`out/${EID}-${summary.target}.json`, JSON.stringify(summary, null, 2));

    expect(summary.outcomes.error).toBe(0);
    expect(summary.outcomes.timeout).toBe(0);
    expect(summary.outcomes.completed + summary.outcomes.canceled + summary.outcomes.gaveUp).toBe(CFG.groups);
    // 列が上限で発券できない組はいてよいが、大半は完了まで進むはず（相談の速さに対して来場が速すぎなければ）
    expect(summary.outcomes.completed).toBeGreaterThanOrEqual(CFG.groups * 0.8);
    // 発券・呼出の p95 300ms（設計書 4章）は本番でだけ確かめる。Emulator の速さは本番と関係ない
    if (!onEmulator) {
      expect(summary.latencyMs[FUNCTION_NAMES.issueTicket]?.p95).toBeLessThanOrEqual(300);
      expect(summary.latencyMs[FUNCTION_NAMES.callNext]?.p95).toBeLessThanOrEqual(300);
    }
  }, TIMEOUT_MS);
});
