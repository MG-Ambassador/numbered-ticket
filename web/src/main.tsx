import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { usePath } from './lib/hooks';
import { StaffApp } from './staff/StaffApp';
import { VisitorApp } from './visitor/VisitorApp';
import './styles.css';

// 設計書 5.2 の画面一覧: / ・ /slots ・ /ticket は来場者、/staff はスタッフ、/admin は管理者
function App() {
  const path = usePath();
  if (path.startsWith('/staff')) return <StaffApp />;
  if (path.startsWith('/admin')) {
    return (
      <main className="page">
        <p className="p">管理者の画面は準備中です（P3 の後半で作ります）。</p>
      </main>
    );
  }
  return <VisitorApp />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
