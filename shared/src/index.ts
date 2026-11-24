// 来場者・スタッフ・関数で共有する定数と型。
// データの形は docs/p1-data-model.md と設計書 5.1 に対応する。

export * from './model.js';
export * from './paths.js';
export * from './api.js';
export * from './display.js';

export const REGION = 'asia-northeast1';

/** 設計書 3.3 A-02 / 3.2 S-08 の既定値 */
export const DEFAULTS = {
  consultMinutes: 10,
  skipReturnMinutes: 10,
  studentQueueLimit: { min: 1, max: 10, step: 1, default: 5 },
  facultyQueueLimit: { min: 10, max: 80, step: 5, default: 40 },
  memoMaxLength: 200,
  maxThemes: 5,
  /** 整理券番号の初番（101, 102, ...） */
  firstTicketNumber: 101,
  /** queues の直近の相談時間を何件まで持つか */
  recentDurationsSize: 10,
} as const;

/** 来場者の学年の選択肢（モックアップと同じ） */
export const GRADES = ['高校3年', '高校2年', '高校1年', '保護者', 'その他'] as const;
export type Grade = (typeof GRADES)[number];

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

/** 有効な整理券（1端末1枚の判定に使う）。V-03 */
export const ACTIVE_TICKET_STATES = ['waiting', 'calling', 'in_progress', 'skipped'] as const satisfies readonly TicketState[];
/** 来場者がキャンセルできる状態。V-06 */
export const CANCELABLE_TICKET_STATES = ['waiting', 'calling', 'skipped'] as const satisfies readonly TicketState[];

/**
 * 整理券の状態遷移（関数はこれ以外の遷移を拒否する）。
 * skipped → waiting は復帰（列の先頭へ）。
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  waiting: ['calling', 'canceled', 'expired'],
  calling: ['in_progress', 'skipped', 'canceled', 'expired'],
  in_progress: ['completed', 'expired'],
  skipped: ['waiting', 'canceled', 'expired'],
  completed: [],
  canceled: [],
  expired: [],
};

export const SLOT_KINDS = ['student', 'faculty'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** 教員相談は全学1本の列なので、枠も1つだけ */
export const FACULTY_SLOT_ID = 'faculty';

/** 試行制限（V-01・S-01）。窓はいずれも10分。失敗した回数だけ数える */
export const RATE_LIMITS = {
  entryPerDevice: { windowSeconds: 600, max: 5 },
  entryPerIp: { windowSeconds: 600, max: 50 },
  staffPerDevice: { windowSeconds: 600, max: 3 },
} as const;

/** TTL（expireAt）は閉場からこの時間後。閉場＋1時間の削除が漏れた場合の保険 */
export const TTL_AFTER_CLOSE_HOURS = 2;
