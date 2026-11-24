// 来場者の画面（V-01〜V-08）。パス: / 入場ゲート、/slots 相談の選択、/ticket 整理券
import { useEffect, useState } from 'react';
import { paths, type EventDoc, type VisitorDoc } from '@nt/shared';
import { clients } from '../firebase';
import { navigate, useAuthState, useDoc, usePath } from '../lib/hooks';
import { Header, Loading } from '../ui';
import { Gate } from './Gate';
import { Slots } from './Slots';
import { TicketView } from './Ticket';

const c = clients('visitor');

/** 最後に見ていた整理券。完了・キャンセル後も「ありがとうございました」を出すため（入場記録の activeTicketId は消える） */
const LAST_TICKET_KEY = 'nt.visitor.lastTicket';
function readLastTicket(): string | null {
  try {
    return localStorage.getItem(LAST_TICKET_KEY);
  } catch {
    return null;
  }
}
function writeLastTicket(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_TICKET_KEY, id);
    else localStorage.removeItem(LAST_TICKET_KEY);
  } catch {
    /* プライベートブラウズなど */
  }
}

export interface VisitorContext {
  c: typeof c;
  eid: string;
  uid: string;
  event: EventDoc;
  /** 有効な整理券（1端末1枚） */
  activeTicketId: string | null;
  openTicket: (ticketId: string) => void;
}

export function VisitorApp() {
  const path = usePath();
  const auth = useAuthState(c.auth);
  const eid = auth.claims.role === 'visitor' && typeof auth.claims.eid === 'string' ? auth.claims.eid : null;
  const uid = auth.user?.uid ?? null;
  const event = useDoc<EventDoc>(c.db, eid ? paths.event(eid) : null);
  const visitor = useDoc<VisitorDoc>(c.db, eid && uid ? paths.visitor(eid, uid) : null);
  const [lastTicket, setLastTicket] = useState<string | null>(readLastTicket);

  const activeTicketId = visitor.status === 'ok' ? (visitor.data?.activeTicketId ?? null) : null;

  // 有効な整理券があれば、それを「見ている整理券」にする（別の画面で発券した場合も追いかける）
  useEffect(() => {
    if (activeTicketId && activeTicketId !== lastTicket) {
      writeLastTicket(activeTicketId);
      setLastTicket(activeTicketId);
    }
  }, [activeTicketId, lastTicket]);

  const openTicket = (ticketId: string) => {
    writeLastTicket(ticketId);
    setLastTicket(ticketId);
    navigate('/ticket');
  };
  const forgetTicket = () => {
    writeLastTicket(null);
    setLastTicket(null);
    navigate('/slots');
  };

  if (!auth.ready) return <Loading />;

  // 入場前（またはクレームのイベントが読めない＝消された）
  const ev = event.status === 'ok' ? event.data : null;
  if (!eid || event.status === 'error' || (event.status === 'ok' && (!ev || ev.state === 'purged'))) {
    return <Gate c={c} onEntered={(r) => (r.activeTicketId ? openTicket(r.activeTicketId) : navigate('/slots'))} />;
  }
  if (event.status === 'loading' || visitor.status === 'loading' || !ev || !uid) return <Loading />;

  if (ev.state === 'closed') {
    return (
      <main className="page">
        <Header eyebrow="個別相談 · CONSULTATION" />
        <div className="card pad">
          <h1 className="t2">本日の受付は終了しました</h1>
          <p className="p">ご来場ありがとうございました。整理券と聞きたいことのメモは削除しました。</p>
        </div>
      </main>
    );
  }
  if (ev.state === 'scheduled') {
    const t = new Date(ev.opensAt.toMillis());
    return (
      <main className="page">
        <Header eyebrow="個別相談 · CONSULTATION" />
        <div className="card pad">
          <h1 className="t2">まもなく受付を始めます</h1>
          <p className="p">
            受付開始は <b className="num">{t.getHours()}:{String(t.getMinutes()).padStart(2, '0')}</b> です。この画面を開いたままお待ちください。
          </p>
        </div>
      </main>
    );
  }

  const ctx: VisitorContext = { c, eid, uid, event: ev, activeTicketId, openTicket };

  if (path === '/ticket' && lastTicket) {
    return <TicketView ctx={ctx} ticketId={lastTicket} onDone={forgetTicket} />;
  }
  if (path !== '/slots') {
    // ゲートや整理券のパスに来たら、整理券があれば整理券へ、なければ一覧へ
    return <Redirect to={activeTicketId ? '/ticket' : '/slots'} />;
  }
  return <Slots ctx={ctx} />;
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return <Loading />;
}
