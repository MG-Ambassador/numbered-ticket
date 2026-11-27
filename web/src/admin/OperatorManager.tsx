// アカウント管理（accounts.manage: 開発者・責任者）。明学の質問箱の「担当者管理」と同じ操作:
// 作成（仮パスワードは一度だけ表示）・再発行・利用停止・再開・ロール変更
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { OPERATOR_ROLES, ROLE_LABELS, manageableRoles, normalizeLoginId, type CreateOperatorResponse, type OperatorActionResponse, type OperatorRole, type OperatorSummary } from '@nt/shared';
import { errorMessage } from '../lib/api';
import { Loading, Notice } from '../ui';
import { useConfirm } from './Confirm';
import type { AdminSession } from './session';

export function OperatorManager({ session }: { session: AdminSession }) {
  const [list, setList] = useState<OperatorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ title: string; loginId: string; password: string } | null>(null);
  const { confirm, element } = useConfirm();
  const allowed = manageableRoles(session.identity.role);

  const load = useCallback(async () => {
    try {
      setList(await session.api<OperatorSummary[]>({ op: 'listOperators' }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    try {
      const res = await fn();
      await load();
      return res;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }

  function action(o: OperatorSummary, kind: 'reset' | 'disable' | 'enable') {
    const label = { reset: '仮パスワードを再発行', disable: '利用を停止', enable: '利用を再開' }[kind];
    confirm({
      title: `${o.displayName}（${o.loginId}）の${label}しますか`,
      body:
        kind === 'enable'
          ? '再開しても、いまのパスワードで入れます。'
          : kind === 'reset'
            ? '新しい仮パスワードを一度だけ表示します。この人のいまのログインはすぐに無効になり、次のログインでパスワードの変更が必要になります。'
            : 'この人のいまのログインはすぐに無効になり、再開するまで入れません。',
      confirmLabel: label,
      danger: kind !== 'enable',
      run: async () => {
        const res = await act(() => session.api<OperatorActionResponse>({ op: 'operatorAction', loginId: o.loginId, action: kind }));
        if (res?.temporaryPassword) setIssued({ title: '仮パスワードを再発行しました', loginId: o.loginId, password: res.temporaryPassword });
      },
    });
  }

  function changeRole(o: OperatorSummary, role: OperatorRole) {
    if (role === o.role) return;
    confirm({
      title: `${o.displayName}（${o.loginId}）を「${ROLE_LABELS[role]}」にしますか`,
      body: 'この人のいまのログインはすぐに無効になり、新しいロールで入り直してもらいます。',
      confirmLabel: '変更する',
      run: async () => {
        await act(() => session.api({ op: 'setOperatorRole', loginId: o.loginId, role }));
      },
    });
  }

  return (
    <section className="card pad">
      {element}
      <h1 className="t2">アカウント管理</h1>
      <p className="small p">
        運営ID＋パスワードでログインするアカウントです。ロールごとの権限: 開発者・責任者はすべて、教員・アンバサダーはアカウント管理以外、スタッフは当日の確認と受付の切り替えだけです。
      </p>
      {error && (
        <Notice kind="danger" icon="alert" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {issued && (
        <Notice kind="warn" icon="alert" onClose={() => setIssued(null)}>
          <strong>{issued.title}</strong>（運営ID: {issued.loginId}）
          <div className="memo num" style={{ fontSize: 18, overflowWrap: 'anywhere', margin: '6px 0' }}>
            {issued.password}
          </div>
          この画面を閉じると二度と表示されません。本人に直接伝えてください。初回のログインでパスワードを変えてもらいます。
        </Notice>
      )}

      {list === null && !error && <Loading />}
      {list && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>運営ID</th>
                <th>名前</th>
                <th>ロール</th>
                <th>状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => {
                const mine = o.loginId === session.identity.loginId;
                const manageable = !mine && allowed.includes(o.role);
                return (
                  <tr key={o.loginId}>
                    <td>
                      {o.loginId}
                      {mine && <span className="small">（自分）</span>}
                    </td>
                    <td>{o.displayName}</td>
                    <td>
                      {manageable ? (
                        <select className="sel" aria-label={`${o.loginId} のロール`} style={{ width: 'auto' }} value={o.role} onChange={(e) => changeRole(o, e.target.value as OperatorRole)}>
                          {OPERATOR_ROLES.filter((r) => allowed.includes(r) || r === o.role).map((r) => (
                            <option key={r} value={r} disabled={!allowed.includes(r)}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ROLE_LABELS[o.role]
                      )}
                    </td>
                    <td>
                      {o.active ? (o.mustChange ? '仮パスワード（未変更）' : '有効') : '停止中'}
                    </td>
                    <td>
                      {manageable ? (
                        <span className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                          <button className="quiet" onClick={() => action(o, 'reset')}>
                            再発行
                          </button>
                          {o.active ? (
                            <button className="quiet" onClick={() => action(o, 'disable')}>
                              停止
                            </button>
                          ) : (
                            <button className="quiet" onClick={() => action(o, 'enable')}>
                              再開
                            </button>
                          )}
                        </span>
                      ) : (
                        <span className="small">－</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateForm
        session={session}
        allowed={allowed}
        onCreate={async (loginId, displayName, role) => {
          const res = await act(() => session.api<CreateOperatorResponse>({ op: 'createOperator', loginId, displayName, role }));
          if (res) setIssued({ title: 'アカウントを作成しました', loginId: res.loginId, password: res.temporaryPassword });
          return res !== null;
        }}
      />
    </section>
  );
}

function CreateForm({ allowed, onCreate }: { session: AdminSession; allowed: OperatorRole[]; onCreate: (loginId: string, displayName: string, role: OperatorRole) => Promise<boolean> }) {
  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<OperatorRole>(allowed.includes('staff') ? 'staff' : (allowed[0] ?? 'staff'));
  const [busy, setBusy] = useState(false);
  const normalized = normalizeLoginId(loginId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!normalized) return;
    setBusy(true);
    const ok = await onCreate(normalized, displayName.trim(), role);
    setBusy(false);
    if (ok) {
      setLoginId('');
      setDisplayName('');
    }
  }

  return (
    <form className="list" onSubmit={(e) => void submit(e)} style={{ marginTop: 16 }}>
      <h2 className="t2" style={{ fontSize: 17 }}>アカウントを追加</h2>
      <div className="field">
        <label className="label" htmlFor="op-id">
          運営ID（半角英数字・-・_ の3〜40文字）
        </label>
        <input id="op-id" className="in" autoComplete="off" value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="op-name">
          表示名
        </label>
        <input id="op-name" className="in" autoComplete="off" maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="op-role">
          ロール
        </label>
        <select id="op-role" className="sel" value={role} onChange={(e) => setRole(e.target.value as OperatorRole)}>
          {allowed.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <button className="btn" type="submit" disabled={busy || !normalized || !displayName.trim()}>
        追加して仮パスワードを表示
      </button>
    </form>
  );
}
