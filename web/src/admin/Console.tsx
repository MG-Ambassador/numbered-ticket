// 管理画面の枠組み: イベントの選択とタブ（当日・設定・コード・枠・統計）
import { useEffect, useRef, useState } from 'react';
import { collection, orderBy, query } from 'firebase/firestore';
import { ROLE_LABELS, type EventDoc, type EventState, type Permission } from '@nt/shared';
import { useQuery } from '../lib/hooks';
import { Loading, Notice } from '../ui';
import { Codes } from './Codes';
import { OperatorManager } from './OperatorManager';
import { EventForm } from './EventForm';
import type { AdminSession } from './session';
import { SlotsAdmin } from './SlotsAdmin';
import { Stats } from './Stats';
import { Today } from './Today';
import { formatJst } from './time';

export const EVENT_STATE_LABELS: Record<EventState, string> = {
  scheduled: '開場前',
  open: '開場中',
  closed: '閉場',
  purged: '削除済み',
};

/** 項目ごとの必要な権限（shared の roles.ts）。権限のない項目は出さない */
const ALL_TABS: { id: string; label: string; need: Permission }[] = [
  { id: 'today', label: '当日', need: 'event.view' },
  { id: 'settings', label: 'イベント設定', need: 'event.manage' },
  { id: 'codes', label: 'コード', need: 'codes.manage' },
  { id: 'slots', label: '枠', need: 'event.manage' },
  { id: 'stats', label: '統計', need: 'event.view' },
  { id: 'accounts', label: 'アカウント', need: 'accounts.manage' },
];
type Tab = 'today' | 'settings' | 'codes' | 'slots' | 'stats' | 'accounts';

const EID_KEY = 'nt.admin.eid';

export interface AdminEvent extends EventDoc {
  id: string;
}

export function Console({ session, onSignOut }: { session: AdminSession; onSignOut: () => void }) {
  const events = useQuery<EventDoc>(query(collection(session.db, 'events'), orderBy('opensAt', 'desc')), `admin-events:${session.uid}`);
  const [eid, setEid] = useState<string | null>(() => {
    try {
      return localStorage.getItem(EID_KEY);
    } catch {
      return null;
    }
  });
  const [tab, setTab] = useState<Tab>('today');
  const [creating, setCreating] = useState(false);
  const tabs = ALL_TABS.filter((t) => session.can(t.need));
  const logged = useRef(new Set<string>());

  const list = events.status === 'ok' ? events.data : [];
  const current = list.find((e) => e.id === eid) ?? list.find((e) => e.state !== 'purged') ?? null;

  function select(id: string) {
    setEid(id);
    setCreating(false);
    try {
      localStorage.setItem(EID_KEY, id);
    } catch {
      /* 保存できなくても選択はできる */
    }
  }

  // A-01: ログインを auditLog に残す（auditLog はイベントごとなので、開いたイベントに記録する）
  useEffect(() => {
    if (!current || current.state === 'purged' || logged.current.has(current.id)) return;
    logged.current.add(current.id);
    void session.api({ op: 'recordLogin', eid: current.id }).catch(() => {});
  }, [current, session]);

  return (
    <main className="page wide">
      <div className="between" style={{ flexWrap: 'wrap' }}>
        <span className="eyebrow">管理者 · ADMIN</span>
        <span className="row small">
          {session.identity.displayName}（{ROLE_LABELS[session.identity.role]}）
          <button className="quiet" onClick={onSignOut}>
            ログアウト
          </button>
        </span>
      </div>

      {events.status === 'loading' && <Loading />}
      {events.status === 'error' && (
        <Notice kind="danger" icon="alert">
          イベントを読み込めませんでした（{events.error.message}）。
        </Notice>
      )}

      {events.status === 'ok' && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="label" htmlFor="a-event">
            イベント
          </label>
          <select id="a-event" className="sel" style={{ width: 'auto', minWidth: 280 }} value={creating ? '' : (current?.id ?? '')} onChange={(e) => e.target.value && select(e.target.value)}>
            {creating && <option value="">（新しいイベント）</option>}
            {list.length === 0 && !creating && <option value="">（まだありません）</option>}
            {list.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}（{formatJst(e.opensAt.toMillis()).slice(0, 10)}・{EVENT_STATE_LABELS[e.state]}）
              </option>
            ))}
          </select>
          {session.can('event.manage') && (
            <button className="btn2" onClick={() => setCreating(true)}>
              新しいイベントを作る
            </button>
          )}
        </div>
      )}

      {tab === 'accounts' && session.can('accounts.manage') ? (
        <>
          <div className="seg" role="tablist" aria-label="管理の項目" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, borderRadius: 12 }}>
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id as Tab)} style={{ borderRadius: 10, minHeight: 44 }}>
                {t.label}
              </button>
            ))}
          </div>
          <OperatorManager session={session} />
        </>
      ) : creating && session.can('event.manage') ? (
        <section className="card pad">
          <h1 className="t2">新しいイベント</h1>
          <p className="small p">作ると、入場コード・スタッフコードと教員相談の枠ができます。学生枠は「枠」のタブで登録します。</p>
          <EventForm session={session} event={null} onSaved={(id) => id && select(id)} onCancel={() => setCreating(false)} />
        </section>
      ) : current ? (
        <>
          <div className="seg" role="tablist" aria-label="管理の項目" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, borderRadius: 12 }}>
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id as Tab)} style={{ borderRadius: 10, minHeight: 44 }}>
                {t.label}
              </button>
            ))}
          </div>
          {current.state === 'purged' ? (
            <Notice kind="info" icon="alert">
              このイベントは閉場後の削除が済んでいます。残っているのは統計だけです。
            </Notice>
          ) : null}
          {tab === 'today' && current.state !== 'purged' && <Today session={session} event={current} />}
          {tab === 'settings' && (
            <section className="card pad">
              <h1 className="t2">イベント設定</h1>
              {current.state === 'closed' || current.state === 'purged' ? (
                <Notice kind="info" icon="alert">
                  閉場後は変更できません。
                </Notice>
              ) : (
                <EventForm session={session} event={current} onSaved={() => {}} />
              )}
            </section>
          )}
          {tab === 'codes' && current.state !== 'purged' && <Codes session={session} event={current} />}
          {tab === 'slots' && current.state !== 'purged' && <SlotsAdmin session={session} event={current} />}
          {tab === 'stats' && <Stats session={session} event={current} />}
        </>
      ) : (
        events.status === 'ok' && <p className="p">イベントがありません。「新しいイベントを作る」から始めてください。</p>
      )}
    </main>
  );
}
