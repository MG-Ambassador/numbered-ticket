// A-04 枠の登録（CSV 一括取込・個別編集・削除）と教員相談の紹介文
import { useState, type FormEvent } from 'react';
import { collection, orderBy, query } from 'firebase/firestore';
import {
  FACULTY_SLOT_ID,
  paths,
  type FacultyProfile,
  type FacultySlotDoc,
  type ImportSlotsResponse,
  type SlotDoc,
  type SlotRowError,
  type StudentSlotDoc,
  type StudentSlotInput,
} from '@nt/shared';
import { errorMessage, toApiError } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Notice } from '../ui';
import type { AdminEvent } from './Console';
import { useConfirm } from './Confirm';
import type { AdminSession } from './session';

/** functions/src/core/slotInput.ts の LIMITS と同じ（入力欄の上限に使う。確かめるのは関数側） */
const LIMITS = { nickname: 20, department: 40, bio: 200, tags: 5, location: 8, facultyTitle: 40, facultyDescription: 400 };
const CSV_HEADER = 'id,nickname,department,bio,tags,location,order';

type Student = StudentSlotDoc & { id: string };

export function SlotsAdmin({ session, event }: { session: AdminSession; event: AdminEvent }) {
  const eid = event.id;
  const slots = useQuery<SlotDoc>(query(collection(session.db, paths.slots(eid)), orderBy('order')), `a-slots-edit:${eid}`);
  const [editing, setEditing] = useState<Student | 'new' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { confirm, element } = useConfirm();

  const students = slots.status === 'ok' ? slots.data.filter((s): s is Student => s.kind === 'student') : [];
  const faculty = slots.status === 'ok' ? (slots.data.find((s) => s.id === FACULTY_SLOT_ID) as (FacultySlotDoc & { id: string }) | undefined) : undefined;

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  }

  return (
    <>
      {element}
      {msg && (
        <Notice kind={msg.ok ? 'ok' : 'danger'} icon={msg.ok ? 'check' : 'alert'} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <section className="card pad">
        <div className="between">
          <h1 className="t2">学生相談の枠（{students.length}）</h1>
          <button className="btn2" onClick={() => setEditing('new')}>
            枠を足す
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>位置</th>
                <th>ニックネーム・所属</th>
                <th>タグ</th>
                <th>ID</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td>{s.location ?? '—'}</td>
                  <td>
                    <b style={{ fontWeight: 500 }}>{s.profile.nickname}</b>
                    <div className="small">{s.profile.department}</div>
                  </td>
                  <td className="small">{s.profile.tags.map((t) => `#${t}`).join(' ')}</td>
                  <td className="small">
                    <code>{s.id}</code>
                  </td>
                  <td>
                    <div className="row">
                      <button className="btn2" onClick={() => setEditing(s)}>
                        直す
                      </button>
                      <button
                        className="quiet"
                        onClick={() =>
                          confirm({
                            title: `${s.profile.nickname} の枠を消しますか`,
                            body: '並んでいる方や担当のいる枠は消せません。',
                            confirmLabel: '消す',
                            danger: true,
                            run: () => act(() => session.api({ op: 'deleteSlot', eid, slotId: s.id }), '枠を消しました。'),
                          })
                        }
                      >
                        消す
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <CsvImport session={session} eid={eid} students={students} />
      {faculty && <FacultyForm session={session} eid={eid} profile={faculty.profile} />}

      {editing && (
        <SlotEditor
          session={session}
          eid={eid}
          slot={editing === 'new' ? null : editing}
          nextOrder={students.reduce((m, s) => Math.max(m, s.order + 1), 0)}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMsg({ ok: true, text });
          }}
        />
      )}
    </>
  );
}

function RowErrors({ rows }: { rows: SlotRowError[] }) {
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
      {rows.map((r, i) => (
        <li key={i}>
          {r.row > 0 ? `${r.row}行目` : '全体'}
          {r.field ? `（${r.field}）` : ''}: {r.message}
        </li>
      ))}
    </ul>
  );
}

function SlotEditor({ session, eid, slot, nextOrder, onClose, onSaved }: { session: AdminSession; eid: string; slot: Student | null; nextOrder: number; onClose: () => void; onSaved: (text: string) => void }) {
  const [nickname, setNickname] = useState(slot?.profile.nickname ?? '');
  const [department, setDepartment] = useState(slot?.profile.department ?? '');
  const [bio, setBio] = useState(slot?.profile.bio ?? '');
  const [tags, setTags] = useState(slot?.profile.tags.join(' ') ?? '');
  const [location, setLocation] = useState(slot?.location ?? '');
  const [order, setOrder] = useState(slot?.order ?? nextOrder);
  const [error, setError] = useState<{ text: string; rows?: SlotRowError[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input: StudentSlotInput = {
      ...(slot ? { id: slot.id } : {}),
      nickname: nickname.trim(),
      department: department.trim(),
      bio: bio.trim(),
      tags: tags.split(/[\s、,;；]+/).filter(Boolean),
      location: location.trim() || null,
      order,
    };
    setBusy(true);
    setError(null);
    try {
      await session.api<ImportSlotsResponse>({ op: 'upsertSlot', eid, slot: input });
      onSaved(slot ? '保存しました。' : '枠を足しました。');
    } catch (err) {
      const a = toApiError(err);
      setError({ text: a.message, rows: a.details?.rows });
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="slot-title" onSubmit={submit}>
        <div className="grip" />
        <span className="hl" id="slot-title">
          {slot ? `${slot.profile.nickname} を直す` : '学生相談の枠を足す'}
        </span>
        <p className="small p">実名・URL・SNS の ID は登録できません。位置を変えると、担当中の学生の案内先も変わります。</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field grow">
            <label className="label" htmlFor="sl-nick">
              ニックネーム
            </label>
            <input id="sl-nick" className="in" maxLength={LIMITS.nickname} value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </div>
          <div className="field" style={{ width: 120 }}>
            <label className="label" htmlFor="sl-loc">
              位置
            </label>
            <input id="sl-loc" className="in" maxLength={LIMITS.location} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="A-3" />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label className="label" htmlFor="sl-order">
              並び順
            </label>
            <input id="sl-order" className="in" type="number" min={0} max={999} value={order} onChange={(e) => setOrder(Number(e.target.value))} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="sl-dept">
            学部・学科・学年
          </label>
          <input id="sl-dept" className="in" maxLength={LIMITS.department} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="心理学部 2年" />
        </div>
        <div className="field">
          <label className="label" htmlFor="sl-bio">
            自己紹介（{LIMITS.bio}字まで）
          </label>
          <textarea id="sl-bio" className="ta" rows={4} maxLength={LIMITS.bio} value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="sl-tags">
            タグ（空白か読点で区切る。{LIMITS.tags}個まで。# は不要）
          </label>
          <input id="sl-tags" className="in" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="留学 奨学金" />
        </div>
        {error && (
          <Notice kind="danger" icon="alert">
            {error.text}
            {error.rows && <RowErrors rows={error.rows} />}
          </Notice>
        )}
        <button className="btn" type="submit" disabled={busy || !nickname.trim()}>
          保存する
        </button>
        <button className="btn2" type="button" onClick={onClose}>
          やめる
        </button>
      </form>
    </div>
  );
}

function CsvImport({ session, eid, students }: { session: AdminSession; eid: string; students: Student[] }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string; rows?: SlotRowError[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await session.api<ImportSlotsResponse>({ op: 'importSlots', eid, csv });
      setResult({ ok: true, text: `${res.slotIds.length}件を取り込みました。` });
      setCsv('');
    } catch (err) {
      const a = toApiError(err);
      setResult({ ok: false, text: `${a.message}。1行でも誤りがあると何も取り込みません。`, rows: a.details?.rows });
    } finally {
      setBusy(false);
    }
  }

  /** 今の枠を CSV にする（直してから取り込み直すため） */
  function current(): string {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [CSV_HEADER, ...students.map((s) => [s.id, s.profile.nickname, s.profile.department, s.profile.bio, s.profile.tags.join(' '), s.location ?? '', String(s.order)].map(q).join(','))].join('\n');
  }

  return (
    <section className="card pad">
      <h2 className="t2">CSV でまとめて取り込む</h2>
      <p className="small p">
        1行目は <code>{CSV_HEADER}</code>。<code>id</code> が空の行は新しい枠、ID があれば既存の枠を直します（担当・上限・停止はそのまま）。タグは空白・読点・セミコロンで区切ります。1回 50 行まで。
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="btn2" style={{ cursor: 'pointer' }}>
          ファイルを選ぶ
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) setCsv(await f.text());
            }}
          />
        </label>
        <button className="btn2" onClick={() => setCsv(current())} disabled={students.length === 0}>
          今の枠を書き出す
        </button>
      </div>
      <textarea className="ta" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={`${CSV_HEADER}\n,ゆい,国際学部 4年,カナダに留学しました。,留学 総合型選抜,A-1,0`} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14 }} />
      {result && (
        <Notice kind={result.ok ? 'ok' : 'danger'} icon={result.ok ? 'check' : 'alert'}>
          {result.text}
          {result.rows && <RowErrors rows={result.rows} />}
        </Notice>
      )}
      <button className="btn" onClick={run} disabled={busy || !csv.trim()}>
        取り込む
      </button>
    </section>
  );
}

function FacultyForm({ session, eid, profile }: { session: AdminSession; eid: string; profile: FacultyProfile }) {
  const [title, setTitle] = useState(profile.title);
  const [fields, setFields] = useState(profile.fields.join('\n'));
  const [description, setDescription] = useState(profile.description);
  const [result, setResult] = useState<{ ok: boolean; text: string; rows?: SlotRowError[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await session.api({
        op: 'updateFacultyProfile',
        eid,
        profile: { title: title.trim(), fields: fields.split('\n').map((f) => f.trim()).filter(Boolean), description: description.trim() },
      });
      setResult({ ok: true, text: '保存しました。' });
    } catch (err) {
      const a = toApiError(err);
      setResult({ ok: false, text: a.message, rows: a.details?.rows });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card pad" onSubmit={submit}>
      <h2 className="t2">教員相談の紹介</h2>
      <div className="field">
        <label className="label" htmlFor="f-title">
          表示名
        </label>
        <input id="f-title" className="in" maxLength={LIMITS.facultyTitle} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="f-fields">
          相談できる分野（1行に1つ、10個まで）
        </label>
        <textarea id="f-fields" className="ta" rows={4} value={fields} onChange={(e) => setFields(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="f-desc">
          説明（{LIMITS.facultyDescription}字まで）
        </label>
        <textarea id="f-desc" className="ta" rows={4} maxLength={LIMITS.facultyDescription} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {result && (
        <Notice kind={result.ok ? 'ok' : 'danger'} icon={result.ok ? 'check' : 'alert'}>
          {result.text}
          {result.rows && <RowErrors rows={result.rows} />}
        </Notice>
      )}
      <button className="btn" type="submit" disabled={busy || !title.trim()}>
        保存する
      </button>
    </form>
  );
}
