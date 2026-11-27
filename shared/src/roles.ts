// 管理者（運営）アカウントのロールと権限。明学の質問箱（meigaku-question-box）の server/src/permissions.ts と同じ体系。
// サーバー（functions/src/core/operators.ts）が判定の正本で、画面は表示を絞るためにだけ使う。
//
// | 操作                                   | 開発者 | 責任者     | 教員 | アンバサダー | スタッフ |
// | 当日の確認（ダッシュボード・統計）     | ◯      | ◯          | ◯    | ◯            | ◯        |
// | 受付の一時停止・列の設定               | ◯      | ◯          | ◯    | ◯            | ◯        |
// | 開場・閉場・強制解除                   | ◯      | ◯          | ◯    | ◯            | －       |
// | イベント・枠の作成と編集               | ◯      | ◯          | ◯    | ◯            | －       |
// | コードの表示・再発行                   | ◯      | ◯          | ◯    | ◯            | －       |
// | アカウント管理                         | ◯ 全員 | ◯ 教員以下 | －   | －           | －       |
import type { AdminOp } from './api.js';

export const OPERATOR_ROLES = ['developer', 'owner', 'faculty', 'ambassador', 'staff'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const ROLE_LABELS: Record<OperatorRole, string> = {
  developer: '開発者',
  owner: '責任者',
  faculty: '教員',
  ambassador: 'アンバサダー',
  staff: 'スタッフ',
};

export type Permission =
  /** 当日の確認（ダッシュボード・統計） */
  | 'event.view'
  /** 受付の一時停止・列の上限と停止 */
  | 'event.toggle'
  /** 開場・閉場・強制解除 */
  | 'event.operate'
  /** イベント・枠の作成と編集 */
  | 'event.manage'
  /** 入場コード・スタッフコードの表示と再発行 */
  | 'codes.manage'
  /** アカウント管理 */
  | 'accounts.manage';

const GRANTS: Record<OperatorRole, readonly Permission[]> = {
  developer: ['event.view', 'event.toggle', 'event.operate', 'event.manage', 'codes.manage', 'accounts.manage'],
  owner: ['event.view', 'event.toggle', 'event.operate', 'event.manage', 'codes.manage', 'accounts.manage'],
  faculty: ['event.view', 'event.toggle', 'event.operate', 'event.manage', 'codes.manage'],
  ambassador: ['event.view', 'event.toggle', 'event.operate', 'event.manage', 'codes.manage'],
  staff: ['event.view', 'event.toggle'],
};

/** 保存済みのロールを現行のロールに読み替える。不明な値は最も権限の弱いスタッフ */
export function normalizeRole(role: unknown): OperatorRole {
  return (OPERATOR_ROLES as readonly unknown[]).includes(role) ? (role as OperatorRole) : 'staff';
}

export function can(role: unknown, permission: Permission): boolean {
  return GRANTS[normalizeRole(role)].includes(permission);
}

/** そのロールの人が作成・再発行・利用停止・ロール変更できるアカウントのロール */
export function manageableRoles(role: unknown): OperatorRole[] {
  switch (normalizeRole(role)) {
    case 'developer':
      return [...OPERATOR_ROLES];
    case 'owner':
      return ['faculty', 'ambassador', 'staff'];
    default:
      return [];
  }
}

/** adminApi の op ごとに必要な権限。null は、ログインしていれば誰でも（自分の情報・パスワード変更） */
export const ADMIN_OP_PERMISSIONS: Record<AdminOp, Permission | null> = {
  me: null,
  changePassword: null,
  recordLogin: 'event.view',
  dashboard: 'event.view',
  previewStats: 'event.view',
  setGlobalPaused: 'event.toggle',
  updateSlotSettings: 'event.toggle',
  openEvent: 'event.operate',
  closeEvent: 'event.operate',
  forceRelease: 'event.operate',
  createEvent: 'event.manage',
  updateEvent: 'event.manage',
  importSlots: 'event.manage',
  upsertSlot: 'event.manage',
  updateFacultyProfile: 'event.manage',
  deleteSlot: 'event.manage',
  viewCodes: 'codes.manage',
  reissueCode: 'codes.manage',
  listOperators: 'accounts.manage',
  createOperator: 'accounts.manage',
  operatorAction: 'accounts.manage',
  setOperatorRole: 'accounts.manage',
};

/** ログインの有効期間（質問箱と同じ8時間・延長なし）。ルール（firestore.rules）の 28800 と同じ値 */
export const OPERATOR_SESSION_SECONDS = 8 * 60 * 60;

/** 運営ID: 半角英数字・ハイフン・アンダーバーの3〜40文字。小文字に正規化する。不正なら null */
export function normalizeLoginId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{3,40}$/.test(value) ? value.toLowerCase() : null;
}

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

/** 文字数はコードポイント単位で数える */
export function passwordValid(value: unknown): value is string {
  return typeof value === 'string' && [...value].length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}
