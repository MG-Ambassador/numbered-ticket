import { Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { ACTIVE_TICKET_STATES, TTL_AFTER_CLOSE_HOURS, type EventDoc, type TicketState } from '@nt/shared';
import { fail } from './errors.js';

export const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const TICKET_ID = /^[A-Za-z0-9]{1,64}$/;

/** TTL（expireAt）。閉場＋TTL_AFTER_CLOSE_HOURS */
export function expireAtFor(event: EventDoc): Timestamp {
  return Timestamp.fromMillis(event.closesAt.toMillis() + TTL_AFTER_CLOSE_HOURS * 3600_000);
}

export async function getOrFail<T>(tx: Transaction, ref: DocumentReference): Promise<T> {
  const snap = await tx.get(ref);
  if (!snap.exists) fail('not-found', 'notFound');
  return snap.data() as T;
}

export function isActive(state: TicketState): boolean {
  return (ACTIVE_TICKET_STATES as readonly TicketState[]).includes(state);
}

export function ticketIdOf(req: { ticketId?: unknown } | null | undefined): string {
  const id = req?.ticketId;
  if (typeof id !== 'string' || !TICKET_ID.test(id)) fail('invalid-argument', 'invalidInput');
  return id;
}

/** 区切りのハイフン・空白を取り除き、digits 桁の数字なら返す */
export function normalizeCode(raw: unknown, digits: number): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${digits}}$`).test(code) ? code : null;
}

const TX_ROUNDS = 4;
const ABORTED = 10;
const INVALID_ARGUMENT = 3;

function isRetryable(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  if (err.code === ABORTED) return true;
  // Emulator はロック待ちが長いとトランザクションを閉じ、SDK はこれを再試行しない（コミットはされていない）
  return err.code === INVALID_ARGUMENT && /Transaction is invalid or closed/.test(String(err.message));
}

/**
 * db.runTransaction に再試行を足したもの。
 * SDK 自身の再試行（maxAttempts）を使い切った競合も、間を空けて TX_ROUNDS 回まで試し直す。
 * それでも通らなければ contention（aborted）で返す。画面は少し待って再送してよい。
 * 関数の中で投げた HttpsError（満員など）は再試行せずにそのまま返す。
 */
export async function runTx<T>(db: Firestore, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let round = 1; ; round++) {
    try {
      return await db.runTransaction(fn, { maxAttempts: 10 });
    } catch (e) {
      if (e instanceof HttpsError || !isRetryable(e)) throw e;
      if (round >= TX_ROUNDS) fail('aborted', 'contention');
      await new Promise((r) => setTimeout(r, 50 * 2 ** round + Math.random() * 100));
    }
  }
}
