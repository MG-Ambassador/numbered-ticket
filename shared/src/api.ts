// Cloud Functions（callable）の入出力とエラー理由。画面（P3）はこの型で呼ぶ。
// エラーは HttpsError で返し、details.reason に下の ErrorReason を入れる。
import type { Grade } from './index.js';
import type { FacultyProfile, StaffRole, StatsDoc } from './model.js';

export const FUNCTION_NAMES = {
  enterEvent: 'enterEvent',
  issueTicket: 'issueTicket',
  cancelTicket: 'cancelTicket',
  markArriving: 'markArriving',
  staffLogin: 'staffLogin',
  claimSlot: 'claimSlot',
  setBooth: 'setBooth',
  releaseAssignment: 'releaseAssignment',
  heartbeat: 'heartbeat',
  callNext: 'callNext',
  startConsult: 'startConsult',
  completeConsult: 'completeConsult',
  skipTicket: 'skipTicket',
  returnTicket: 'returnTicket',
  setSlotPaused: 'setSlotPaused',
  setQueueLimit: 'setQueueLimit',
  /** 管理者の操作はすべてこの1つの関数で受ける（op で振り分け）。起動待ちを1台にまとめるため */
  admin: 'adminApi',
} as const;

/** V-01 入場コード照合。成功したらクライアントは getIdToken(true) でトークンを更新する */
export interface EnterEventRequest {
  /** 7桁。区切りのハイフン・空白は関数側で取り除く */
  code: string;
}
export interface EnterEventResponse {
  eid: string;
  /** 有効な整理券があればその ID（再入場時に整理券画面へ戻すため） */
  activeTicketId: string | null;
}

/** V-03 発券 */
export interface IssueTicketRequest {
  slotId: string;
  grade: Grade | null;
  themes: string[];
  memo: string | null;
}
export interface IssueTicketResponse {
  ticketId: string;
  number: number;
}

/** V-06 キャンセル／V-05「いま向かいます」 */
export interface TicketRequest {
  ticketId: string;
}

/** S-01 スタッフログイン。成功したらクライアントは getIdToken(true) でトークンを更新する */
export interface StaffLoginRequest {
  /** 8桁。区切りのハイフン・空白は関数側で取り除く */
  code: string;
  role: StaffRole;
}
export interface StaffLoginResponse {
  eid: string;
  /** 再ログイン時に担当を戻すため */
  slotId: string | null;
  booth: string | null;
}

/** S-02 学生: 枠の占有 */
export interface ClaimSlotRequest {
  slotId: string;
}
/** S-02 教員: ブース番号の設定 */
export interface SetBoothRequest {
  booth: string;
}

/** S-04 呼出の結果。列が空なら queueEmpty で失敗する */
export interface CallNextResponse {
  ticketId: string;
  number: number;
}

/** S-07 受付停止・再開（自分の列） */
export interface SetSlotPausedRequest {
  paused: boolean;
}
/** S-08 列の上限（学生 1〜10、教員 10〜80 を 5刻み） */
export interface SetQueueLimitRequest {
  queueLimit: number;
}

// ---------------------------------------------------------------------------
// 管理者（A-01〜A-07）。呼べるのは admin クレーム＋TOTP 済みのトークンだけ
// 日時は ISO 8601 の文字列でやり取りする（callable は Timestamp をそのまま運べないため）
// ---------------------------------------------------------------------------

export interface EventSettings {
  title: string;
  /** ISO 8601（例: 2027-03-20T10:00:00+09:00） */
  opensAt: string;
  closesAt: string;
  consultMinutes: number;
  skipReturnMinutes: number;
  themes: string[];
}

/** 学生枠の登録内容（A-04）。CSV の1行と同じ */
export interface StudentSlotInput {
  /** 既存の枠を直すときだけ指定。新規なら省略 */
  id?: string;
  nickname: string;
  department: string;
  bio: string;
  tags: string[];
  location: string | null;
  order: number;
}

export type AdminRequest =
  /** A-01: ログインの記録（auditLog の admin.login） */
  | { op: 'recordLogin'; eid: string }
  /** A-01: 初回設定（パスワード変更・TOTP 登録）が済んだら initial クレームを外す */
  | { op: 'completeSetup' }
  /** A-02 */
  | { op: 'createEvent'; settings: EventSettings }
  | { op: 'updateEvent'; eid: string; settings: Partial<EventSettings> }
  /** A-03: 表示と再発行は auditLog に残す */
  | { op: 'viewCodes'; eid: string }
  | { op: 'reissueCode'; eid: string; kind: 'entry' | 'staff' }
  /** A-04 */
  | { op: 'importSlots'; eid: string; csv: string }
  | { op: 'upsertSlot'; eid: string; slot: StudentSlotInput }
  | { op: 'updateFacultyProfile'; eid: string; profile: FacultyProfile }
  | { op: 'deleteSlot'; eid: string; slotId: string }
  | { op: 'uploadAvatar'; eid: string; slotId: string; contentType: string; dataBase64: string }
  /** A-05 */
  | { op: 'openEvent'; eid: string }
  | { op: 'closeEvent'; eid: string }
  | { op: 'setGlobalPaused'; eid: string; paused: boolean }
  | { op: 'updateSlotSettings'; eid: string; slotId: string; paused?: boolean; queueLimit?: number }
  | { op: 'forceRelease'; eid: string; slotId: string; staffUid: string }
  /** A-06・A-07 */
  | { op: 'dashboard'; eid: string }
  | { op: 'previewStats'; eid: string };

export type AdminOp = AdminRequest['op'];

export interface CreateEventResponse {
  eid: string;
}
export interface ViewCodesResponse {
  entryCode: string;
  staffCode: string;
}
export interface ImportSlotsResponse {
  /** 取り込んだ枠の ID（CSV の行の順） */
  slotIds: string[];
}
/** CSV の取り込みで弾いた行（details.rows に入る） */
export interface SlotRowError {
  /** 1 始まり（見出し行を除く） */
  row: number;
  field: string;
  message: string;
}
export interface DashboardResponse {
  /** 直近10分の発券数 */
  issuedLast10m: number;
  /** 直近10分の入場コード・スタッフコードの失敗数 */
  entryFailuresLast10m: number;
  staffFailuresLast10m: number;
  warnings: ('issueSpike' | 'staffCodeFailures' | 'entryCodeFailures')[];
}
export type PreviewStatsResponse = Omit<StatsDoc, 'createdAt'>;

/** ポスター用の QR の URL（A-03）。読み込んだ画面は #code= をすぐ URL から消す（V-01） */
export function entryUrl(origin: string, entryCode: string): string {
  return `${origin.replace(/\/$/, '')}/#code=${entryCode}`;
}

export const ERROR_REASONS = {
  /** 入場コードが違う */
  wrongCode: '入場コードが違います',
  /** 試行制限（details.retryAfterSeconds あり） */
  rateLimited: '試行回数が多すぎます。しばらく待ってからお試しください',
  /** 受付中のイベントがない */
  noEvent: '現在受付中のイベントはありません',
  eventNotOpen: 'まだ開場していないか、すでに閉場しています',
  /** 会場全体の受付停止 */
  globalPaused: '現在、会場全体で受付を一時停止しています',
  /** 担当の受付停止 */
  slotPaused: 'この相談員は受付を一時停止しています',
  /** 列が上限に達した */
  full: '待ちの上限に達しています',
  /** 担当スタッフがまだいない */
  preparing: 'この相談員は準備中です',
  /** 有効な整理券を持っている（1端末1枚） */
  alreadyHasTicket: 'すでに整理券をお持ちです',
  /** 状態遷移が許されない */
  invalidState: 'この整理券では行えない操作です',
  notFound: '見つかりません',
  invalidInput: '入力内容を確認してください',
  /** 同時に操作が集中してトランザクションが通らなかった。少し待って再試行してよい */
  contention: '混み合っています。もう一度お試しください',
  /** 権限がない（匿名ログインでない・役割が違う・担当でない） */
  forbidden: 'この操作はできません',
  /** スタッフ: ほかの端末がその枠を占有している（1枠1台） */
  slotTaken: 'この枠はほかの端末が担当しています',
  /** スタッフ: そのブース番号はほかの教員が使っている */
  boothTaken: 'このブース番号はほかの方が使っています',
  /** スタッフ: すでに別の担当がある（外してから選び直す） */
  alreadyAssigned: 'すでに担当があります。担当を外してから選び直してください',
  /** スタッフ: 担当（枠・ブース）が未設定 */
  notAssigned: '担当が設定されていません',
  /** スタッフ: 対応中の方がいる（呼出・担当の解除ができない） */
  busy: '対応中の方がいます',
  /** スタッフ: 待っている方がいない */
  queueEmpty: '待っている方はいません',
  /** スタッフ: スキップから復帰できる時間を過ぎた */
  returnExpired: '復帰できる時間を過ぎています',
  /** 管理者: URL・SNS の ID を含む入力（A-04） */
  containsContact: 'URL や SNS の ID は登録できません',
  /** 管理者: 並んでいる方・担当がいる枠は消せない */
  slotInUse: '並んでいる方か担当のいる枠は削除できません',
} as const;
export type ErrorReason = keyof typeof ERROR_REASONS;

export interface ErrorDetails {
  reason: ErrorReason;
  retryAfterSeconds?: number;
  /** importSlots で弾いた行 */
  rows?: SlotRowError[];
}
