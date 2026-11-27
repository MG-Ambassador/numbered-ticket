// 管理者の画面（A-01 ID・パスワードのログイン・初回設定）。ログイン後は Console.tsx
// TOTP は必須にしない（2026-11-27）。すでに TOTP を登録したアカウントは、これまでどおりコードも求められる
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getMultiFactorResolver, signInWithEmailAndPassword, signOut, TotpMultiFactorGenerator, updatePassword, type MultiFactorResolver } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { clients } from '../firebase';
import { errorMessage } from '../lib/api';
import { useAuthState } from '../lib/hooks';
import { Header, Loading, Notice } from '../ui';
import { Console } from './Console';
import { productionSession } from './session';

const c = clients('admin');
/** A-01: 30分無操作でログアウト */
const IDLE_MS = 30 * 60_000;

export function AdminApp() {
  const auth = useAuthState(c.auth);

  useIdleLogout(!!auth.user);

  const user = auth.user;
  const isAdmin = auth.claims.admin === true;
  const initial = auth.claims.initial === true;
  const session = useMemo(() => (user && isAdmin && !initial ? productionSession(user) : null), [user, isAdmin, initial]);

  if (!auth.ready) return <Loading />;
  if (!user) return <Login />;
  if (!isAdmin) {
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
  if (initial) return <Setup />;
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

// ---- ログイン（ID・パスワード。TOTP 登録済みのアカウントはコードも） ------------------------------------------

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(c.auth, email.trim(), password);
      // TOTP 未登録ならここでログインが終わる
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'auth/multi-factor-auth-required') {
        setResolver(getMultiFactorResolver(c.auth, err as never));
      } else {
        setError(authMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!resolver) return;
    const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    if (!hint) return setError('認証アプリが登録されていません。事務局の担当者に連絡してください。');
    setBusy(true);
    setError(null);
    try {
      await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code));
    } catch (err) {
      setError(authMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1 className="t1">管理者ログイン</h1>
      {!resolver ? (
        <form className="list" onSubmit={submitPassword}>
          <div className="field">
            <label className="label" htmlFor="a-email">
              ID（メールアドレス）
            </label>
            <input id="a-email" className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <button className="btn" type="submit" disabled={busy || !email || !password}>
            ログイン
          </button>
        </form>
      ) : (
        <form className="list" onSubmit={submitCode}>
          <div className="field">
            <label className="label" htmlFor="a-totp">
              認証アプリの6桁のコード
            </label>
            <input
              id="a-totp"
              className="code-in"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
          </div>
          {error && (
            <Notice kind="danger" icon="alert">
              {error}
            </Notice>
          )}
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            ログイン
          </button>
        </form>
      )}
    </Shell>
  );
}

function authMessage(err: unknown): string {
  const code = err instanceof FirebaseError ? err.code : '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-email')
    return 'ID かパスワードが違います。';
  if (code === 'auth/invalid-verification-code' || code === 'auth/invalid-totp-code' || code === 'auth/totp-challenge-timeout') return '認証アプリのコードが違うか、時間切れです。';
  if (code === 'auth/too-many-requests') return '試行回数が多すぎます。しばらく待ってからお試しください。';
  if (code === 'auth/password-does-not-meet-requirements') return 'パスワードは12文字以上にしてください。';
  if (code === 'auth/requires-recent-login') return 'もう一度ログインしてから行ってください。';
  if (code === 'auth/user-disabled') return 'このアカウントは無効になっています。';
  return errorMessage(err);
}

// ---- 初回設定（パスワード変更） ---------------------------------------------------

function Setup() {
  const user = c.auth.currentUser!;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('確認のパスワードが一致しません。');
    setBusy(true);
    setError(null);
    try {
      await updatePassword(user, password);
      await productionSession(user).api({ op: 'completeSetup' });
      await user.getIdToken(true);
    } catch (err) {
      setError(authMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1 className="t1">初回設定</h1>
      <p className="small p">はじめてのログインです。仮パスワードから、ご自身のパスワードに変えてください。</p>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      <form className="list" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="label" htmlFor="s-pass">
            新しいパスワード（12文字以上）
          </label>
          <input id="s-pass" className="in" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="s-pass2">
            もう一度
          </label>
          <input id="s-pass2" className="in" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={busy || [...password].length < 12}>
          パスワードを変える
        </button>
      </form>
    </Shell>
  );
}
