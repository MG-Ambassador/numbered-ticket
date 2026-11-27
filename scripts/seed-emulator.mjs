// Emulator に画面確認用のイベントを作る（P3）。本番には使わない。
//
//   npm run emulators            # 別のターミナルで
//   node scripts/seed-emulator.mjs [--state open|scheduled] [--reset]
//
// - 入場コード 038-4712、スタッフコード 0384-7125
// - 学生枠 5 つ（すべて担当なし＝準備中）と教員相談の枠
// - 開場時刻は今の1時間前、閉場時刻は今の6時間後
// - --reset で Firestore の中身を全部消してから作る
// - 運営アカウント admin（開発者）・owner・faculty・staff。パスワードは dev-operator-password（仮パスワードではない）
// 本番のイベント作成は管理画面（adminApi の createEvent）で行う。ここでは board も含めて直接書く。
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { hashPassword } from '../functions/src/core/password.ts';

const PROJECT_ID = 'demo-numbered-ticket';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';

const args = process.argv.slice(2);
const state = args.includes('--state') ? args[args.indexOf('--state') + 1] : 'open';
if (!['open', 'scheduled'].includes(state)) throw new Error('--state は open か scheduled');

const EID = 'dev';
const ENTRY_CODE = '0384712';
/** 教員のスタッフコード（教員共通） */
const FACULTY_CODE = '03847125';
/** 学生枠ごとのスタッフコード（s1, s2, …の順） */
const SLOT_CODES = ['51829364', '62930475', '73041586', '84152697', '95263708'];
const THEMES = ['入試・選抜方法', '学部・学科の学び', '学生生活', '就職・資格', '費用・奨学金', 'その他'];
const STUDENTS = [
  { nickname: 'ゆい', department: '国際学部 4年', tags: ['留学', '総合型選抜'], bio: '総合型選抜で入学し、3年の秋から1年間カナダに留学しました。準備の進め方をお話しできます。' },
  { nickname: 'ひなた', department: '経済学部 2年', tags: ['一人暮らし', '部活・サークル'], bio: '一人暮らしをしながら部活を続けています。両立のコツや生活費のことを聞いてください。' },
  { nickname: 'けんと', department: '社会学部 3年', tags: ['入試の体験', '部活・サークル'], bio: '一般選抜で入学しました。受験期の勉強の進め方や、入学してからの部活のことをお話しします。' },
  { nickname: 'そうた', department: '法学部 3年', tags: ['留学', '奨学金'], bio: '2年の夏に短期留学をしました。費用の準備や奨学金の探し方など、気軽に聞いてください。' },
  { nickname: 'みお', department: '文学部 英文学科 2年', tags: ['入試の体験'], bio: '英語の外部試験を使った入試で入学しました。出願までの準備をお話しできます。' },
];

if (args.includes('--reset')) {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Firestore の削除に失敗: ${res.status}`);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const now = Date.now();
const ts = Timestamp.fromMillis(now);
const closesAt = Timestamp.fromMillis(now + 6 * 3600_000);

const event = {
  title: '画面確認用（Emulator）',
  state,
  opensAt: Timestamp.fromMillis(now - 3600_000),
  closesAt,
  consultMinutes: 10,
  skipReturnMinutes: 10,
  themes: THEMES,
  nextTicketNumber: 101,
  paused: false,
  updatedAt: ts,
};

const emptyQueue = (kind) => ({ kind, booths: [], waiting: [], skipped: [], serving: [], recentDurations: [], updatedAt: ts });
// 担当がいない枠は「準備中」（functions/src/core/board.ts の computeBoardSlot と同じ結果）
const preparing = (kind, queueLimit) => ({
  kind,
  status: 'preparing',
  pauseReason: null,
  waitingNumbers: [],
  servingNumbers: [],
  avgConsultSeconds: event.consultMinutes * 60,
  activeBooths: 0,
  queueLimit,
});

const batch = db.batch();
batch.set(db.doc(`events/${EID}`), event);
const slotCodes = Object.fromEntries(STUDENTS.map((_, i) => [`s${i + 1}`, SLOT_CODES[i]]));
batch.set(db.doc(`events/${EID}/secrets/codes`), { entryCode: ENTRY_CODE, facultyCode: FACULTY_CODE, slotCodes, updatedAt: ts });
const board = {};
STUDENTS.forEach((p, i) => {
  const id = `s${i + 1}`;
  batch.set(db.doc(`events/${EID}/slots/${id}`), {
    kind: 'student',
    order: i,
    paused: false,
    queueLimit: 5,
    updatedAt: ts,
    profile: { ...p },
    location: `A-${i + 1}`,
    occupant: null,
  });
  batch.set(db.doc(`events/${EID}/queues/${id}`), emptyQueue('student'));
  board[id] = preparing('student', 5);
});
batch.set(db.doc(`events/${EID}/slots/faculty`), {
  kind: 'faculty',
  order: 100,
  paused: false,
  queueLimit: 40,
  updatedAt: ts,
  profile: {
    title: '教員による個別相談',
    fields: ['カリキュラム', '入試の基準', '卒業後の進路'],
    description: '相談員は選ばず、全学で一つの列に並びます。手の空いた教員がブースへご案内します。',
  },
  location: null,
  occupant: null,
});
batch.set(db.doc(`events/${EID}/queues/faculty`), emptyQueue('faculty'));
board.faculty = preparing('faculty', 40);
batch.set(db.doc(`events/${EID}/board/public`), { slots: board, paused: false, updatedAt: ts });
await batch.commit();

// 運営アカウント（管理者）。ロールごとに1つ。パスワードはどれも dev-operator-password（仮パスワードではない）
const OPERATOR_PASSWORD = 'dev-operator-password';
const passwordHash = await hashPassword(OPERATOR_PASSWORD);
for (const [loginId, role, displayName] of [
  ['admin', 'developer', '開発者'],
  ['owner', 'owner', '責任者'],
  ['faculty', 'faculty', '教員'],
  ['staff', 'staff', 'スタッフ'],
]) {
  await db.doc(`operators/${loginId}`).set({ loginId, displayName, role, passwordHash, active: true, mustChange: false, version: 1, createdAt: ts, updatedAt: ts });
}

console.log(`イベント ${EID} を作りました（${state}）`);
console.log('  入場コード   038-4712   → http://localhost:5173/#code=0384712');
console.log('  スタッフ                 → http://localhost:5173/staff');
console.log('    教員（共通）     0384-7125');
STUDENTS.forEach((p, i) => console.log(`    学生 A-${i + 1} ${p.nickname.padEnd(4, '　')} ${SLOT_CODES[i].slice(0, 4)}-${SLOT_CODES[i].slice(4)}`));
console.log('  管理者 運営ID admin（開発者）・owner（責任者）・faculty（教員）・staff（スタッフ） / dev-operator-password → http://localhost:5173/admin');
