import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { usePath } from './lib/hooks';
import { Loading } from './ui';
import { VisitorApp } from './visitor/VisitorApp';
import './styles.css';

// スタッフ・管理者の画面は別のファイルに分け、来場者が開いたときには読み込まない（P4: 来場者の読み込みを軽くする）
const StaffApp = lazy(() => import('./staff/StaffApp').then((m) => ({ default: m.StaffApp })));
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

// 設計書 5.2 の画面一覧: / ・ /slots ・ /ticket は来場者、/staff はスタッフ、/admin は管理者
function App() {
  const path = usePath();
  if (path.startsWith('/staff') || path.startsWith('/admin')) {
    return <Suspense fallback={<Loading />}>{path.startsWith('/staff') ? <StaffApp /> : <AdminApp />}</Suspense>;
  }
  return <VisitorApp />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
