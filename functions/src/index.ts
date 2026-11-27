// Cloud Functions の入口。本体は core/ にあり、ここでは認証情報の取り出しと秘密の値の受け渡しだけを行う。
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineBoolean, defineInt, defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { beforeUserCreated } from 'firebase-functions/v2/identity';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION, ROLES, type Role } from '@nt/shared';
import { isAnonymousSignUp } from './core/auth.js';
import { clientIp, type Caller, type Deps } from './core/context.js';
import * as admin from './core/admin.js';
import { getTodayFirestoreReads, setHotInstances } from './core/gcpOps.js';
import * as operators from './core/operators.js';
import { tick } from './core/scheduler.js';
import * as staff from './core/staff.js';
import * as visitor from './core/visitor.js';

initializeApp();
// 20 関数すべてが既定の 1 vCPU だと Cloud Run のリージョン CPU クォータ（20 vCPU）に当たるため、
// 通常関数は 0.25 vCPU（concurrency 1）にし、負荷の高い発券・呼出（hot）だけ 1 vCPU（concurrency 80）にする。
setGlobalOptions({ region: REGION, maxInstances: 10, cpu: 0.25, concurrency: 1 });

/** IP の HMAC の鍵（V-01）。Secret Manager に置く。Emulator では functions/.secret.local か既定値 */
const RATE_LIMIT_SECRET = defineSecret('RATE_LIMIT_SECRET');
const EMULATOR_SECRET = 'emulator-only-rate-limit-secret';
const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

/**
 * App Check の強制（設計書 4章）。functions/.env.<プロジェクト> で切り替える（docs/p4-integration.md）。
 * 既定は false: 画面に App Check を入れてトークンが付くのを確かめてから true にする。負荷テストの間も false
 */
const ENFORCE_APP_CHECK = defineBoolean('ENFORCE_APP_CHECK', { default: false });
/**
 * 発券・呼出を常駐させる台数（設計書 4章「開催日は minInstances 1」）。
 * 待機中も課金されるので、開催日（とリハーサル・負荷テスト）の前に 1 にしてデプロイし、終わったら 0 に戻す
 */
const HOT_INSTANCES = defineInt('HOT_INSTANCES', { default: 0 });

function rateLimitSecret(): string {
  const value = RATE_LIMIT_SECRET.value();
  if (value) return value;
  if (isEmulator) return EMULATOR_SECRET;
  // Fail-Fast（設計書 4章）: 本番で秘密の値がなければ処理しない
  throw new HttpsError('internal', 'RATE_LIMIT_SECRET is not set');
}

function deps(): Deps {
  return {
    db: getFirestore(),
    auth: getAuth(),
    rateLimitSecret,
    now: () => new Date(),
    ...(isEmulator ? {} : { setHotInstances, getTodayFirestoreReads }),
  };
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
    opId: typeof t.opId === 'string' ? t.opId : null,
    opVersion: typeof t.opv === 'number' ? t.opv : null,
    authTime: typeof t.auth_time === 'number' ? t.auth_time : null,
    ip: clientIp(req.rawRequest.headers['x-forwarded-for']),
  };
}

type Handler<Req, Res> = (deps: Deps, caller: Caller | null, req: Req) => Promise<Res>;

function callable<Req, Res>(handler: Handler<Req, Res>, opts: { secret?: boolean; hot?: boolean } = {}) {
  return onCall<Req, Promise<Res>>(
    {
      secrets: opts.secret ? [RATE_LIMIT_SECRET] : [],
      enforceAppCheck: ENFORCE_APP_CHECK,
      ...(opts.hot ? { cpu: 1, concurrency: 80, minInstances: HOT_INSTANCES } : {}),
    },
    (req) =>
      handler(deps(), callerOf(req), req.data),
  );
}

// ---- 来場者 -------------------------------------------------------------------

export const enterEvent = callable(visitor.enterEvent, { secret: true });
export const issueTicket = callable(visitor.issueTicket, { hot: true });
export const cancelTicket = callable(visitor.cancelTicket);
export const markArriving = callable(visitor.markArriving);

// ---- スタッフ -----------------------------------------------------------------

export const staffLogin = callable(staff.staffLogin, { secret: true });
export const claimSlot = callable(staff.claimSlot);
export const setBooth = callable(staff.setBooth);
export const releaseAssignment = callable(staff.releaseAssignment);
export const heartbeat = callable(staff.heartbeat);
export const callNext = callable(staff.callNext, { hot: true });
export const startConsult = callable(staff.startConsult);
export const completeConsult = callable(staff.completeConsult);
export const skipTicket = callable(staff.skipTicket);
export const returnTicket = callable(staff.returnTicket);
export const setSlotPaused = callable(staff.setSlotPaused);
export const setQueueLimit = callable(staff.setQueueLimit);

// ---- 管理者 -------------------------------------------------------------------

/** A-01〜A-07。op で振り分ける（shared の AdminRequest） */
export const adminApi = callable(admin.admin);
/** 運営ID＋パスワードのログイン。カスタムトークンを返す（未ログインで呼べる） */
export const operatorLogin = callable(operators.operatorLogin, { secret: true });

// ---- 定期処理（3.4） -----------------------------------------------------------

/**
 * 1分ごと: 開場・閉場、スキップの復帰期限切れ、閉場＋1時間の削除。
 * 失敗しても次の回でやり直せるように書いてあるので、再試行はしない（retryCount 0）。
 */
export const scheduledTick = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Asia/Tokyo', retryCount: 0, timeoutSeconds: 300 },
  async () => {
    const res = await tick(deps());
    if (res.opened.length + res.closed.length + res.purged.length + res.expiredSkipped > 0 || res.hotInstances !== null) {
      console.log('tick', JSON.stringify(res));
    }
  },
);

// ---- 認証 ---------------------------------------------------------------------

/** 新規登録は匿名のみ（設計書 4章）。それ以外の新規登録は拒否する */
export const beforeCreate = beforeUserCreated((event) => {
  if (!isAnonymousSignUp(event.data)) {
    throw new HttpsError('permission-denied', 'sign-up is not allowed');
  }
});
