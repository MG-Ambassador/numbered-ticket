// スタッフの列の操作（S-03〜S-09）
import { useEffect, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import {
  ACTIVE_TICKET_STATES,
  DEFAULTS,
  FACULTY_SLOT_ID,
  FUNCTION_NAMES,
  formatDuration,
  paths,
  type BoardDoc,
  type CallNextResponse,
  type QueueDoc,
  type ServingEntry,
  type SetQueueLimitRequest,
  type SetSlotPausedRequest,
  type SlotDoc,
  type TicketDoc,
  type TicketRequest,
} from '@nt/shared';
import { call, errorMessage } from '../lib/api';
import { useDoc, useNow, useQuery } from '../lib/hooks';
import { Header, Icon, Loading, Notice, Switch } from '../ui';
import type { StaffContext } from './StaffApp';

/** S-06: 完了・スキップは5秒待ってから送る */
const UNDO_MS = 5000;
/** S-04: 呼出3分超で口頭呼出を促す、相談15分超で注意色 */
const CALL_WARN_MS = 3 * 60_000;
const CONSULT_WARN_MS = 15 * 60_000;
/** 教員相談の列は長いので、先頭から何組まで出すか */
const FACULTY_ROWS = 10;

type Ticket = TicketDoc & { id: string };
interface Pending {
  kind: 'complete' | 'skip';
  ticketId: string;
  number: number;
  until: number;
}

export function Queue({ ctx }: { ctx: StaffContext }) {
  const { c, eid, uid, role, event, staff } = ctx;
  const slotId = role === 'faculty' ? FACULTY_SLOT_ID : staff.slotId!;
  const isFaculty = slotId === FACULTY_SLOT_ID;
  const myBooth = isFaculty ? staff.booth : null;

  const slot = useDoc<SlotDoc>(c.db, paths.slot(eid, slotId));
  const queue = useDoc<QueueDoc>(c.db, paths.queue(eid, slotId));
  const board = useDoc<BoardDoc>(c.db, paths.board(eid));
  // 担当の列の有効な整理券（学年・テーマ・問診メモ）。ルールは slotId だけで担当かを判定する
  const tickets = useQuery<TicketDoc>(
    query(collection(c.db, paths.tickets(eid)), where('slotId', '==', slotId), where('state', 'in', [...ACTIVE_TICKET_STATES])),
    `tickets:${eid}:${slotId}`,
  );
  const now = useNow(500);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  // S-06: 5秒たったら送る。画面を離れるときは待たずに送る
  function send(p: Pending) {
    const name = p.kind === 'complete' ? FUNCTION_NAMES.completeConsult : FUNCTION_NAMES.skipTicket;
    void run(() => call<TicketRequest>(c.functions, name, { ticketId: p.ticketId }));
  }
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => {
      setPending(null);
      send(pending);
    }, Math.max(0, pending.until - Date.now()));
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  useEffect(
    () => () => {
      if (pendingRef.current) send(pendingRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (slot.status === 'loading' || queue.status === 'loading') return <Loading />;
  const s = slot.status === 'ok' ? slot.data : null;
  const q = queue.status === 'ok' ? queue.data : null;

  // 管理者が担当を強制解除した（A-05）。occupant が自分でなくなると列は読めなくなる
  if (!s || !q || (s.kind === 'student' && s.occupant?.uid !== uid)) {
    return (
      <main className="page">
        <Header eyebrow="スタッフ · STAFF" />
        <Notice kind="warn" icon="alert">
          この枠の担当が外されました。管理者に確認のうえ、担当を選び直してください。
        </Notice>
        <button className="btn" onClick={() => void run(() => call(c.functions, FUNCTION_NAMES.releaseAssignment))} disabled={busy}>
          担当を選び直す
        </button>
      </main>
    );
  }

  const byId = new Map<string, Ticket>(tickets.status === 'ok' ? tickets.data.map((t) => [t.id, t]) : []);
  const bs = board.status === 'ok' ? board.data?.slots[slotId] : undefined;
  // 自分が対応中の1組。staffUid が null なのは前の担当が強制解除された整理券で、引き継げる
  const current: ServingEntry | undefined =
    q.serving.find((e) => e.staffUid === uid) ??
    q.serving.find((e) => e.staffUid === null && (!isFaculty || e.booth === myBooth));
  const curTicket = current ? byId.get(current.ticketId) : undefined;
  const skipped = q.skipped.filter((e) => !isFaculty || byId.get(e.ticketId)?.booth === myBooth);
  const range = isFaculty ? DEFAULTS.facultyQueueLimit : DEFAULTS.studentQueueLimit;
  const shownWaiting = isFaculty ? q.waiting.slice(0, FACULTY_ROWS) : q.waiting;
  const open = event.state === 'open';

  const pauseText =
    bs?.status === 'paused'
      ? bs.pauseReason === 'global'
        ? '会場全体の受付停止'
        : bs.pauseReason === 'limit'
          ? '上限に到達'
          : '担当の停止'
      : null;

  return (
    <>
      <main className="page with-bar">
        <Header eyebrow="スタッフ · STAFF" />
        <div className="col" style={{ gap: 2 }}>
          <span className="label">担当</span>
          <span className="hl">
            {s.kind === 'student' ? `学生相談${s.location ? ` ${s.location}` : ''} · ${s.profile.nickname}` : `教員相談 · ブース ${myBooth}`}
          </span>
        </div>
        {!open && (
          <Notice kind="info" icon="clock">
            開場前です。開場するとお呼び出しができます。
          </Notice>
        )}
        {error && (
          <Notice kind="danger" icon="alert" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}

        <div className="panel">
          <div>
            <span>列の上限{isFaculty ? '（全学）' : ''}</span>
            <span className="row" style={{ gap: 10 }}>
              <button
                className="icon-btn"
                aria-label={`上限を${range.step}減らす`}
                disabled={busy || s.queueLimit <= range.min}
                onClick={() => void run(() => call<SetQueueLimitRequest>(c.functions, FUNCTION_NAMES.setQueueLimit, { queueLimit: s.queueLimit - range.step }))}
              >
                <Icon name="minus" />
              </button>
              <span className="num center" style={{ minWidth: 56 }}>
                <b className="big">{s.queueLimit}</b>
                <span className="small"> 組</span>
              </span>
              <button
                className="icon-btn"
                aria-label={`上限を${range.step}増やす`}
                disabled={busy || s.queueLimit >= range.max}
                onClick={() => void run(() => call<SetQueueLimitRequest>(c.functions, FUNCTION_NAMES.setQueueLimit, { queueLimit: s.queueLimit + range.step }))}
              >
                <Icon name="plus" />
              </button>
            </span>
          </div>
          <hr />
          <div>
            <span>新しい受付を一時停止する</span>
            <Switch
              label="新しい受付を一時停止する"
              checked={s.paused}
              disabled={busy}
              onChange={(paused) => void run(() => call<SetSlotPausedRequest>(c.functions, FUNCTION_NAMES.setSlotPaused, { paused }))}
            />
          </div>
        </div>
        {pauseText && (
          <Notice kind="warn" icon="pause">
            <b style={{ fontWeight: 500 }}>受付を止めています（{pauseText}）。</b>並んでいる方はそのままお呼びできます。
          </Notice>
        )}

        {current && (
          <>
            <h2 className="t2" style={{ fontSize: 17 }}>
              対応中
            </h2>
            <Row t={curTicket} number={current.number} now={now} current arriving={!!curTicket?.arrivingAt} />
          </>
        )}

        <div className="between">
          <h2 className="t2">お待ちの方</h2>
          <span className="small">
            {q.waiting.length}組 / 上限 {s.queueLimit}組
          </span>
        </div>
        <div className="col" style={{ gap: 8 }}>
          {q.waiting.length === 0 && <p className="small p">お待ちの方はいません。</p>}
          {shownWaiting.map((e) => (
            <Row
              key={e.ticketId}
              t={byId.get(e.ticketId)}
              number={e.number}
              now={now}
              expanded={openRow === e.ticketId}
              onToggle={() => setOpenRow(openRow === e.ticketId ? null : e.ticketId)}
            />
          ))}
          {q.waiting.length > shownWaiting.length && <p className="small p">ほか {q.waiting.length - shownWaiting.length}組（全学の教員相談の列）</p>}
          {skipped.map((e) => (
            <div key={e.ticketId} className="skiprow">
              <span>
                不在 No.{e.number} · 復帰まで <b className="num" style={{ fontWeight: 500 }}>{formatDuration(e.returnDeadline.toMillis() - now)}</b>
              </span>
              <button
                className="btn2"
                style={{ minHeight: 44, padding: '0 14px' }}
                disabled={busy || e.returnDeadline.toMillis() < now}
                onClick={() => void run(() => call<TicketRequest>(c.functions, FUNCTION_NAMES.returnTicket, { ticketId: e.ticketId }))}
              >
                <Icon name="undo" size={16} />
                復帰
              </button>
            </div>
          ))}
        </div>

        {!current && !pending && (
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void run(() => call(c.functions, FUNCTION_NAMES.releaseAssignment))}
          >
            担当を外れる（列は残ります）
          </button>
        )}
      </main>

      <div className="bar">
        <div>
          {pending ? (
            <div className="undo" role="status">
              <span>
                No.{pending.number}
                {pending.kind === 'complete' ? ' の相談を終えます' : ' を不在にします'}（<span className="num">{Math.max(0, Math.ceil((pending.until - now) / 1000))}</span>秒）
              </span>
              <button onClick={() => setPending(null)}>
                <Icon name="undo" size={16} />
                取り消す
              </button>
              <i style={{ width: `${Math.max(0, ((pending.until - now) / UNDO_MS) * 100)}%` }} />
            </div>
          ) : !current ? (
            <>
              <div className="between small">
                <span className="row">
                  <Icon name="users" size={16} />
                  お待ちの方 {q.waiting.length}組
                </span>
                {isFaculty && <span>ブース {myBooth}</span>}
              </div>
              <button
                className="btn"
                disabled={busy || !open || q.waiting.length === 0}
                onClick={() => void run(() => call<undefined, CallNextResponse>(c.functions, FUNCTION_NAMES.callNext))}
              >
                <Icon name="bell" />
                次の方を呼ぶ
              </button>
            </>
          ) : current.state === 'calling' ? (
            <CallingBar
              entry={current}
              now={now}
              busy={busy}
              arriving={!!curTicket?.arrivingAt}
              onSkip={() => setPending({ kind: 'skip', ticketId: current.ticketId, number: current.number, until: Date.now() + UNDO_MS })}
              onStart={() => void run(() => call<TicketRequest>(c.functions, FUNCTION_NAMES.startConsult, { ticketId: current.ticketId }))}
            />
          ) : (
            <>
              <div className="between" style={{ fontSize: 14 }}>
                <span className="row">
                  <Icon name="clock" size={16} />
                  No.{current.number} とご相談中
                </span>
                <span className={`timer${now - current.since.toMillis() > CONSULT_WARN_MS ? ' warn-text' : ''}`}>{formatDuration(now - current.since.toMillis())}</span>
              </div>
              {now - current.since.toMillis() > CONSULT_WARN_MS && <span className="small warn-text">15分を過ぎました。</span>}
              <button
                className="btn"
                disabled={busy}
                onClick={() => setPending({ kind: 'complete', ticketId: current.ticketId, number: current.number, until: Date.now() + UNDO_MS })}
              >
                <Icon name="check" />
                相談を終える
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function CallingBar({ entry, now, busy, arriving, onSkip, onStart }: { entry: ServingEntry; now: number; busy: boolean; arriving: boolean; onSkip: () => void; onStart: () => void }) {
  const el = now - entry.since.toMillis();
  const late = el > CALL_WARN_MS;
  return (
    <>
      <div className="between" style={{ fontSize: 14 }}>
        <span className="row">
          <Icon name="bell" size={16} />
          No.{entry.number} をお呼び出し中{arriving ? '（向かっています）' : ''}
        </span>
        <span className={`timer${late ? ' warn-text' : ''}`}>{formatDuration(el)}</span>
      </div>
      <span className={`small${late ? ' warn-text' : ''}`}>{late ? '3分を過ぎました。口頭でもお呼びください。' : '3分を過ぎたら、口頭でもお呼びください。'}</span>
      <div className="row">
        <button className="btn2" style={{ minHeight: 52 }} disabled={busy} onClick={onSkip}>
          不在
        </button>
        <button className="btn grow" disabled={busy} onClick={onStart}>
          相談を始める
        </button>
      </div>
    </>
  );
}

/** S-03 待機リストの1行。タップで問診メモ */
function Row({
  t,
  number,
  now,
  current,
  arriving,
  expanded,
  onToggle,
}: {
  t: Ticket | undefined;
  number: number;
  now: number;
  current?: boolean;
  arriving?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const open = current || expanded;
  const mins = t ? Math.max(0, Math.floor((now - t.createdAt.toMillis()) / 60_000)) : null;
  const body = (
    <>
      <span className="between">
        <span className="hl">
          No.{number} · {t?.grade ?? '学年の回答なし'}
        </span>
        {arriving && <span className="st st-done">向かっています</span>}
      </span>
      <span className="tags">
        {t && t.themes.length ? t.themes.map((x) => `#${x}`).join(' ') : 'テーマの回答なし'}
        {mins !== null && ` · 待ち ${mins}分`}
        {t?.memo && !open ? ' · メモあり' : ''}
      </span>
      {open && <span className="memo">{t?.memo ?? 'メモはありません。'}</span>}
    </>
  );
  if (current) return <div className="qrow current">{body}</div>;
  return (
    <button className="qrow" aria-expanded={!!expanded} onClick={onToggle}>
      {body}
    </button>
  );
}
