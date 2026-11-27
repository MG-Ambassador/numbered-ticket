// 管理者の画面（A-01 運営ID＋パスワードのログイン・初回のパスワード変更）。ログイン後は Console.tsx
// 明学の質問箱と同じ方式: 運営ID＋パスワード → 関数がカスタムトークンを返し、Firebase にログインする。
// 仮パスワードのままの間は、パスワード変更の画面だけを出す。ログインは8時間（延長なし）・タブを閉じると消える
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { signInWithCustomToken, signOut } from 'firebase/auth';
import { FUNCTION_NAMES, passwordValid, PASSWORD_MIN_LENGTH, type AdminRequest, type OperatorIdentity, type OperatorLoginRequest, type OperatorLoginResponse } from '@nt/shared';
import { clients } from '../firebase';
import { ApiError, call, errorMessage } from '../lib/api';
import { useAuthState } from '../lib/hooks';
import { Header, Loading, Notice } from '../ui';
import { Console } from './Console';
import { fetchIdentity, productionSession } from './session';

const c = clients('admin');
/** A-01: 30分無操作でログアウト */
const IDLE_MS = 30 * 60_000;

export function AdminApp() {
  const auth = useAuthState(c.auth);
  const user = auth.user;
  const isAdmin = auth.claims.admin === true;
  const [identity, setIdentity] = useState<OperatorIdentity | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useIdleLogout(!!user);

  // ログインしたら、自分の情報（ロール・仮パスワードのままか）を取る。ログイン状態が変わるたびに取り直す
  useEffect(() => {
    setIdentity(null);
    setProblem(null);
    if (!user || !isAdmin) return;
    let alive = true;
    fetchIdentity().then(
      (me) => alive && setIdentity(me),
      (e) => {
        if (!alive) return;
        // 期限切れ・停止・再発行されたログインは、ログイン画面に戻す
        if (e instanceof ApiError && (e.reason === 'sessionExpired' || e.reason === 'forbidden')) void signOut(c.auth);
        else setProblem(errorMessage(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [user?.uid, isAdmin, auth.claims.opv]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = useMemo(() => (user && isAdmin && identity && !identity.mustChange ? productionSession(user, identity) : null), [user, isAdmin, identity]);

  if (!auth.ready) return <Loading />;
  if (!user) return <Login />;
  if (!isAdmin) {
    // 管理者以外のログイン（ありえないが、残っていたら外す）
    return (
      <Shell>
        <Notice kind="danger" icon="alert">
          このアカウントは管理者ではありません。
        </Notice>
        <button className="btn2" onClick={() => void signOut(c.auth)}>
          ログアウト
        </button>
      </Shell>
    );
  }
  if (problem) {
    return (
      <Shell>
        <Notice kind="danger" icon="alert">
          {problem}
        </Notice>
        <button className="btn2" onClick={() => void signOut(c.auth)}>
          ログアウト
        </button>
      </Shell>
    );
  }
  if (!identity) return <Loading />;
  if (identity.mustChange) return <ChangePassword identity={identity} onChanged={setIdentity} />;
  if (!session) return <Loading />;
  return <Console session={session} onSignOut={() => void signOut(c.auth)} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="page">
      <Header eyebrow="管理者 · ADMIN" />
      {children}
    </main>
  );
}

function useIdleLogout(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(() => void signOut(c.auth), IDLE_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void signOut(c.auth), IDLE_MS);
    };
    const events = ['pointerdown', 'keydown', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [active]);
}

// ---- ログイン（運営ID・パスワード） ------------------------------------------------

function Login() {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await call<OperatorLoginRequest, OperatorLoginResponse>(c.functions, FUNCTION_NAMES.operatorLogin, { loginId: loginId.trim(), password });
      await signInWithCustomToken(c.auth, res.token);
    } catch (err) {
      const e2 = err instanceof ApiError ? err : null;
      const wait = e2?.reason === 'rateLimited' ? e2.details?.retryAfterSeconds : undefined;
      setError(wait ? `試行回数が多すぎます。${Math.ceil(wait / 60)}分ほど待ってからお試しください。` : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1 className="t1">管理者ログイン</h1>
      <form className="list" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="label" htmlFor="a-id">
            運営ID
          </label>
          <input id="a-id" className="in" autoComplete="username" autoCapitalize="none" spellCheck={false} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="a-pass">
            パスワード
          </label>
          <input id="a-pass" className="in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <Notice kind="danger" icon="alert">
            {error}
          </Notice>
        )}
        <button className="btn" type="submit" disabled={busy || !loginId || !password}>
          ログイン
        </button>
        <p className="small p">ログインは8時間で切れます。アカウントの発行・再発行は、責任者または開発者にご連絡ください。</p>
      </form>
    </Shell>
  );
}

// ---- 初回のパスワード変更（仮パスワードのまま） ------------------------------------------

function ChangePassword({ identity, onChanged }: { identity: OperatorIdentity; onChanged: (me: OperatorIdentity) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError('確認のパスワードが一致しません。');
    setBusy(true);
    setError(null);
    try {
      const req: AdminRequest = { op: 'changePassword', currentPassword: current, newPassword: next };
      const res = await call<AdminRequest, OperatorLoginResponse>(c.functions, FUNCTION_NAMES.admin, req);
      // 変更で古いログインは無効になる。新しいトークンで入り直す
      await signInWithCustomToken(c.auth, res.token);
      onChanged(res.identity);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1 className="t1">パスワードの変更</h1>
      <p className="small p">
        {identity.displayName}さん（運営ID: {identity.loginId}）、はじめてのログインです。仮パスワードから、ご自身のパスワードに変えてください。変えるまで、ほかの操作はできません。
      </p>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      <form className="list" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="label" htmlFor="c-cur">
            いまのパスワード（仮パスワード）
          </label>
          <input id="c-cur" className="in" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="c-new">
            新しいパスワード（{PASSWORD_MIN_LENGTH}文字以上）
          </label>
          <input id="c-new" className="in" type="password" autoComplete="new-password" maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="c-new2">
            もう一度
          </label>
          <input id="c-new2" className="in" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={busy || !current || !passwordValid(next)}>
          パスワードを変える
        </button>
      </form>
      <button className="btn2" onClick={() => void signOut(c.auth)}>
        ログアウト
      </button>
    </Shell>
  );
}
