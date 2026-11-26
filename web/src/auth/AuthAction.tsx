// Firebase Authentication のメールのリンク先（/auth-action）。
//
// TOTP を登録すると、Firebase は「2段階認証を追加しました。心当たりがなければ取り消してください」というメールを送る。
// 標準の処理ページ（firebaseapp.com/__/auth/action）はリンクを開いただけで取り消しを実行するため、
// 大学のメール（Microsoft 365）がリンクを安全確認のために自動で開くと、登録した TOTP がすぐに取り消されていた（2026-11-26）。
// このページはリンクを開いただけでは何も送らず、ボタンを押したときだけ実行する。
// 送り先の切り替え: Identity Platform の設定 notification.sendEmail.callbackUri（docs/p4-integration.md）
import { useState } from 'react';
import { applyActionCode } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { clients } from '../firebase';
import { Header, Notice } from '../ui';

const c = clients('admin');

export function AuthAction() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');
  const [state, setState] = useState<'ready' | 'busy' | 'done'>('ready');
  const [error, setError] = useState<string | null>(null);

  async function revert() {
    if (!oobCode) return;
    setState('busy');
    setError(null);
    try {
      await applyActionCode(c.auth, oobCode);
      setState('done');
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : '';
      setError(
        code === 'auth/expired-action-code' || code === 'auth/invalid-action-code'
          ? 'このリンクは期限切れか、すでに使われています。'
          : 'うまくいきませんでした。もう一度お試しください。',
      );
      setState('ready');
    }
  }

  let body: React.ReactNode;
  if (mode !== 'revertSecondFactorAddition' || !oobCode) {
    body = (
      <Notice kind="warn" icon="alert">
        このリンクはこのシステムでは使いません。事務局の担当者に連絡してください。
      </Notice>
    );
  } else if (state === 'done') {
    body = (
      <Notice kind="ok" icon="check">
        2段階認証（認証アプリ）の追加を取り消し、ログイン中の端末をすべてログアウトしました。パスワードを変え、事務局の担当者に連絡してください。
      </Notice>
    );
  } else {
    body = (
      <>
        <p className="p">
          管理者アカウントに 2段階認証（認証アプリ）が追加されました。<strong>自分で追加した場合は、何もせずにこのページを閉じてください。</strong>
        </p>
        <p className="small p">心当たりがない場合だけ、下のボタンで取り消してください。取り消すと、ログイン中の端末はすべてログアウトされます。</p>
        {error && (
          <Notice kind="danger" icon="alert">
            {error}
          </Notice>
        )}
        <button className="btn2" onClick={() => void revert()} disabled={state === 'busy'}>
          心当たりがないので取り消す
        </button>
      </>
    );
  }

  return (
    <main className="page">
      <Header eyebrow="管理者 · ADMIN" />
      <h1 className="t1">2段階認証の確認</h1>
      {body}
    </main>
  );
}
