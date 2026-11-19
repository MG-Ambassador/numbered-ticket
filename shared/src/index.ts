// 来場者・スタッフ・関数で共有する定数と型。
// 詳細な型は P1 で設計書 5.1 に沿って追加する。

export const REGION = 'asia-northeast1';

/** 設計書 3.3 A-02 / 3.2 S-08 の既定値 */
export const DEFAULTS = {
  consultMinutes: 10,
  skipReturnMinutes: 10,
  studentQueueLimit: { min: 1, max: 10, step: 1, default: 5 },
  facultyQueueLimit: { min: 10, max: 80, step: 5, default: 40 },
  memoMaxLength: 200,
  maxThemes: 5,
} as const;

export const EVENT_STATES = ['scheduled', 'open', 'closed', 'purged'] as const;
export type EventState = (typeof EVENT_STATES)[number];

export const TICKET_STATES = [
  'waiting',
  'calling',
  'in_progress',
  'completed',
  'skipped',
  'canceled',
  'expired',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export type SlotKind = 'student' | 'faculty';
