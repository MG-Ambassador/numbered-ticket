import { useEffect, useState, useSyncExternalStore } from 'react';
import { onIdTokenChanged, type Auth, type User } from 'firebase/auth';
import { doc, onSnapshot, type Firestore, type Query } from 'firebase/firestore';

export interface AuthState {
  /** 起動直後の確認が終わるまで false */
  ready: boolean;
  user: User | null;
  claims: Record<string, unknown>;
  /** トークンの sign_in_second_factor（管理者が TOTP でログインしたら 'totp'）。claims と同じトークンから取るので、食い違わない */
  secondFactor: string | null;
}

/** ログイン状態とクレーム。getIdToken(true) でトークンを更新すると claims も変わる */
export function useAuthState(auth: Auth): AuthState {
  const [state, setState] = useState<AuthState>({ ready: false, user: null, claims: {}, secondFactor: null });
  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        if (!user) return setState({ ready: true, user: null, claims: {}, secondFactor: null });
        const t = await user.getIdTokenResult();
        setState({ ready: true, user, claims: t.claims, secondFactor: t.signInSecondFactor ?? null });
      }),
    [auth],
  );
  return state;
}

export type Live<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  /** 読めない（ルールで拒否＝閉場した・権限がない、など） */
  | { status: 'error'; error: Error };

/** ドキュメントの購読。path が null なら購読しない */
export function useDoc<T>(db: Firestore, path: string | null): Live<T | null> {
  const [v, setV] = useState<Live<T | null>>({ status: 'loading' });
  useEffect(() => {
    if (!path) return setV({ status: 'loading' });
    setV({ status: 'loading' });
    return onSnapshot(
      doc(db, path),
      (s) => setV({ status: 'ok', data: s.exists() ? (s.data() as T) : null }),
      (error) => setV({ status: 'error', error }),
    );
  }, [db, path]);
  return v;
}

/** クエリの購読。key が変わったら購読し直す（Query は毎回作り直されるので key で比べる） */
export function useQuery<T>(query: Query | null, key: string): Live<(T & { id: string })[]> {
  const [v, setV] = useState<Live<(T & { id: string })[]>>({ status: 'loading' });
  useEffect(() => {
    if (!query) return setV({ status: 'loading' });
    setV({ status: 'loading' });
    return onSnapshot(
      query,
      (s) => setV({ status: 'ok', data: s.docs.map((d) => ({ ...(d.data() as T), id: d.id })) }),
      (error) => setV({ status: 'error', error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return v;
}

/** 秒単位で進む現在時刻（残り時間・経過時間の表示用） */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---- 画面の切り替え（パスだけの小さなルーター） ------------------------------

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (location.pathname === path) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}
