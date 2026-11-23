// 試行制限（V-01・S-01）。明学の質問箱 server/src/rate-limit.ts と同じ方式:
// 値（uid・IP）は HMAC-SHA256 でハッシュにしてから保存し、TTL（expireAt）で消す。
// 失敗した試行だけを数える（会場の Wi-Fi で大勢が同じ IP から正しいコードを入れても止まらないように）。
import { createHmac } from 'node:crypto';
import { Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { paths, type RateLimitDoc } from '@nt/shared';

const KEY_VERSION = 'v1';

export interface RateLimitPolicy {
  readonly windowSeconds: number;
  readonly max: number;
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function rateLimitRef(db: Firestore, eid: string, secret: string, scope: string, value: string): DocumentReference {
  return db.doc(paths.rateLimit(eid, `${scope}_${KEY_VERSION}_${hmac(secret, `${scope}:${value}`)}`));
}

export interface RateLimitState {
  ref: DocumentReference;
  policy: RateLimitPolicy;
  /** 窓の期間内の失敗時刻（古い順） */
  failures: Timestamp[];
}

/** トランザクション内で読む（書き込みは recordFailure で行う） */
export async function readRateLimit(
  tx: Transaction,
  ref: DocumentReference,
  policy: RateLimitPolicy,
  now: Date,
): Promise<RateLimitState> {
  const snap = await tx.get(ref);
  const cutoff = now.getTime() - policy.windowSeconds * 1000;
  const raw = snap.exists ? ((snap.data() as RateLimitDoc).failures ?? []) : [];
  const failures = raw
    .filter((t): t is Timestamp => t instanceof Timestamp && t.toMillis() > cutoff)
    .sort((a, b) => a.toMillis() - b.toMillis());
  return { ref, policy, failures };
}

/** 上限に達していれば、あと何秒待てばよいかを返す。達していなければ null */
export function retryAfterSeconds(state: RateLimitState, now: Date): number | null {
  if (state.failures.length < state.policy.max) return null;
  const oldest = state.failures[state.failures.length - state.policy.max]!;
  return Math.max(1, Math.ceil((oldest.toMillis() + state.policy.windowSeconds * 1000 - now.getTime()) / 1000));
}

export function recordFailure(tx: Transaction, state: RateLimitState, now: Date): void {
  const failures = [...state.failures, Timestamp.fromDate(now)].slice(-state.policy.max);
  const doc: RateLimitDoc = {
    failures,
    expireAt: Timestamp.fromMillis(now.getTime() + state.policy.windowSeconds * 1000),
  };
  tx.set(state.ref, doc);
}
