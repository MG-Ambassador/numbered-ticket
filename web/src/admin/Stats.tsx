// A-07 統計。閉場＋1時間に stats/{日付} に保存したものと、当日の整理券からの試算
import { useEffect, useState } from 'react';
import { collection } from 'firebase/firestore';
import { GRADES, type PreviewStatsResponse, type StatsDoc } from '@nt/shared';
import { errorMessage } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Loading, Notice } from '../ui';
import type { AdminEvent } from './Console';
import type { AdminSession } from './session';

export function Stats({ session, event }: { session: AdminSession; event: AdminEvent }) {
  const saved = useQuery<StatsDoc>(collection(session.db, `events/${event.id}/stats`), `a-stats:${event.id}`);
  const [preview, setPreview] = useState<PreviewStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = event.state !== 'purged';

  useEffect(() => {
    if (!live) return;
    session.api<PreviewStatsResponse>({ op: 'previewStats', eid: event.id }).then(setPreview, (e) => setError(errorMessage(e)));
  }, [session, event.id, live]);

  const savedList = saved.status === 'ok' ? saved.data : [];
  return (
    <>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      {savedList.map((s) => (
        <StatsView key={s.id} title={`${s.date} の統計（保存済み）`} s={s} themes={event.themes} />
      ))}
      {live && (preview ? <StatsView title="いまの整理券からの試算" s={preview} themes={event.themes} /> : !error && <Loading />)}
      {!live && savedList.length === 0 && saved.status === 'ok' && <p className="p">保存された統計はありません。</p>}
    </>
  );
}

function minutes(sec: number): string {
  return `${Math.round(sec / 60)}分`;
}

function StatsView({ title, s, themes }: { title: string; s: PreviewStatsResponse; themes: string[] }) {
  const grades = [...GRADES, ...Object.keys(s.gradeTheme).filter((g) => !(GRADES as readonly string[]).includes(g))];
  const themeCols = [...themes, ...new Set(Object.values(s.gradeTheme).flatMap((t) => Object.keys(t)))].filter((t, i, a) => a.indexOf(t) === i);
  const hours = Object.keys(s.issuedByHour).sort((a, b) => Number(a) - Number(b));
  const max = Math.max(1, ...Object.values(s.issuedByHour));
  return (
    <section className="card pad">
      <h2 className="t2">{title}</h2>
      <div className="stats" style={{ fontSize: 16 }}>
        <span>
          発券 <b>{s.issued}</b>
        </span>
        <span>
          完了 <b>{s.completed}</b>
        </span>
        <span>
          キャンセル <b>{s.canceled}</b>
        </span>
        <span>
          無効 <b>{s.expired}</b>
        </span>
        <span>
          平均の待ち <b>{minutes(s.avgWaitSeconds)}</b>
        </span>
        <span>
          平均の相談 <b>{minutes(s.avgConsultSeconds)}</b>
        </span>
      </div>

      <h3 className="hl">学年 × テーマ</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th />
              {themeCols.map((t) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grades.map((g) => (
              <tr key={g}>
                <th>{g}</th>
                {themeCols.map((t) => (
                  <td key={t} className="num">
                    {s.gradeTheme[g]?.[t] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="hl">時間帯別の発券数</h3>
      {hours.length === 0 ? (
        <p className="small p">まだありません。</p>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {hours.map((h) => (
            <div key={h} className="row">
              <span className="num" style={{ width: 48 }}>
                {h}時
              </span>
              <span style={{ height: 16, width: `${(s.issuedByHour[h]! / max) * 70}%`, background: 'var(--p-light)', boxShadow: 'inset 0 0 0 1px var(--p-ink)' }} />
              <span className="num">{s.issuedByHour[h]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
