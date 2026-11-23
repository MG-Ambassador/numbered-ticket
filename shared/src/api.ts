// Cloud Functions（callable）の入出力とエラー理由。画面（P3）はこの型で呼ぶ。
// エラーは HttpsError で返し、details.reason に下の ErrorReason を入れる。
import type { Grade } from './index.js';

export const FUNCTION_NAMES = {
  enterEvent: 'enterEvent',
  issueTicket: 'issueTicket',
  cancelTicket: 'cancelTicket',
  markArriving: 'markArriving',
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
  notAnonymous: 'この操作はできません',
} as const;
export type ErrorReason = keyof typeof ERROR_REASONS;

export interface ErrorDetails {
  reason: ErrorReason;
  retryAfterSeconds?: number;
}
