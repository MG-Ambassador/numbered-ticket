// 運営アカウント（管理者）の認証・権限・アカウント管理。明学の質問箱（meigaku-question-box）の
// server/src/{operators,auth,sessions,permissions}.ts と同じ体系を、Firebase のカスタムトークンの上に載せたもの。
//
// - ログイン: 運営ID＋パスワード（scrypt）。成功したらカスタムトークン（クレーム admin / opId / opv）を返し、
//   画面は signInWithCustomToken で Firebase にログインする。ルール・Storage・callable はこのトークンで動く
// - 8時間で失効（延長なし）。ログイン時刻は ID トークンの auth_time（更新しても変わらない）
// - アカウントの version を進めると、そのアカウントの全ログインが次の操作から無効になる
//   （callable は毎回 operators/{opId} を読んで照合、ルールも同じ照合をする）
// - 仮パスワードのまま（mustChange）の間は、自分の情報の取得とパスワード変更しかできない
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import {
  ADMIN_OP_PERMISSIONS,
  OPERATOR_ROLES,
  OPERATOR_SESSION_SECONDS,
  paths,
  can,
  manageableRoles,
  normalizeLoginId,
  normalizeRole,
  passwordValid,
  type AdminOp,
  type AdminRequest,
  type CreateOperatorResponse,
  type OperatorActionResponse,
  type OperatorAuditDoc,
  type OperatorDoc,
  type OperatorIdentity,
  type OperatorLoginRequest,
  type OperatorLoginResponse,
  type OperatorRole,
  type OperatorSummary,
} from '@nt/shared';
import type { Caller, Deps } from './context.js';
import { fail } from './errors.js';
import { generateTemporaryPassword, hashPassword, verifyPassword } from './password.js';
import { hmac, readRateLimit, recordFailure, retryAfterSeconds, type RateLimitPolicy } from './rateLimit.js';

/** 質問箱と同じ。ログインの試行は成否にかかわらず数える */
export const LOGIN_IP_LIMIT: RateLimitPolicy = { windowSeconds: 10 * 60, max: 30 };
export const LOGIN_ID_LIMIT: RateLimitPolicy = { windowSeconds: 15 * 60, max: 10 };

const CUSTOM_TOKEN_UID_PREFIX = 'op_';
const DISPLAY_NAME_MAX = 40;

export function operatorUid(loginId: string): string {
  return `${CUSTOM_TOKEN_UID_PREFIX}${loginId}`;
}

function identityOf(op: OperatorDoc): OperatorIdentity {
  return { loginId: op.loginId, displayName: op.displayName, role: normalizeRole(op.role), mustChange: op.mustChange === true };
}

async function issueToken(deps: Deps, op: OperatorDoc): Promise<string> {
  return deps.auth.createCustomToken(operatorUid(op.loginId), { admin: true, opId: op.loginId, opv: op.version });
}

function auditRef(db: Firestore): DocumentReference {
  return db.collection(paths.operatorAudit).doc();
}

function auditDoc(actor: string, action: string, target: string, version: number, now: Date): OperatorAuditDoc {
  return { at: Timestamp.fromDate(now), actor, action, target, version };
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

/** 運営ID＋パスワードでログインし、カスタムトークンを返す。未ログインで呼べる（匿名でも可） */
export async function operatorLogin(deps: Deps, caller: Caller | null, req: OperatorLoginRequest): Promise<OperatorLoginResponse> {
  if (!req || typeof req.loginId !== 'string' || typeof req.password !== 'string' || req.password.length > 1024) fail('invalid-argument', 'invalidInput');
  const { db } = deps;
  const now = deps.now();
  const secret = deps.rateLimitSecret();
  const loginId = normalizeLoginId(req.loginId);

  const ipRef = db.doc(paths.authRateLimit(`auth-ip_v1_${hmac(secret, caller?.ip ?? 'unknown')}`));
  const idRef = loginId ? db.doc(paths.authRateLimit(`auth-id_v1_${hmac(secret, loginId)}`)) : null;
  const operatorRef = loginId ? db.doc(paths.operator(loginId)) : null;

  const outcome = await db.runTransaction(async (tx) => {
    const ip = await readRateLimit(tx, ipRef, LOGIN_IP_LIMIT, now);
    const id = idRef ? await readRateLimit(tx, idRef, LOGIN_ID_LIMIT, now) : null;
    const snap = operatorRef ? await tx.get(operatorRef) : null;
    const waits = [retryAfterSeconds(ip, now), id ? retryAfterSeconds(id, now) : null].filter((w): w is number => w !== null);
    if (waits.length > 0) return { retryAfter: Math.max(...waits), operator: null };
    recordFailure(tx, ip, now);
    if (id) recordFailure(tx, id, now);
    return { retryAfter: null, operator: snap?.exists ? (snap.data() as OperatorDoc) : null };
  });
  if (outcome.retryAfter !== null) fail('resource-exhausted', 'rateLimited', { retryAfterSeconds: outcome.retryAfter });

  const operator = outcome.operator;
  const valid = await verifyPassword(req.password, operator?.passwordHash);
  if (!valid || !loginId || !operator || operator.active !== true) fail('unauthenticated', 'invalidCredentials');
  return { token: await issueToken(deps, operator), identity: identityOf(operator) };
}

// ---------------------------------------------------------------------------
// 呼び出し元の確認（adminApi の入口）
// ---------------------------------------------------------------------------

export interface OperatorContext {
  loginId: string;
  role: OperatorRole;
  operator: OperatorDoc;
}

/** adminApi の入口。ログインの有効性・仮パスワード・ロールの権限を確かめる */
export async function authorizeOperator(deps: Deps, caller: Caller | null, op: AdminOp): Promise<OperatorContext> {
  if (!caller) fail('unauthenticated', 'forbidden');
  if (!caller.admin || caller.provider !== 'custom' || !caller.opId || caller.opVersion === null || caller.authTime === null) fail('permission-denied', 'forbidden');
  if (deps.now().getTime() >= (caller.authTime + OPERATOR_SESSION_SECONDS) * 1000) fail('permission-denied', 'sessionExpired');

  const snap = await deps.db.doc(paths.operator(caller.opId)).get();
  const operator = snap.exists ? (snap.data() as OperatorDoc) : null;
  if (!operator || operator.active !== true || operator.version !== caller.opVersion) fail('permission-denied', 'sessionExpired');

  if (operator.mustChange === true && op !== 'me' && op !== 'changePassword') fail('permission-denied', 'passwordChangeRequired');
  const role = normalizeRole(operator.role);
  const needed = ADMIN_OP_PERMISSIONS[op];
  if (needed === undefined) fail('invalid-argument', 'invalidInput');
  if (needed !== null && !can(role, needed)) fail('permission-denied', 'forbidden');
  return { loginId: operator.loginId, role, operator };
}

// ---------------------------------------------------------------------------
// 自分の情報・パスワード変更
// ---------------------------------------------------------------------------

export function me(ctx: OperatorContext): OperatorIdentity {
  return identityOf(ctx.operator);
}

export async function changePassword(
  deps: Deps,
  ctx: OperatorContext,
  req: Extract<AdminRequest, { op: 'changePassword' }>,
): Promise<OperatorLoginResponse> {
  if (typeof req.currentPassword !== 'string' || typeof req.newPassword !== 'string' || req.currentPassword.length > 1024) fail('invalid-argument', 'invalidInput');
  if (!passwordValid(req.newPassword) || req.newPassword === req.currentPassword) fail('invalid-argument', 'passwordPolicy');
  if (!(await verifyPassword(req.currentPassword, ctx.operator.passwordHash))) fail('permission-denied', 'invalidCredentials');

  const { db } = deps;
  const now = deps.now();
  const passwordHash = await hashPassword(req.newPassword);
  const ref = db.doc(paths.operator(ctx.loginId));
  const next = await db.runTransaction(async (tx) => {
    const latest = (await tx.get(ref)).data() as OperatorDoc | undefined;
    // 確認から書き込みの間に、別の操作でアカウントが変わっていたら失敗させる
    if (!latest || latest.active !== true || latest.version !== ctx.operator.version) fail('permission-denied', 'sessionExpired');
    const version = latest.version + 1;
    const doc: OperatorDoc = { ...latest, passwordHash, mustChange: false, version, updatedAt: Timestamp.fromDate(now) };
    tx.update(ref, { passwordHash, mustChange: false, version, updatedAt: doc.updatedAt });
    tx.set(auditRef(db), auditDoc(ctx.loginId, 'operator_password_change', ctx.loginId, version, now));
    return doc;
  });
  return { token: await issueToken(deps, next), identity: identityOf(next) };
}

// ---------------------------------------------------------------------------
// アカウント管理（accounts.manage）
// ---------------------------------------------------------------------------

export async function listOperators(deps: Deps): Promise<OperatorSummary[]> {
  const snap = await deps.db.collection(paths.operators).get();
  return snap.docs
    .map((d) => d.data() as OperatorDoc)
    .map((o) => ({ loginId: o.loginId, displayName: o.displayName, role: normalizeRole(o.role), active: o.active === true, mustChange: o.mustChange === true }))
    .sort((a, b) => a.loginId.localeCompare(b.loginId));
}

function displayNameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > DISPLAY_NAME_MAX) fail('invalid-argument', 'invalidInput');
  return name;
}

function roleOf(value: unknown): OperatorRole {
  if (!(OPERATOR_ROLES as readonly unknown[]).includes(value)) fail('invalid-argument', 'invalidInput');
  return value as OperatorRole;
}

/** 作成。仮パスワードは一度だけ返す（保存するのはハッシュのみ） */
export async function createOperator(
  deps: Deps,
  ctx: OperatorContext,
  req: Extract<AdminRequest, { op: 'createOperator' }>,
): Promise<CreateOperatorResponse> {
  const loginId = normalizeLoginId(req.loginId);
  if (!loginId) fail('invalid-argument', 'invalidInput');
  const displayName = displayNameOf(req.displayName);
  const role = roleOf(req.role);
  if (!manageableRoles(ctx.role).includes(role)) fail('permission-denied', 'forbidden');

  const { db } = deps;
  const now = deps.now();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const ref = db.doc(paths.operator(loginId));
  const created = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    const stamp = Timestamp.fromDate(now);
    const doc: OperatorDoc = { loginId, displayName, role, passwordHash, active: true, mustChange: true, version: 1, createdAt: stamp, updatedAt: stamp };
    tx.set(ref, doc);
    tx.set(auditRef(db), auditDoc(ctx.loginId, 'operator_create', loginId, 1, now));
    return true;
  });
  if (!created) fail('already-exists', 'operatorExists');
  return { loginId, displayName, temporaryPassword };
}

/** 再発行（reset）・利用停止（disable）・利用再開（enable）。version を進めて対象者のログインを全部無効にする */
export async function operatorAction(
  deps: Deps,
  ctx: OperatorContext,
  req: Extract<AdminRequest, { op: 'operatorAction' }>,
): Promise<OperatorActionResponse> {
  const loginId = normalizeLoginId(req.loginId);
  if (!loginId) fail('not-found', 'operatorNotFound');
  if (req.action !== 'reset' && req.action !== 'disable' && req.action !== 'enable') fail('invalid-argument', 'invalidInput');
  if (loginId === ctx.loginId) fail('invalid-argument', 'selfOperation');

  const { db } = deps;
  const now = deps.now();
  const temporaryPassword = req.action === 'reset' ? generateTemporaryPassword() : undefined;
  const passwordHash = temporaryPassword ? await hashPassword(temporaryPassword) : undefined;
  const ref = db.doc(paths.operator(loginId));
  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'operatorNotFound');
    const current = snap.data() as OperatorDoc;
    if (!manageableRoles(ctx.role).includes(normalizeRole(current.role))) fail('permission-denied', 'forbidden');
    const version = current.version + 1;
    const patch: Partial<OperatorDoc> = { version, updatedAt: Timestamp.fromDate(now) };
    if (req.action === 'reset') Object.assign(patch, { passwordHash, mustChange: true });
    if (req.action === 'disable') patch.active = false;
    if (req.action === 'enable') patch.active = true;
    tx.update(ref, patch);
    tx.set(auditRef(db), auditDoc(ctx.loginId, `operator_${req.action}`, loginId, version, now));
    return { ...current, ...patch } as OperatorDoc;
  });
  return { loginId, active: updated.active === true, mustChange: updated.mustChange === true, ...(temporaryPassword ? { temporaryPassword } : {}) };
}

/** ロール変更。変更前・変更後のどちらのロールも操作者が管理できる範囲に限る。対象者は再ログインになる */
export async function setOperatorRole(
  deps: Deps,
  ctx: OperatorContext,
  req: Extract<AdminRequest, { op: 'setOperatorRole' }>,
): Promise<{ loginId: string; role: OperatorRole }> {
  const loginId = normalizeLoginId(req.loginId);
  if (!loginId) fail('not-found', 'operatorNotFound');
  const role = roleOf(req.role);
  if (loginId === ctx.loginId) fail('invalid-argument', 'selfOperation');
  const allowed = manageableRoles(ctx.role);
  if (!allowed.includes(role)) fail('permission-denied', 'forbidden');

  const { db } = deps;
  const now = deps.now();
  const ref = db.doc(paths.operator(loginId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'operatorNotFound');
    const current = snap.data() as OperatorDoc;
    const currentRole = normalizeRole(current.role);
    if (!allowed.includes(currentRole)) fail('permission-denied', 'forbidden');
    if (currentRole === role) return;
    const version = current.version + 1;
    tx.update(ref, { role, version, updatedAt: Timestamp.fromDate(now) });
    tx.set(auditRef(db), auditDoc(ctx.loginId, `operator_role_${currentRole}_to_${role}`, loginId, version, now));
  });
  return { loginId, role };
}
