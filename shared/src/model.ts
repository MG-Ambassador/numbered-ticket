// Firestore のドキュメントの形（設計書 5.1）。
// クライアントからの書き込みはすべて拒否し、書くのは Cloud Functions だけ。
// 時刻は Firestore の Timestamp で保存する（TTL の対象にするため）。
import type { EventState, SlotKind, TicketState } from './index.js';

/**
 * Web SDK と Admin SDK の Timestamp の共通部分。
 * shared は SDK に依存しないため、構造だけで受ける。
 */
export interface TimestampLike {
  readonly seconds: number;
  readonly nanoseconds: number;
  toMillis(): number;
}

// ---------------------------------------------------------------------------
// 認証（カスタムクレーム）
// ---------------------------------------------------------------------------

export const ROLES = ['visitor', 'student', 'faculty'] as const;
export type Role = (typeof ROLES)[number];
export type StaffRole = Exclude<Role, 'visitor'>;

/**
 * 関数が setCustomUserClaims で付けるクレーム。ルールは request.auth.token で読む。
 * - 来場者: 匿名ログイン → 入場コード照合（V-01）で { eid, role: 'visitor' }
 * - スタッフ: 匿名ログイン → スタッフコード（S-01）で { eid, role: 'student' | 'faculty' }。役割はコードで決まる
 * - 管理者: 運営ID＋パスワードでログイン（operatorLogin）→ カスタムトークンのクレーム { admin: true, opId, opv }。
 *   ルールは operators/{opId} の version == opv・有効・仮パスワードでない・ログインから8時間以内を要する
 * クレームを付けたあと、クライアントは getIdToken(true) でトークンを更新する。
 */
export type AuthClaims =
  | { eid: string; role: Role; admin?: never }
  /** opId: 運営ID、opv: ログイン時のアカウントの version（停止・再発行・変更で進み、古いログインが無効になる） */
  | { admin: true; opId: string; opv: number; eid?: never; role?: never };

// ---------------------------------------------------------------------------
// events/{eventId}
// ---------------------------------------------------------------------------

/** 読める人: 自イベントのクレームを持つ全員、管理者 */
export interface EventDoc {
  /** 管理画面での表示名（例: "2027年3月 オープンキャンパス"） */
  title: string;
  state: EventState;
  opensAt: TimestampLike;
  closesAt: TimestampLike;
  /** 1組あたりの相談時間（分）。目安時間の初期値にも使う */
  consultMinutes: number;
  /** スキップから復帰できる時間（分） */
  skipReturnMinutes: number;
  /** 相談テーマの選択肢 */
  themes: string[];
  /** 次に発券する番号（採番。関数のトランザクションで +1） */
  nextTicketNumber: number;
  /** 会場全体の受付の一時停止（A-05）。列ごとの停止とは別に持つ */
  paused: boolean;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/secrets/codes
// ---------------------------------------------------------------------------

/** 読める人: なし（関数のみ） */
export interface SecretCodesDoc {
  /** 入場コード（7桁、先頭0可） */
  entryCode: string;
  /** 教員スタッフのコード（8桁）。教員相談は全学で一つの列なので、教員は共通 */
  facultyCode: string;
  /**
   * 学生枠ごとのスタッフコード（枠 ID → 8桁）。そのコードでログインした端末は、その枠だけを担当できる。
   * 枠の登録で作り、枠の削除で消す。どのコードも先頭4桁が重ならない
   */
  slotCodes: Record<string, string>;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/slots/{slotId}
// ---------------------------------------------------------------------------

export interface StudentProfile {
  /** ニックネーム（実名は登録しない） */
  nickname: string;
  /** 学部・学科・学年の表記（例: "心理学部 2年"） */
  department: string;
  bio: string;
  /** 得意テーマのタグ（# は付けない） */
  tags: string[];
  /** Storage のアバター画像のパス。なければ頭文字を表示 */
  avatarPath: string | null;
}

export interface FacultyProfile {
  /** 表示名（例: "教員による個別相談"） */
  title: string;
  /** 相談できる分野（例: カリキュラム、入試の基準、卒業後の進路） */
  fields: string[];
  description: string;
}

interface SlotBase {
  /** 一覧の並び順 */
  order: number;
  /** 担当の受付停止（S-07）。停止中も並んでいる方は呼べる */
  paused: boolean;
  /** 列の上限（S-08）。学生 1〜10、教員 10〜80 */
  queueLimit: number;
  updatedAt: TimestampLike;
}

/** 読める人: 開場中の来場者、スタッフ（開場前・開場中）、管理者 */
export interface StudentSlotDoc extends SlotBase {
  kind: 'student';
  profile: StudentProfile;
  /** ブースの位置（例: "A-3"）。未決事項 ⑬ で表示しない場合は null */
  location: string | null;
  /** 占有中のスタッフ（1枠1台）。null なら「準備中」 */
  occupant: { uid: string; since: TimestampLike } | null;
}

/** 教員相談の枠は FACULTY_SLOT_ID の1つだけ。占有者は持たず、ブースは staff 側に持つ */
export interface FacultySlotDoc extends SlotBase {
  kind: 'faculty';
  profile: FacultyProfile;
  location: null;
  occupant: null;
}

export type SlotDoc = StudentSlotDoc | FacultySlotDoc;

// ---------------------------------------------------------------------------
// events/{eventId}/queues/{slotId}（slotId と同じ ID）
// ---------------------------------------------------------------------------

export interface QueueEntry {
  ticketId: string;
  number: number;
}

export interface ServingEntry extends QueueEntry {
  state: Extract<TicketState, 'calling' | 'in_progress'>;
  /** 案内先のブース（学生は枠の位置、教員はスタッフのブース） */
  booth: string | null;
  /** 対応しているスタッフ。管理者が担当を強制解除すると null（その列の担当なら誰でも引き継げる） */
  staffUid: string | null;
  /** calling / in_progress になった時刻 */
  since: TimestampLike;
}

export interface SkippedEntry extends QueueEntry {
  skippedAt: TimestampLike;
  /** これを過ぎると expired（skippedAt + skipReturnMinutes） */
  returnDeadline: TimestampLike;
}

/** 列を受け持っているブース。学生は占有者1件（ブースは枠の位置）、教員はブースを設定した教員スタッフ */
export interface BoothEntry {
  staffUid: string;
  booth: string | null;
}

/** 読める人: 担当スタッフ（学生は占有者、教員相談は教員スタッフ）、管理者 */
export interface QueueDoc {
  kind: SlotKind;
  /** 稼働中のブース。件数が board の activeBooths になる */
  booths: BoothEntry[];
  /** 待ち順。先頭が次に呼ばれる */
  waiting: QueueEntry[];
  skipped: SkippedEntry[];
  /** 対応中（学生は最大1件、教員はブースの数まで） */
  serving: ServingEntry[];
  /** 直近の相談時間（秒）。新しい順に DEFAULTS.recentDurationsSize 件 */
  recentDurations: number[];
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/board/public
// ---------------------------------------------------------------------------

/** 来場者に見せる枠の状態（V-02）。色だけでなく文言でも出す */
export const BOARD_STATUSES = ['available', 'accepting', 'paused', 'preparing'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const BOARD_STATUS_LABELS: Readonly<Record<BoardStatus, string>> = {
  available: 'すぐ案内可',
  accepting: '受付中',
  paused: '一時停止中',
  preparing: '準備中',
};

/** 受付を止めている理由（S-07） */
export const PAUSE_REASONS = ['staff', 'limit', 'global'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface BoardSlot {
  kind: SlotKind;
  status: BoardStatus;
  /** status が paused のときの理由 */
  pauseReason: PauseReason | null;
  /** 待っている整理券の番号（待ち順）。来場者は自分の番号の位置から「あと○組」を出す */
  waitingNumbers: number[];
  /** 呼出中・相談中の番号 */
  servingNumbers: number[];
  /** 目安時間の材料: 平均相談時間（秒）。実績がなければ consultMinutes から */
  avgConsultSeconds: number;
  /** 目安時間の材料: 同時に対応できる数（学生は 0/1、教員は稼働ブース数） */
  activeBooths: number;
  queueLimit: number;
}

/** 読める人: 開場中の来場者、スタッフ（開場前・開場中）、管理者。個人を特定する情報は入れない */
export interface BoardDoc {
  slots: Record<string, BoardSlot>;
  /** 会場全体の受付停止 */
  paused: boolean;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/tickets/{ticketId}
// ---------------------------------------------------------------------------

/** 読める人: 本人（開場中）、担当スタッフ、管理者 */
export interface TicketDoc {
  number: number;
  slotId: string;
  /** 枠の種別（表示用。ルールの判定は slotId == FACULTY_SLOT_ID で行う） */
  kind: SlotKind;
  visitorUid: string;
  state: TicketState;
  /** 案内先のブース。呼出時に入る */
  booth: string | null;
  /** 対応中のスタッフ */
  staffUid: string | null;
  /** 問診: 学年（任意）。統計に使うので閉場＋1時間まで残す */
  grade: string | null;
  /** 問診: 相談テーマ（5個まで）。統計に使う */
  themes: string[];
  /** 問診メモ（自由記述 200字）。完了・キャンセル・閉場で即削除（null にする） */
  memo: string | null;
  createdAt: TimestampLike;
  calledAt: TimestampLike | null;
  /** 来場者が「いま向かいます」を押した時刻 */
  arrivingAt: TimestampLike | null;
  startedAt: TimestampLike | null;
  completedAt: TimestampLike | null;
  skippedAt: TimestampLike | null;
  /** スキップ中のみ。これを過ぎると expired */
  returnDeadline: TimestampLike | null;
  canceledAt: TimestampLike | null;
  expiredAt: TimestampLike | null;
  /** TTL（閉場＋1時間の削除が漏れた場合の保険） */
  expireAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/visitors/{uid}, events/{eventId}/staff/{uid}
// ---------------------------------------------------------------------------

/** 読める人: 本人、管理者 */
export interface VisitorDoc {
  enteredAt: TimestampLike;
  /** 有効な整理券（1端末1枚）。なければ null */
  activeTicketId: string | null;
  expireAt: TimestampLike;
}

/** 読める人: 本人、管理者 */
export interface StaffDoc {
  role: StaffRole;
  /** 学生: ログインに使ったスタッフコードの枠。占有できるのはこの枠だけ（教員は null） */
  allowedSlotId: string | null;
  /** 学生: 占有中の枠 */
  slotId: string | null;
  /** 教員: 座っているブース番号 */
  booth: string | null;
  loggedInAt: TimestampLike;
  /** 生存確認（画面を開いている間、定期的に更新） */
  lastSeenAt: TimestampLike;
  expireAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/rateLimits/{key}
// ---------------------------------------------------------------------------

/**
 * 試行制限（V-01・S-01）。読める人: なし（関数のみ）。
 * key は `<scope>_<HMAC-SHA256>`。端末の uid や IP はそのまま保存しない。
 */
export interface RateLimitDoc {
  /** 窓の期間内の失敗時刻 */
  failures: TimestampLike[];
  expireAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// events/{eventId}/auditLog/{id}, events/{eventId}/stats/{date}
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'queueLimit.change',
  'code.view',
  'code.reissue',
  'admin.login',
  'slot.forceRelease',
  'event.pause',
  'event.resume',
  'event.open',
  'event.close',
  'event.create',
  'event.update',
  'slot.update',
  'slot.import',
  'slot.delete',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 読める人: 管理者。当日削除 */
export interface AuditLogDoc {
  at: TimestampLike;
  action: AuditAction;
  /** system は定期処理（uid も 'system'） */
  actor: { uid: string; role: StaffRole | 'admin' | 'system' };
  /** 対象（枠 ID など） */
  target: string | null;
  /** 変更前後など。個人を特定する情報は入れない */
  detail: Record<string, string | number | boolean | null>;
  expireAt: TimestampLike;
}

/**
 * 運営アカウント（operators/{loginId}）。クライアントからは読み書きできない（ルールの get() と Admin SDK だけ）。
 * パスワードは scrypt のハッシュのみ保存する。version を進めると、そのアカウントの全ログインが無効になる
 */
export interface OperatorDoc {
  loginId: string;
  displayName: string;
  role: import('./roles.js').OperatorRole;
  passwordHash: string;
  active: boolean;
  /** 仮パスワードのまま（作成・再発行の直後） */
  mustChange: boolean;
  version: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** 運営アカウントの操作記録（operatorAudit/{id}）。パスワードなどの秘密は入れない */
export interface OperatorAuditDoc {
  at: TimestampLike;
  actor: string;
  action: string;
  target: string;
  version: number;
}

/** 読める人: 管理者。恒久保持するのはこれだけ。個人性のない集計のみ */
export interface StatsDoc {
  /** YYYY-MM-DD（JST） */
  date: string;
  issued: number;
  completed: number;
  canceled: number;
  expired: number;
  /** 学年 × テーマの件数（grade → theme → 件数） */
  gradeTheme: Record<string, Record<string, number>>;
  avgWaitSeconds: number;
  avgConsultSeconds: number;
  /** 時間帯別の発券数（"10" → 件数、JST の時） */
  issuedByHour: Record<string, number>;
  createdAt: TimestampLike;
}
