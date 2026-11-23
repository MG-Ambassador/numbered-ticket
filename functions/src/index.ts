// Cloud Functions の入口。本体は core/ にあり、ここでは認証情報の取り出しと秘密の値の受け渡しだけを行う。
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { beforeUserCreated } from 'firebase-functions/v2/identity';
import { REGION, ROLES, type Role } from '@nt/shared';
import { isAnonymousSignUp } from './core/auth.js';
import { clientIp, type Caller, type Deps } from './core/context.js';
import * as visitor from './core/visitor.js';

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

/** IP の HMAC の鍵（V-01）。Secret Manager に置く。Emulator では functions/.secret.local か既定値 */
const RATE_LIMIT_SECRET = defineSecret('RATE_LIMIT_SECRET');
const EMULATOR_SECRET = 'emulator-only-rate-limit-secret';
const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

function rateLimitSecret(): string {
  const value = RATE_LIMIT_SECRET.value();
  if (value) return value;
  if (isEmulator) return EMULATOR_SECRET;
  // Fail-Fast（設計書 4章）: 本番で秘密の値がなければ処理しない
  throw new HttpsError('internal', 'RATE_LIMIT_SECRET is not set');
}

function deps(): Deps {
  return { db: getFirestore(), auth: getAuth(), rateLimitSecret, now: () => new Date() };
}

function callerOf(req: CallableRequest): Caller | null {
  if (!req.auth) return null;
  const t = req.auth.token;
  const role = typeof t.role === 'string' && (ROLES as readonly string[]).includes(t.role) ? (t.role as Role) : null;
  return {
    uid: req.auth.uid,
    provider: t.firebase?.sign_in_provider ?? '',
    eid: typeof t.eid === 'string' ? t.eid : null,
    role,
    admin: t.admin === true,
    ip: clientIp(req.rawRequest.headers['x-forwarded-for']),
  };
}

type Handler<Req, Res> = (deps: Deps, caller: Caller | null, req: Req) => Promise<Res>;

function callable<Req, Res>(handler: Handler<Req, Res>, opts: { secret?: boolean } = {}) {
  return onCall<Req, Promise<Res>>({ secrets: opts.secret ? [RATE_LIMIT_SECRET] : [] }, (req) =>
    handler(deps(), callerOf(req), req.data),
  );
}

// ---- 来場者 -------------------------------------------------------------------

export const enterEvent = callable(visitor.enterEvent, { secret: true });
export const issueTicket = callable(visitor.issueTicket);
export const cancelTicket = callable(visitor.cancelTicket);
export const markArriving = callable(visitor.markArriving);

// ---- 認証 ---------------------------------------------------------------------

/** 新規登録は匿名のみ（設計書 4章）。それ以外の新規登録は拒否する */
export const beforeCreate = beforeUserCreated((event) => {
  if (!isAnonymousSignUp(event.data)) {
    throw new HttpsError('permission-denied', 'sign-up is not allowed');
  }
});
