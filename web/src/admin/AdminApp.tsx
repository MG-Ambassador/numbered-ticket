// 管理者の画面（A-01 ログイン＋TOTP・初回設定）。ログイン後は Console.tsx
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  getMultiFactorResolver,
  multiFactor,
  signInWithEmailAndPassword,
  signOut,
  TotpMultiFactorGenerator,
  updatePassword,
  type MultiFactorResolver,
  type TotpSecret,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { clients, useEmulator } from '../firebase';
import { errorMessage } from '../lib/api';
import { useAuthState } from '../lib/hooks';
import { Header, Loading, Notice } from '../ui';
import { Console } from './Console';
import { emulatorSession, productionSession } from './session';

const c = clients('admin');
/** A-01: 30分無操作でログアウト */
const IDLE_MS = 30 * 60_000;

export function AdminApp() {
  const auth = useAuthState(c.auth);
  // TOTP 済みかはクレームと同じトークンから取る（useAuthState）。別に読むと、TOTP でログインした直後の
  // 最初の描画だけ「TOTP なし」になり、初回設定がパスワード変更の段階で固定されていた（2026-11-26）
  const secondFactor = auth.secondFactor;

  useIdleLogout(!!auth.user);

  const user = auth.user;
  const isAdmin = auth.claims.admin === true;
  const initial = auth.claims.initial === true;
  const totp = secondFactor === 'totp';
  const session = useMemo(() => {
    if (!user || !isAdmin) return null;
    if (totp) return productionSession(user);
    if (useEmulator && !initial) return emulatorSession(user);
    return null;
  }, [user, isAdmin, totp, initial]);

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
  if (initial) return <Setup totp={totp} />;
  if (!session) {
    // 管理者なのに TOTP を経ていないトークン（登録直後など）。ログインし直してもらう
    return (
      <Shell>
        <Notice kind="warn" icon="alert">
          認証アプリのコードでのログインが必要です。もう一度ログインしてください。
        </Notice>
        <button className="btn" onClick={() => void signOut(c.auth)}>
          ログインし直す
        </button>
      </Shell>
    );
  }
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

// ---- ログイン（ID・パスワード → TOTP） ------------------------------------------

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
      // TOTP 未登録（初回）ならここでログインが終わる
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
      {useEmulator && (
        <Notice kind="info" icon="alert">
          Emulator では認証アプリ（TOTP）が使えないため、パスワードだけでログインします（`npm run seed` で作る admin@example.com）。
        </Notice>
      )}
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
            次へ
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

// ---- 初回設定（パスワード変更・TOTP 登録） ----------------------------------------

function Setup({ totp }: { totp: boolean }) {
  const user = c.auth.currentUser!;
  // TOTP 登録済みなのに TOTP を経ていないセッション（登録後にパスワードだけで入り直した、など）は、登録をやり直させず入り直してもらう
  const enrolled = multiFactor(user).enrolledFactors.some((f) => f.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  const [step, setStep] = useState<'password' | 'totp' | 'relogin' | 'finish'>(totp ? 'finish' : enrolled ? 'relogin' : 'password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // TOTP 済みのトークンで入り直したら、initial クレームを外す
  useEffect(() => {
    if (step !== 'finish') return;
    void run(async () => {
      await productionSession(user).api({ op: 'completeSetup' });
      await user.getIdToken(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (useEmulator) {
    return (
      <Shell>
        <Notice kind="warn" icon="alert">
          初回設定（パスワード変更と認証アプリの登録）は Emulator ではできません（TOTP 非対応）。本番環境で確かめてください。Emulator では `npm run seed` で作る管理者を使ってください。
        </Notice>
        <button className="btn2" onClick={() => void signOut(c.auth)}>
          ログアウト
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="t1">初回設定</h1>
      <p className="small p">はじめてのログインです。パスワードを変えてから、認証アプリ（Google Authenticator など）を登録してください。</p>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      {step === 'password' && (
        <form
          className="list"
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) return setError('確認のパスワードが一致しません。');
            void run(async () => {
              await updatePassword(user, password);
              const session = await multiFactor(user).getSession();
              setSecret(await TotpMultiFactorGenerator.generateSecret(session));
              setStep('totp');
            });
          }}
        >
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
      )}
      {step === 'totp' && secret && (
        <form
          className="list"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, code), '認証アプリ');
              setStep('relogin');
            });
          }}
        >
          <p className="p">認証アプリで「セットアップキーを入力」を選び、次のキーを入れてください。</p>
          <div className="memo num" style={{ fontSize: 18, letterSpacing: '0.08em' }}>
            {secret.secretKey}
          </div>
          <p className="small p">
            QR コードで読み取る場合の URL: <code style={{ overflowWrap: 'anywhere' }}>{secret.generateQrCodeUrl(user.email ?? 'admin', 'OC相談 整理券')}</code>
          </p>
          <div className="field">
            <label className="label" htmlFor="s-totp">
              認証アプリに出た6桁
            </label>
            <input id="s-totp" className="code-in" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </div>
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            登録する
          </button>
        </form>
      )}
      {step === 'relogin' && (
        <>
          <Notice kind="ok" icon="check">
            認証アプリを登録しました。新しいパスワードと認証アプリのコードで、もう一度ログインしてください。
          </Notice>
          <button className="btn" onClick={() => void signOut(c.auth)}>
            ログインし直す
          </button>
        </>
      )}
      {step === 'finish' && <Loading text="設定を仕上げています" />}
    </Shell>
  );
}
