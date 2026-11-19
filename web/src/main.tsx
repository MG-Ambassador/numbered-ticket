import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { signInAnonymously } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from './firebase';

// P0 の疎通確認用画面。P3 で入場ゲート等に置き換える。
function App() {
  const [result, setResult] = useState<string>('未実行');

  async function check() {
    try {
      const cred = await signInAnonymously(auth);
      const res = await httpsCallable(functions, 'verifyIp')();
      setResult(JSON.stringify({ uid: cred.user.uid, ...(res.data as object) }, null, 2));
    } catch (e) {
      setResult(`エラー: ${(e as Error).message}`);
    }
  }

  return (
    <main style={{ fontSize: 16, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1>疎通確認（P0）</h1>
      <button onClick={check}>匿名ログイン → verifyIp を呼ぶ</button>
      <pre data-testid="result">{result}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
