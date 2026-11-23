import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Role } from '@nt/shared';
import { fail } from './errors.js';

/** 関数の本体が使う外部の依存。テストでは Emulator につないだものを渡す */
export interface Deps {
  db: Firestore;
  auth: Auth;
  /** RATE_LIMIT_SECRET（HMAC の鍵）。使う関数だけが秘密の値を読むよう関数にしている */
  rateLimitSecret: () => string;
  now: () => Date;
}

/** 呼び出し元。callable の req.auth から作る */
export interface Caller {
  uid: string;
  /** firebase.sign_in_provider */
  provider: string;
  eid: string | null;
  role: Role | null;
  admin: boolean;
  /** X-Forwarded-For の末尾（7.4-3）。取れなければ null */
  ip: string | null;
}

export function requireAnonymous(caller: Caller | null): Caller {
  if (!caller) fail('unauthenticated', 'notAnonymous');
  if (caller.provider !== 'anonymous') fail('permission-denied', 'notAnonymous');
  return caller;
}

export function requireRole(caller: Caller | null, role: Role): Caller & { eid: string } {
  if (!caller) fail('unauthenticated', 'notAnonymous');
  if (caller.role !== role || !caller.eid) fail('permission-denied', 'notAnonymous');
  return caller as Caller & { eid: string };
}

/** X-Forwarded-For の末尾が Google の付けた実 IP（7.4-3）。req.ip は偽装できるので使わない */
export function clientIp(header: string | string[] | undefined): string | null {
  const list = (Array.isArray(header) ? header : header ? [header] : [])
    .flatMap((h) => h.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  let ip = list[list.length - 1];
  if (!ip) return null;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip.toLowerCase();
}

