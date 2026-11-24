// A-05 当日の操作、A-06 ダッシュボード
import { useEffect, useState } from 'react';
import { collection, orderBy, query } from 'firebase/firestore';
import {
  BOARD_STATUS_LABELS,
  DEFAULTS,
  FACULTY_SLOT_ID,
  paths,
  type BoardDoc,
  type DashboardResponse,
  type QueueDoc,
  type SlotDoc,
  type StaffDoc,
} from '@nt/shared';
import { errorMessage } from '../lib/api';
import { useDoc, useNow, useQuery } from '../lib/hooks';
import { Icon, Notice, StatusChip, Switch } from '../ui';
import { EVENT_STATE_LABELS, type AdminEvent } from './Console';
import { useConfirm } from './Confirm';
import type { AdminSession } from './session';
import { formatClock, formatJst } from './time';

const WARNING_TEXT: Record<DashboardResponse['warnings'][number], string> = {
  issueSpike: '発券が急に増えています。入場コードが会場の外に広まっていないか確かめてください（「コード」で再発行できます）。',
  staffCodeFailures: 'スタッフコードの入力の失敗が増えています。',
  entryCodeFailures: '入場コードの入力の失敗が増えています。',
};
/** スタッフの生存確認がこれより古ければ注意（画面は1分ごとに送る） */
const STALE_MS = 3 * 60_000;

export function Today({ session, event }: { session: AdminSession; event: AdminEvent }) {
  const eid = event.id;
  const board = useDoc<BoardDoc>(session.db, paths.board(eid));
  const slots = useQuery<SlotDoc>(query(collection(session.db, paths.slots(eid)), orderBy('order')), `a-slots:${eid}`);
  const queues = useQuery<QueueDoc>(collection(session.db, `events/${eid}/queues`), `a-queues:${eid}`);
  const staff = useQuery<StaffDoc>(collection(session.db, `events/${eid}/staff`), `a-staff:${eid}`);
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, element } = useConfirm();
  const now = useNow(10_000);

  // A-06: 直近10分の発券数・失敗数。30秒ごとに取り直す
  useEffect(() => {
    let alive = true;
    const load = () =>
      session.api<DashboardResponse>({ op: 'dashboard', eid }).then(
        (d) => alive && setDash(d),
        (e) => alive && setError(errorMessage(e)),
      );
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session, eid]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const b = board.status === 'ok' ? board.data : null;
  const qById = new Map(queues.status === 'ok' ? queues.data.map((q) => [q.id, q]) : []);
  const staffById = new Map(staff.status === 'ok' ? staff.data.map((s) => [s.id, s]) : []);
  const slotList = slots.status === 'ok' ? slots.data : [];
  const totalWaiting = b ? Object.values(b.slots).reduce((n, s) => n + s.waitingNumbers.length, 0) : 0;
  const totalServing = b ? Object.values(b.slots).reduce((n, s) => n + s.servingNumbers.length, 0) : 0;

  function staffLabel(uid: string): { text: string; stale: boolean } {
    const s = staffById.get(uid);
    if (!s) return { text: '記録なし', stale: true };
    const ago = now - s.lastSeenAt.toMillis();
    return { text: `最終確認 ${formatClock(s.lastSeenAt.toMillis())}`, stale: ago > STALE_MS };
  }

  function forceRelease(slotId: string, staffUid: string, label: string) {
    confirm({
      title: `${label} の担当を外しますか`,
      body: '端末の故障や電池切れのときに使います。対応中の方は列に残り、次にこの列を担当したスタッフが引き継げます。外されたスタッフの端末では操作できなくなります。',
      confirmLabel: '担当を外す',
      danger: true,
      run: () => act(() => session.api({ op: 'forceRelease', eid, slotId, staffUid })),
    });
  }

  return (
    <>
      {element}
      {error && (
        <Notice kind="danger" icon="alert" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}

      <section className="card pad">
        <div className="between" style={{ flexWrap: 'wrap' }}>
          <h1 className="t2">
            {event.title} <span className="st st-accepting">{EVENT_STATE_LABELS[event.state]}</span>
          </h1>
          <span className="small">
            開場 {formatJst(event.opensAt.toMillis())} ／ 閉場 {formatJst(event.closesAt.toMillis())}
          </span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {event.state === 'scheduled' && (
            <button
              className="btn"
              style={{ width: 'auto' }}
              onClick={() =>
                confirm({
                  title: '開場しますか',
                  body: '開場時刻を待たずに受付を始めます。来場者が一覧を見られるようになり、スタッフが呼び出せるようになります。',
                  confirmLabel: '開場する',
                  run: () => act(() => session.api({ op: 'openEvent', eid })),
                })
              }
            >
              いま開場する
            </button>
          )}
          {(event.state === 'scheduled' || event.state === 'open') && (
            <button
              className="btn2 danger"
              onClick={() =>
                confirm({
                  title: '閉場しますか',
                  body: '残っている整理券をすべて無効にし、問診メモを消します。元に戻せません。閉場の1時間後に統計を残して削除します。',
                  confirmLabel: '閉場する',
                  danger: true,
                  run: () => act(() => session.api({ op: 'closeEvent', eid })),
                })
              }
            >
              いま閉場する
            </button>
          )}
        </div>
        {(event.state === 'scheduled' || event.state === 'open') && (
          <div className="panel">
            <div>
              <span>
                会場全体の受付を一時停止する
                <br />
                <span className="small">並んでいる方はそのまま呼べます。列ごとの停止の設定は、再開後も残ります。</span>
              </span>
              <Switch
                label="会場全体の受付を一時停止する"
                checked={event.paused}
                onChange={(paused) =>
                  confirm({
                    title: paused ? '会場全体の受付を止めますか' : '会場全体の受付を再開しますか',
                    body: paused ? 'すべての列で新しい整理券の受付を止めます。' : 'すべての列で受付を再開します（列ごとに止めている列は止まったまま）。',
                    confirmLabel: paused ? '一時停止する' : '再開する',
                    danger: paused,
                    run: () => act(() => session.api({ op: 'setGlobalPaused', eid, paused })),
                  })
                }
              />
            </div>
          </div>
        )}
      </section>

      <section className="card pad">
        <h2 className="t2">いまの様子</h2>
        <div className="stats" style={{ fontSize: 16 }}>
          <span>
            <Icon name="users" size={16} />
            待ち <b>{totalWaiting}組</b>
          </span>
          <span>
            <Icon name="bell" size={16} />
            呼出・相談中 <b>{totalServing}組</b>
          </span>
          {dash && (
            <>
              <span>
                直近10分の発券 <b>{dash.issuedLast10m}件</b>
              </span>
              <span>
                入場コードの失敗 <b>{dash.entryFailuresLast10m}件</b>
              </span>
              <span>
                スタッフコードの失敗 <b>{dash.staffFailuresLast10m}件</b>
              </span>
            </>
          )}
        </div>
        {dash?.warnings.map((w) => (
          <Notice key={w} kind="warn" icon="alert">
            {WARNING_TEXT[w]}
          </Notice>
        ))}
      </section>

      <section className="card pad">
        <h2 className="t2">列ごとの状態</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>枠</th>
                <th>状態</th>
                <th>待ち / 上限</th>
                <th>対応中</th>
                <th>担当</th>
                <th>受付停止</th>
              </tr>
            </thead>
            <tbody>
              {slotList.map((s) => {
                const bs = b?.slots[s.id];
                const q = qById.get(s.id);
                const range = s.kind === 'faculty' ? DEFAULTS.facultyQueueLimit : DEFAULTS.studentQueueLimit;
                const name = s.kind === 'student' ? `${s.location ?? ''} ${s.profile.nickname}`.trim() : '教員相談';
                return (
                  <tr key={s.id}>
                    <td>
                      <b style={{ fontWeight: 500 }}>{name}</b>
                    </td>
                    <td>
                      {bs ? <StatusChip slot={bs} /> : '—'}
                      {bs?.status === 'paused' && bs.pauseReason && (
                        <div className="small">{bs.pauseReason === 'global' ? '全体停止' : bs.pauseReason === 'limit' ? '上限到達' : '担当の停止'}</div>
                      )}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <button
                          className="icon-btn"
                          aria-label={`${name} の上限を減らす`}
                          disabled={s.queueLimit <= range.min}
                          onClick={() => act(() => session.api({ op: 'updateSlotSettings', eid, slotId: s.id, queueLimit: s.queueLimit - range.step }))}
                        >
                          <Icon name="minus" size={16} />
                        </button>
                        <span className="num" style={{ minWidth: 56, textAlign: 'center' }}>
                          {bs?.waitingNumbers.length ?? 0} / {s.queueLimit}
                        </span>
                        <button
                          className="icon-btn"
                          aria-label={`${name} の上限を増やす`}
                          disabled={s.queueLimit >= range.max}
                          onClick={() => act(() => session.api({ op: 'updateSlotSettings', eid, slotId: s.id, queueLimit: s.queueLimit + range.step }))}
                        >
                          <Icon name="plus" size={16} />
                        </button>
                      </span>
                    </td>
                    <td className="num">{bs?.servingNumbers.map((n) => `No.${n}`).join('、') || '—'}</td>
                    <td>
                      {(q?.booths ?? []).length === 0 && <span className="small">なし</span>}
                      {(q?.booths ?? []).map((booth) => {
                        const st = staffLabel(booth.staffUid);
                        const label = s.id === FACULTY_SLOT_ID ? `ブース ${booth.booth ?? '?'}` : name;
                        return (
                          <div key={booth.staffUid} className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                            {s.id === FACULTY_SLOT_ID && <span>ブース {booth.booth}</span>}
                            <span className={`small${st.stale ? ' warn-text' : ''}`}>{st.text}</span>
                            <button className="quiet" onClick={() => forceRelease(s.id, booth.staffUid, label)}>
                              強制解除
                            </button>
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      <Switch
                        label={`${name} の受付を一時停止する`}
                        checked={s.paused}
                        onChange={(paused) => act(() => session.api({ op: 'updateSlotSettings', eid, slotId: s.id, paused }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small p">
          状態の文言は来場者の一覧と同じです（{Object.values(BOARD_STATUS_LABELS).join('・')}）。最終確認が3分より古い担当は、端末が閉じている可能性があります。
        </p>
      </section>
    </>
  );
}
