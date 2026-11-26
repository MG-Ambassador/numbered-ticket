// A-02 イベント設定（作成・変更）
import { useState, type FormEvent } from 'react';
import { DEFAULTS, type CreateEventResponse, type EventSettings } from '@nt/shared';
import { errorMessage } from '../lib/api';
import { Notice } from '../ui';
import type { AdminEvent } from './Console';
import type { AdminSession } from './session';
import { fromJstInput, toJstInput } from './time';

const DEFAULT_THEMES = ['入試・選抜方法', '学部・学科の学び', '学生生活', '就職・資格', '費用・奨学金', 'その他'];

export function EventForm({ session, event, onSaved, onCancel }: { session: AdminSession; event: AdminEvent | null; onSaved: (eid?: string) => void; onCancel?: () => void }) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [opensAt, setOpensAt] = useState(event ? toJstInput(event.opensAt.toMillis()) : '');
  const [closesAt, setClosesAt] = useState(event ? toJstInput(event.closesAt.toMillis()) : '');
  const [consult, setConsult] = useState(event?.consultMinutes ?? DEFAULTS.consultMinutes);
  const [skip, setSkip] = useState(event?.skipReturnMinutes ?? DEFAULTS.skipReturnMinutes);
  const [themes, setThemes] = useState((event?.themes ?? DEFAULT_THEMES).join('\n'));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const settings: EventSettings = {
      title: title.trim(),
      opensAt: fromJstInput(opensAt),
      closesAt: fromJstInput(closesAt),
      consultMinutes: consult,
      skipReturnMinutes: skip,
      themes: themes
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    setBusy(true);
    setMsg(null);
    try {
      if (event) {
        await session.api({ op: 'updateEvent', eid: event.id, settings });
        setMsg({ ok: true, text: '保存しました。' });
        onSaved();
      } else {
        const res = await session.api<CreateEventResponse>({ op: 'createEvent', settings });
        onSaved(res.eid);
      }
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const valid = title.trim() && opensAt && closesAt && closesAt > opensAt;
  return (
    <form className="list" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="e-title">
          名前（管理画面での表示。60文字まで）
        </label>
        <input id="e-title" className="in" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="2027年3月 オープンキャンパス" />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field grow">
          <label className="label" htmlFor="e-open">
            開場（JST）
          </label>
          <input id="e-open" className="in" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
        </div>
        <div className="field grow">
          <label className="label" htmlFor="e-close">
            閉場（JST）
          </label>
          <input id="e-close" className="in" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </div>
      </div>
      <p className="small p">開場時刻になると自動で受付が始まり、閉場時刻に残りの整理券を無効にして問診メモを消します。閉場の1時間後に統計を残して削除します。開場から閉場までは24時間以内、閉場は今より後にしてください（年や日付の入力違いを防ぐため）。開場後に開場時刻をあとへ変えると、入場した方がいなければ開場前に戻ります。</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="field grow">
          <label className="label" htmlFor="e-consult">
            1組の相談時間（分）
          </label>
          <input id="e-consult" className="in" type="number" min={1} max={60} value={consult} onChange={(e) => setConsult(Number(e.target.value))} />
        </div>
        <div className="field grow">
          <label className="label" htmlFor="e-skip">
            不在から復帰できる時間（分）
          </label>
          <input id="e-skip" className="in" type="number" min={1} max={60} value={skip} onChange={(e) => setSkip(Number(e.target.value))} />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="e-themes">
          相談テーマ（1行に1つ。20個まで、各20文字まで）
        </label>
        <textarea id="e-themes" className="ta" rows={6} value={themes} onChange={(e) => setThemes(e.target.value)} />
      </div>
      {msg && (
        <Notice kind={msg.ok ? 'ok' : 'danger'} icon={msg.ok ? 'check' : 'alert'}>
          {msg.text}
        </Notice>
      )}
      <div className="row">
        {onCancel && (
          <button type="button" className="btn2" onClick={onCancel}>
            やめる
          </button>
        )}
        <button className="btn grow" type="submit" disabled={busy || !valid}>
          {event ? '保存する' : '作成する'}
        </button>
      </div>
    </form>
  );
}
