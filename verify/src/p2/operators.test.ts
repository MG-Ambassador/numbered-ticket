// 運営アカウント（明学の質問箱と同じ体系）: ログイン・試行制限・パスワード変更・ロールごとの権限・アカウント管理
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_OP_PERMISSIONS,
  OPERATOR_ROLES,
  can,
  manageableRoles,
  paths,
  type AdminRequest,
  type OperatorActionResponse,
  type OperatorAuditDoc,
  type OperatorDoc,
  type OperatorLoginResponse,
  type OperatorRole,
  type OperatorSummary,
  type CreateOperatorResponse,
} from '@nt/shared';
import { admin } from '../../../functions/src/core/admin.js';
import { operatorLogin } from '../../../functions/src/core/operators.js';
import { verifyPassword } from '../../../functions/src/core/password.js';
import { OPERATOR_PASSWORD, NOW, adminCaller, anonymous, clearFirestore, db, expectReason, makeDeps, read, seedEvent, seedOperator } from './fixture.js';

const deps = makeDeps();
const NEW_PASSWORD = 'a-brand-new-passphrase';

const login = (loginId: string, password: string, ip = '198.51.100.7', d = deps) => operatorLogin(d, anonymous('x', ip), { loginId, password });
const as = <T = unknown>(loginId: string, req: AdminRequest, over = {}) => admin(deps, adminCaller(loginId, over), req) as Promise<T>;
const operator = (loginId: string) => read<OperatorDoc>(paths.operator(loginId));
const auditActions = async () =>
  (await db.collection(paths.operatorAudit).get()).docs.map((d) => (d.data() as OperatorAuditDoc).action).sort();

beforeEach(async () => {
  await clearFirestore();
});

describe('ロールと権限（shared/roles.ts）', () => {
  it('ロールごとの権限は質問箱と同じ形（開発者・責任者は全部、スタッフは確認と受付の切り替えだけ）', () => {
    expect(OPERATOR_ROLES).toEqual(['developer', 'owner', 'faculty', 'ambassador', 'staff']);
    for (const r of ['developer', 'owner'] as const) expect(can(r, 'accounts.manage')).toBe(true);
    for (const r of ['faculty', 'ambassador', 'staff'] as const) expect(can(r, 'accounts.manage')).toBe(false);
    for (const r of ['faculty', 'ambassador'] as const) {
      for (const p of ['event.view', 'event.toggle', 'event.operate', 'event.manage', 'codes.manage'] as const) expect(can(r, p)).toBe(true);
    }
    expect(can('staff', 'event.view')).toBe(true);
    expect(can('staff', 'event.toggle')).toBe(true);
    for (const p of ['event.operate', 'event.manage', 'codes.manage', 'accounts.manage'] as const) expect(can('staff', p)).toBe(false);
    // 不明な値は最も弱いスタッフ
    expect(can('operator', 'event.manage')).toBe(false);
    expect(can(undefined, 'event.view')).toBe(true);
    expect(manageableRoles('developer')).toEqual([...OPERATOR_ROLES]);
    expect(manageableRoles('owner')).toEqual(['faculty', 'ambassador', 'staff']);
    expect(manageableRoles('faculty')).toEqual([]);
  });

  it('すべての op に必要な権限が決まっている', () => {
    expect(ADMIN_OP_PERMISSIONS.viewCodes).toBe('codes.manage');
    expect(ADMIN_OP_PERMISSIONS.createEvent).toBe('event.manage');
    expect(ADMIN_OP_PERMISSIONS.openEvent).toBe('event.operate');
    expect(ADMIN_OP_PERMISSIONS.setGlobalPaused).toBe('event.toggle');
    expect(ADMIN_OP_PERMISSIONS.createOperator).toBe('accounts.manage');
    expect(ADMIN_OP_PERMISSIONS.me).toBeNull();
  });

  it('adminApi はロールの権限がない op を forbidden にする', async () => {
    await seedEvent();
    await seedOperator('stf', { role: 'staff' });
    await seedOperator('fac', { role: 'faculty' });
    await seedOperator('own', { role: 'owner' });
    // スタッフ: 確認と受付の切り替えはできるが、コード・開場・編集・アカウント管理はできない
    await as('stf', { op: 'dashboard', eid: 'e1' });
    await as('stf', { op: 'setGlobalPaused', eid: 'e1', paused: true });
    for (const req of [
      { op: 'viewCodes', eid: 'e1' },
      { op: 'openEvent', eid: 'e1' },
      { op: 'forceRelease', eid: 'e1', slotId: 's1', staffUid: 'u' },
      { op: 'deleteSlot', eid: 'e1', slotId: 's1' },
      { op: 'listOperators' },
    ] as AdminRequest[]) {
      await expectReason(as('stf', req), 'forbidden');
    }
    // 教員: コード・編集はできるが、アカウント管理はできない
    await as('fac', { op: 'viewCodes', eid: 'e1' });
    await expectReason(as('fac', { op: 'listOperators' }), 'forbidden');
    await expectReason(as('fac', { op: 'createOperator', loginId: 'x-user', displayName: 'x', role: 'staff' }), 'forbidden');
    // 責任者: アカウント管理ができる
    await as('own', { op: 'listOperators' });
  });
});

describe('ログイン', () => {
  it('運営ID＋パスワードで入れる。運営IDの大文字小文字は区別しない。トークンのクレームに opId・opv が入る', async () => {
    await seedOperator('Tester-1'.toLowerCase(), { role: 'faculty', displayName: '山田', version: 4 });
    const res = await login('TESTER-1', OPERATOR_PASSWORD);
    expect(res.identity).toEqual({ loginId: 'tester-1', displayName: '山田', role: 'faculty', mustChange: false });
    const decoded = await deps.auth.verifyIdToken((await exchange(res.token)).idToken).catch(() => null);
    // Auth Emulator ではカスタムトークンを ID トークンに交換して、クレームを確かめる
    expect(decoded).toMatchObject({ admin: true, opId: 'tester-1', opv: 4, uid: 'op_tester-1' });
    expect(decoded?.firebase.sign_in_provider).toBe('custom');
  });

  it('違うパスワード・登録のない ID・停止中は、どれも同じ invalidCredentials', async () => {
    await seedOperator('tester');
    await seedOperator('off', { active: false });
    await expectReason(login('tester', 'wrong-password-value'), 'invalidCredentials');
    await expectReason(login('nobody', OPERATOR_PASSWORD), 'invalidCredentials');
    await expectReason(login('off', OPERATOR_PASSWORD), 'invalidCredentials');
    await expectReason(login('x', OPERATOR_PASSWORD), 'invalidCredentials');
    await expectReason(login('', OPERATOR_PASSWORD), 'invalidCredentials');
  });

  it('運営IDごとに15分10回まで（成否にかかわらず数える）。IP ごとに10分30回まで', async () => {
    await seedOperator('tester');
    for (let i = 0; i < 10; i++) await expectReason(login('tester', `wrong-password-${i}`, `198.51.100.${i + 1}`), 'invalidCredentials');
    // 11回目は、正しいパスワードでも止まる
    const err = await expectReason(login('tester', OPERATOR_PASSWORD, '198.51.100.99'), 'rateLimited');
    expect(err.details?.retryAfterSeconds).toBeGreaterThan(0);

    for (let i = 0; i < 30; i++) await login(`user-${i % 25}`, 'wrong-password-value', '203.0.113.50').catch(() => {});
    await expectReason(login('another', 'wrong-password-value', '203.0.113.50'), 'rateLimited');
    // 別の IP・別の ID は影響を受けない
    await seedOperator('other');
    await login('other', OPERATOR_PASSWORD, '203.0.113.51');
  });

  it('パスワードのハッシュは質問箱と同じ形式（scrypt）で、平文は保存しない', async () => {
    await seedOperator('tester');
    const doc = await operator('tester');
    expect(doc.passwordHash).toMatch(/^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(JSON.stringify(doc)).not.toContain(OPERATOR_PASSWORD);
    expect(await verifyPassword(OPERATOR_PASSWORD, doc.passwordHash)).toBe(true);
    expect(await verifyPassword('wrong', doc.passwordHash)).toBe(false);
  });
});

describe('初回のパスワード変更', () => {
  it('仮パスワードのままでは、自分の情報の取得とパスワード変更だけできる', async () => {
    await seedOperator('newbie', { mustChange: true, password: 'temporary-password-xyz' });
    await seedEvent();
    expect(await as<{ mustChange: boolean }>('newbie', { op: 'me' })).toMatchObject({ mustChange: true, loginId: 'newbie' });
    await expectReason(as('newbie', { op: 'dashboard', eid: 'e1' }), 'passwordChangeRequired');
    await expectReason(as('newbie', { op: 'listOperators' }), 'passwordChangeRequired');

    const res = await as<OperatorLoginResponse>('newbie', { op: 'changePassword', currentPassword: 'temporary-password-xyz', newPassword: NEW_PASSWORD });
    expect(res.identity.mustChange).toBe(false);
    const doc = await operator('newbie');
    expect(doc).toMatchObject({ mustChange: false, version: 2 });
    expect(await verifyPassword(NEW_PASSWORD, doc.passwordHash)).toBe(true);

    // 変更前のログイン（version 1）は無効、新しいログイン（version 2）は使える
    await expectReason(as('newbie', { op: 'me' }), 'sessionExpired');
    await as('newbie', { op: 'dashboard', eid: 'e1' }, { opVersion: 2 });
    await login('newbie', NEW_PASSWORD);
    expect(await auditActions()).toEqual(['operator_password_change']);
  });

  it('現在のパスワードが違う・15文字未満・現在と同じ・128文字超は拒否', async () => {
    await seedOperator('tester');
    await expectReason(as('tester', { op: 'changePassword', currentPassword: 'wrong-current-value', newPassword: NEW_PASSWORD }), 'invalidCredentials');
    await expectReason(as('tester', { op: 'changePassword', currentPassword: OPERATOR_PASSWORD, newPassword: 'short-pass-14c' }), 'passwordPolicy');
    await expectReason(as('tester', { op: 'changePassword', currentPassword: OPERATOR_PASSWORD, newPassword: OPERATOR_PASSWORD }), 'passwordPolicy');
    await expectReason(as('tester', { op: 'changePassword', currentPassword: OPERATOR_PASSWORD, newPassword: 'x'.repeat(129) }), 'passwordPolicy');
    expect((await operator('tester')).version).toBe(1);
  });
});

describe('アカウント管理', () => {
  beforeEach(async () => {
    await seedOperator('dev', { role: 'developer' });
    await seedOperator('own', { role: 'owner' });
  });

  it('作成: 仮パスワードを一度だけ返し、ハッシュだけ保存する。初回は仮パスワードの変更が必要', async () => {
    const res = await as<CreateOperatorResponse>('own', { op: 'createOperator', loginId: 'New-Staff', displayName: '新人', role: 'staff' });
    expect(res.loginId).toBe('new-staff');
    expect(res.temporaryPassword.length).toBeGreaterThanOrEqual(24);
    const doc = await operator('new-staff');
    expect(doc).toMatchObject({ role: 'staff', active: true, mustChange: true, version: 1, displayName: '新人' });
    expect(JSON.stringify(doc)).not.toContain(res.temporaryPassword);
    expect((await login('new-staff', res.temporaryPassword)).identity.mustChange).toBe(true);
    expect(await auditActions()).toEqual(['operator_create']);
  });

  it('作成の制限: 同じ ID は不可。不正な ID・名前・ロールは不可。責任者は開発者・責任者を作れない', async () => {
    await as('own', { op: 'createOperator', loginId: 'taro', displayName: '太郎', role: 'faculty' });
    await expectReason(as('own', { op: 'createOperator', loginId: 'TARO', displayName: '太郎2', role: 'faculty' }), 'operatorExists');
    for (const bad of [{ loginId: 'ab' }, { loginId: 'has space' }, { loginId: 'あいう' }, { displayName: '' }, { displayName: 'あ'.repeat(41) }, { role: 'boss' }]) {
      await expectReason(as('own', { op: 'createOperator', loginId: 'valid-id', displayName: '名', role: 'staff', ...bad } as never), 'invalidInput');
    }
    await expectReason(as('own', { op: 'createOperator', loginId: 'big', displayName: '名', role: 'owner' }), 'forbidden');
    await expectReason(as('own', { op: 'createOperator', loginId: 'big', displayName: '名', role: 'developer' }), 'forbidden');
    await as('dev', { op: 'createOperator', loginId: 'big', displayName: '名', role: 'owner' });
  });

  it('再発行・停止・再開は version を進めて、その人のログインを全部無効にする', async () => {
    await seedOperator('taro', { role: 'faculty' });
    const reset = await as<OperatorActionResponse>('own', { op: 'operatorAction', loginId: 'taro', action: 'reset' });
    expect(reset).toMatchObject({ mustChange: true, active: true });
    expect(reset.temporaryPassword).toBeTruthy();
    expect(await operator('taro')).toMatchObject({ version: 2, mustChange: true });
    await expectReason(as('taro', { op: 'me' }), 'sessionExpired');
    expect((await login('taro', reset.temporaryPassword!)).identity.mustChange).toBe(true);
    await expectReason(login('taro', OPERATOR_PASSWORD), 'invalidCredentials');

    expect(await as<OperatorActionResponse>('own', { op: 'operatorAction', loginId: 'taro', action: 'disable' })).toMatchObject({ active: false });
    await expectReason(login('taro', reset.temporaryPassword!), 'invalidCredentials');
    await expectReason(as('taro', { op: 'me' }, { opVersion: 3 }), 'sessionExpired');

    expect(await as<OperatorActionResponse>('own', { op: 'operatorAction', loginId: 'taro', action: 'enable' })).toMatchObject({ active: true });
    expect((await operator('taro')).version).toBe(4);
    expect(await auditActions()).toEqual(['operator_disable', 'operator_enable', 'operator_reset']);
  });

  it('自分自身の停止・再発行・ロール変更はできない。管理できないロールの人も操作できない', async () => {
    await expectReason(as('own', { op: 'operatorAction', loginId: 'own', action: 'disable' }), 'selfOperation');
    await expectReason(as('own', { op: 'operatorAction', loginId: 'own', action: 'reset' }), 'selfOperation');
    await expectReason(as('own', { op: 'setOperatorRole', loginId: 'own', role: 'staff' }), 'selfOperation');
    // 責任者は開発者・責任者のアカウントを変えられない
    await seedOperator('own2', { role: 'owner' });
    await expectReason(as('own', { op: 'operatorAction', loginId: 'dev', action: 'disable' }), 'forbidden');
    await expectReason(as('own', { op: 'operatorAction', loginId: 'own2', action: 'reset' }), 'forbidden');
    await expectReason(as('own', { op: 'setOperatorRole', loginId: 'own2', role: 'staff' }), 'forbidden');
    await expectReason(as('own', { op: 'operatorAction', loginId: 'ghost', action: 'disable' }), 'operatorNotFound');
    // 開発者は責任者を操作できる
    await as('dev', { op: 'operatorAction', loginId: 'own2', action: 'disable' });
  });

  it('ロール変更: 変更前・変更後のどちらも管理できる範囲に限る。変更すると再ログインになる', async () => {
    await seedOperator('taro', { role: 'staff' });
    await as('own', { op: 'setOperatorRole', loginId: 'taro', role: 'faculty' });
    expect(await operator('taro')).toMatchObject({ role: 'faculty', version: 2 });
    await expectReason(as('taro', { op: 'me' }), 'sessionExpired');
    await expectReason(as('own', { op: 'setOperatorRole', loginId: 'taro', role: 'owner' }), 'forbidden');
    // 同じロールへの変更は何もしない（version も進めない）
    await as('own', { op: 'setOperatorRole', loginId: 'taro', role: 'faculty' });
    expect((await operator('taro')).version).toBe(2);
    expect(await auditActions()).toEqual(['operator_role_staff_to_faculty']);
  });

  it('一覧にはパスワードのハッシュを含めない', async () => {
    const list = await as<OperatorSummary[]>('own', { op: 'listOperators' });
    expect(list.map((o) => o.loginId)).toEqual(['dev', 'own']);
    expect(JSON.stringify(list)).not.toContain('scrypt');
    expect(Object.keys(list[0]!).sort()).toEqual(['active', 'displayName', 'loginId', 'mustChange', 'role']);
  });
});

/** Auth Emulator でカスタムトークンを ID トークンに交換する */
async function exchange(customToken: string): Promise<{ idToken: string }> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  return (await res.json()) as { idToken: string };
}

void NOW;
void ({} as OperatorRole);
