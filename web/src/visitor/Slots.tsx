// V-02 相談種別の選択・相談員一覧、V-03 発券
import { useState } from 'react';
import { collection, orderBy, query } from 'firebase/firestore';
import {
  DEFAULTS,
  FACULTY_SLOT_ID,
  FUNCTION_NAMES,
  GRADES,
  estimateWaitMinutes,
  paths,
  type BoardDoc,
  type BoardSlot,
  type ErrorReason,
  type FacultySlotDoc,
  type Grade,
  type IssueTicketRequest,
  type IssueTicketResponse,
  type SlotDoc,
  type StudentSlotDoc,
  type TicketDoc,
} from '@nt/shared';
import { call, toApiError } from '../lib/api';
import { useDoc, useQuery } from '../lib/hooks';
import { Avatar, Header, Icon, Loading, Notice, StatusChip } from '../ui';
import type { VisitorContext } from './VisitorApp';

type SlotWithId = SlotDoc & { id: string };

const REASON_STATE: Partial<Record<ErrorReason, Pick<BoardSlot, 'status' | 'pauseReason'>>> = {
  full: { status: 'paused', pauseReason: 'limit' },
  slotPaused: { status: 'paused', pauseReason: 'staff' },
  globalPaused: { status: 'paused', pauseReason: 'global' },
  preparing: { status: 'preparing', pauseReason: null },
};

function estText(m: number): string {
  return m <= 0 ? 'まもなく' : `およそ ${m}分`;
}

/** 受け付けられない理由の文言（V-03「停止中・満員なら理由を表示」） */
function blockedText(b: BoardSlot, who: 'student' | 'faculty'): string | null {
  if (b.status === 'preparing') return who === 'student' ? 'まもなく受付を始めます。' : '教員がブースにつくまでお待ちください。';
  if (b.status !== 'paused') return null;
  if (b.pauseReason === 'global') return 'ただいま会場全体で新しい整理券の受付を一時停止しています。再開まで少しお待ちください。';
  if (b.pauseReason === 'limit')
    return who === 'student'
      ? 'ただいまこの相談員の列がいっぱいです。ほかの相談員をご覧いただくか、少し時間をおいてお試しください。'
      : 'ただいま教員相談の列がいっぱいです。少し時間をおいてお試しください。';
  return who === 'student'
    ? 'ただいまこの相談員は受付を一時停止しています。ほかの相談員をご覧ください。'
    : 'ただいま新しい整理券の受付を一時停止しています。再開まで少しお待ちください。';
}

export function Slots({ ctx }: { ctx: VisitorContext }) {
  const { c, eid, activeTicketId } = ctx;
  const board = useDoc<BoardDoc>(c.db, paths.board(eid));
  const slots = useQuery<SlotDoc>(query(collection(c.db, paths.slots(eid)), orderBy('order')), `slots:${eid}`);
  const active = useDoc<TicketDoc>(c.db, activeTicketId ? paths.ticket(eid, activeTicketId) : null);
  const [tab, setTab] = useState<'student' | 'faculty'>('student');
  const [filters, setFilters] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const all: SlotWithId[] = slots.status === 'ok' ? slots.data : [];
  const students = all.filter((s): s is StudentSlotDoc & { id: string } => s.kind === 'student');
  const faculty = all.find((s): s is FacultySlotDoc & { id: string } => s.id === FACULTY_SLOT_ID) ?? null;
  const tags = [...new Set(students.flatMap((s) => s.profile.tags))];

  if (board.status === 'loading' || slots.status === 'loading') return <Loading />;
  if (board.status === 'error' || slots.status === 'error' || !board.data) {
    return (
      <main className="page">
        <Notice kind="danger" icon="alert">
          一覧を読み込めませんでした。ページを再読み込みしてください。
        </Notice>
      </main>
    );
  }
  const b = board.data;
  const fb = b.slots[FACULTY_SLOT_ID];
  const shown = filters.length ? students.filter((s) => s.profile.tags.some((t) => filters.includes(t))) : students;
  const acceptingStudents = students.filter((s) => {
    const st = b.slots[s.id]?.status;
    return st === 'available' || st === 'accepting';
  }).length;

  function pick(id: string) {
    if (activeTicketId) {
      setMsg('整理券はお一人1枚までです。いまの整理券をキャンセルすると、ほかの相談を選べます。');
      return;
    }
    setSheet(id);
  }

  const activeNo = active.status === 'ok' && active.data ? active.data.number : null;

  return (
    <main className="page">
      <Header eyebrow="個別相談 · CONSULTATION" />
      {activeTicketId && (
        <button className="band" onClick={() => ctx.openTicket(activeTicketId)}>
          <span>整理券{activeNo ? ` No.${activeNo}` : ''} の順番を見る</span>
          <Icon name="chev" />
        </button>
      )}
      {msg && (
        <Notice kind="info" icon="alert" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      {b.paused && (
        <Notice kind="warn" icon="pause">
          ただいま会場全体で新しい整理券の受付を一時停止しています。整理券をお持ちの方はそのままお待ちください。
        </Notice>
      )}
      <h1 className="t1">
        相談を<span className="mark">えらぶ</span>
      </h1>
      <div className="seg" role="tablist" aria-label="相談の種類">
        <button role="tab" aria-selected={tab === 'student'} onClick={() => setTab('student')}>
          学生相談<span>{acceptingStudents}名が受付中</span>
        </button>
        <button role="tab" aria-selected={tab === 'faculty'} onClick={() => setTab('faculty')}>
          教員相談<span>待ち {fb?.waitingNumbers.length ?? 0}組</span>
        </button>
      </div>

      {tab === 'student' ? (
        <>
          {tags.length > 0 && (
            <div className="chips" role="group" aria-label="テーマで絞り込む（どれかに当てはまる相談員）">
              <button className="chip" aria-pressed={filters.length === 0} onClick={() => setFilters([])}>
                すべて
              </button>
              {tags.map((t) => {
                const on = filters.includes(t);
                return (
                  <button key={t} className="chip" aria-pressed={on} onClick={() => setFilters(on ? filters.filter((x) => x !== t) : [...filters, t])}>
                    {on && <Icon name="check" size={14} />}#{t}
                  </button>
                );
              })}
            </div>
          )}
          <div className="list">
            {shown.map((s) => {
              const bs = b.slots[s.id];
              return bs ? <StudentTile key={s.id} ctx={ctx} slot={s} b={bs} onPick={() => pick(s.id)} /> : null;
            })}
          </div>
          <p className="small p center">{filters.length ? `選んだテーマのどれかに当てはまる相談員（${shown.length}名）` : `学生相談 ${students.length}枠`}</p>
        </>
      ) : faculty && fb ? (
        <FacultyCard slot={faculty} b={fb} onPick={() => pick(FACULTY_SLOT_ID)} />
      ) : (
        <p className="small p">教員相談はありません。</p>
      )}

      {sheet && b.slots[sheet] && (
        <IssueSheet
          ctx={ctx}
          slot={all.find((s) => s.id === sheet)!}
          b={b.slots[sheet]!}
          onClose={() => setSheet(null)}
        />
      )}
    </main>
  );
}

function StudentTile({ ctx, slot, b, onPick }: { ctx: VisitorContext; slot: StudentSlotDoc & { id: string }; b: BoardSlot; onPick: () => void }) {
  const off = b.status === 'paused' || b.status === 'preparing';
  const w = b.waitingNumbers.length;
  const p = slot.profile;
  return (
    <button className="card tile" onClick={onPick} disabled={off}>
      <Avatar storage={ctx.c.storage} path={p.avatarPath} name={p.nickname} off={off} />
      <span className="tile-body">
        <span className="between">
          <span className="eyebrow">学生相談{slot.location ? ` ${slot.location}` : ''}</span>
          <StatusChip slot={b} />
        </span>
        <span className="hl">
          {p.nickname} · {p.department}
        </span>
        {p.tags.length > 0 && <span className="tags">{p.tags.map((t) => `#${t}`).join(' ')}</span>}
        {off ? (
          <span className="small">{blockedText(b, 'student')}</span>
        ) : (
          <span className="stats">
            <span>
              <Icon name="users" size={16} />
              {w ? (
                <>
                  あと <b>{w}組</b>
                </>
              ) : (
                '待ちなし'
              )}
            </span>
            <span>
              <Icon name="clock" size={16} />
              <b>{estText(estimateWaitMinutes(b, w))}</b>
            </span>
          </span>
        )}
      </span>
    </button>
  );
}

function FacultyCard({ slot, b, onPick }: { slot: FacultySlotDoc; b: BoardSlot; onPick: () => void }) {
  const blocked = blockedText(b, 'faculty');
  const w = b.waitingNumbers.length;
  return (
    <div className="card pad">
      <div className="between">
        <span className="eyebrow">教員相談 · FACULTY</span>
        <StatusChip slot={b} />
      </div>
      <h2 className="t2">{slot.profile.title}</h2>
      {slot.profile.description && <p className="p">{slot.profile.description}</p>}
      {slot.profile.fields.length > 0 && (
        <div className="chips" aria-label="相談できる分野">
          {slot.profile.fields.map((f) => (
            <span key={f} className="st st-progress">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="stats">
        <span>
          <Icon name="users" size={16} />
          待ち <b>{w}組</b>
        </span>
        <span>
          <Icon name="clock" size={16} />
          <b>{estText(estimateWaitMinutes(b, w))}</b>
        </span>
        <span>
          <Icon name="pin" size={16} />
          ブース {b.activeBooths}席
        </span>
      </div>
      {blocked && (
        <Notice kind="warn" icon="pause">
          {blocked}
        </Notice>
      )}
      <button className="btn" onClick={onPick} disabled={!!blocked}>
        教員相談の整理券を受け取る
      </button>
    </div>
  );
}

function IssueSheet({ ctx, slot, b, onClose }: { ctx: VisitorContext; slot: SlotWithId; b: BoardSlot; onClose: () => void }) {
  const { c, event } = ctx;
  const [grade, setGrade] = useState<Grade | null>(null);
  const [themes, setThemes] = useState<string[]>([]);
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = blockedText(b, slot.kind);
  const w = b.waitingNumbers.length;
  const memoLen = [...memo].length;

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await call<IssueTicketRequest, IssueTicketResponse>(c.functions, FUNCTION_NAMES.issueTicket, {
        slotId: slot.id,
        grade,
        themes,
        memo: memo.trim() || null,
      });
      ctx.openTicket(res.ticketId);
    } catch (e) {
      const err = toApiError(e);
      // 一覧を開いたあとで停止・満員になった場合も、一覧と同じ文言で理由を出す
      const state = err.reason ? REASON_STATE[err.reason] : undefined;
      setError(state ? blockedText({ ...b, ...state }, slot.kind) : err.message);
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="grip" />
        {slot.kind === 'faculty' ? (
          <div className="between">
            <div className="col" style={{ gap: 2 }}>
              <span className="eyebrow">教員相談 · FACULTY</span>
              <span className="hl" id="sheet-title">
                教員相談の整理券
              </span>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="閉じる">
              <Icon name="x" />
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <Avatar storage={c.storage} path={slot.profile.avatarPath} name={slot.profile.nickname} />
            <div className="col grow" style={{ gap: 2 }}>
              <span className="eyebrow">学生相談{slot.location ? ` ${slot.location}` : ''} · STUDENT</span>
              <span className="hl" id="sheet-title">
                {slot.profile.nickname} · {slot.profile.department}
              </span>
              {slot.profile.tags.length > 0 && <span className="tags">{slot.profile.tags.map((t) => `#${t}`).join(' ')}</span>}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="閉じる">
              <Icon name="x" />
            </button>
          </div>
        )}
        {slot.kind === 'faculty' ? (
          <p className="p">{slot.profile.description || '順番が来たら、空いたブースをお知らせします。'}</p>
        ) : (
          slot.profile.bio && <p className="p">{slot.profile.bio}</p>
        )}
        <div className="divider" />
        <fieldset>
          <legend className="label">学年（任意）</legend>
          <div className="chips">
            {GRADES.map((g) => (
              <button key={g} className="chip" aria-pressed={grade === g} onClick={() => setGrade(grade === g ? null : g)}>
                {g}
              </button>
            ))}
          </div>
        </fieldset>
        {event.themes.length > 0 && (
          <fieldset>
            <legend className="label">
              聞きたいテーマ（{DEFAULTS.maxThemes}つまで・{themes.length}つ選択中）
            </legend>
            <div className="chips">
              {event.themes.map((t) => {
                const on = themes.includes(t);
                return (
                  <button
                    key={t}
                    className="chip"
                    aria-pressed={on}
                    disabled={!on && themes.length >= DEFAULTS.maxThemes}
                    onClick={() => setThemes(on ? themes.filter((x) => x !== t) : [...themes, t])}
                  >
                    {on && <Icon name="check" size={14} />}
                    {t}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="field">
          <label className="label" htmlFor="v-note">
            聞きたいこと（任意・{DEFAULTS.memoMaxLength}字まで）
          </label>
          <textarea
            id="v-note"
            className="ta"
            rows={3}
            value={memo}
            onChange={(e) => setMemo([...e.target.value].slice(0, DEFAULTS.memoMaxLength).join(''))}
            placeholder="例：交換留学の選考では、英語の成績がどのくらい必要ですか。"
          />
          <div className="between small" style={{ fontSize: 13 }}>
            <span>氏名・学校名・連絡先は書かないでください。</span>
            <span className="num">
              {memoLen} / {DEFAULTS.memoMaxLength}
            </span>
          </div>
        </div>
        {error ? (
          <Notice kind="danger" icon="alert">
            {error}
          </Notice>
        ) : blocked ? (
          <Notice kind="warn" icon="pause">
            {blocked}
          </Notice>
        ) : (
          <div className="row small">
            <Icon name="clock" size={16} />
            <span>
              いま並ぶと、あと {w}組 · {estText(estimateWaitMinutes(b, w))}
            </span>
          </div>
        )}
        <button className="btn" onClick={issue} disabled={!!blocked || busy}>
          {busy ? '発券しています' : '整理券を受け取る'}
        </button>
      </div>
    </div>
  );
}
