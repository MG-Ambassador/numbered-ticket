// V-01 入場ゲート。QR の #code= は読み込んだ直後に URL から消す
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signInAnonymously } from 'firebase/auth';
import { FUNCTION_NAMES, formatCode, formatDuration, type EnterEventRequest, type EnterEventResponse } from '@nt/shared';
import type { Clients } from '../firebase';
import { call, toApiError } from '../lib/api';
import { useNow } from '../lib/hooks';
import { Icon, Notice } from '../ui';

/** URL の #code= を取り出して消す（履歴にも残さない） */
function takeCodeFromHash(): string | null {
  const m = /(?:^#|&)code=(\d{7})(?:&|$)/.exec(location.hash);
  if (!location.hash) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m ? m[1]! : null;
}

export function Gate({ c, onEntered }: { c: Clients; onEntered: (r: EnterEventResponse) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockUntil, setLockUntil] = useState(0);
  const [checking, setChecking] = useState(false);
  const now = useNow();
  const locked = lockUntil > now;
  const started = useRef(false);

  async function enter(digits: string) {
    if (digits.length !== 7) {
      setError('7桁の数字をご入力ください。');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const user = c.auth.currentUser ?? (await signInAnonymously(c.auth)).user;
      const res = await call<EnterEventRequest, EnterEventResponse>(c.functions, FUNCTION_NAMES.enterEvent, { code: digits });
      // クレーム（eid, role）を付けたのでトークンを取り直す。onIdTokenChanged で画面が切り替わる
      await user.getIdToken(true);
      onEntered(res);
    } catch (e) {
      const err = toApiError(e);
      if (err.reason === 'rateLimited' && err.details?.retryAfterSeconds) {
        setLockUntil(Date.now() + err.details.retryAfterSeconds * 1000);
        setError(null);
      } else if (err.reason === 'wrongCode') {
        setError('掲示の数字と少し異なっているようです。会場のポスターにある7桁をご確認ください。');
      } else {
        setError(err.message);
      }
      setChecking(false);
    }
  }

  // QR から来たときは、読み込んだ直後にコードを URL から消してそのまま照合する
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fromQr = takeCodeFromHash();
    if (fromQr) {
      setCode(fromQr);
      void enter(fromQr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!locked && !checking) void enter(code);
  }

  if (checking) {
    return (
      <main className="page">
        <div className="loading" role="status">
          <span className="eyebrow">ENTRY</span>
          <span className="hl">確認しています</span>
          <span className="small">そのまま少しお待ちください。</span>
        </div>
      </main>
    );
  }

  return (
    <main className="page" style={{ alignItems: 'center', gap: 22, paddingTop: 36 }}>
      <div className="col" style={{ alignSelf: 'flex-start', gap: 2 }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '.08em' }}>明治学院大学</span>
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.16em', color: 'var(--p-ink-soft)' }}>MEIJI GAKUIN UNIVERSITY</span>
      </div>
      <div className="arch" aria-hidden="true">
        <svg width="120" height="128" viewBox="0 0 140 150" fill="none" stroke="#232121" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M70 150V62" /><path d="M70 110c-14-6-24-18-26-32" /><path d="M70 96c14-4 24-14 28-28" /><path d="M44 150V86" /><path d="M96 150V80" />
          <circle cx="70" cy="52" r="7" /><circle cx="60" cy="44" r="5" /><circle cx="80" cy="44" r="5" /><circle cx="70" cy="36" r="5" />
          <circle cx="44" cy="78" r="5" /><circle cx="38" cy="70" r="4" /><circle cx="50" cy="70" r="4" />
          <circle cx="96" cy="72" r="5" /><circle cx="90" cy="64" r="4" /><circle cx="102" cy="64" r="4" />
        </svg>
      </div>
      <div className="col center" style={{ alignItems: 'center', gap: 6 }}>
        <span className="eyebrow">OPEN CAMPUS</span>
        <h1 className="display">個別相談</h1>
        <p className="small p">整理券を受け取って、順番をお待ちいただけます。</p>
      </div>
      <form className="field" style={{ width: '100%' }} onSubmit={submit} noValidate>
        <label className="label" htmlFor="v-code">
          入場コード
        </label>
        <input
          id="v-code"
          className="code-in"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000-0000"
          maxLength={8}
          value={formatCode(code)}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 7))}
          aria-invalid={error ? true : undefined}
          aria-describedby="v-code-help"
          disabled={locked}
        />
        <div id="v-code-help">
          {locked ? (
            <Notice kind="warn" icon="clock">
              しばらく時間をおいてから、もう一度お試しください（あと {formatDuration(lockUntil - now)}）。
            </Notice>
          ) : error ? (
            <Notice kind="danger" icon="alert">
              {error}
            </Notice>
          ) : (
            <p className="small p">会場のポスターにある7桁をご入力ください。QRコードを読み取った方は入力不要です。</p>
          )}
        </div>
        <button className="btn" type="submit" disabled={locked} style={{ marginTop: 16 }}>
          入場する
          <Icon name="chev" />
        </button>
      </form>
    </main>
  );
}
