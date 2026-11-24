// V-04 整理券モニター、V-05 呼出通知、V-06 キャンセル、V-07 スキップ復帰の案内、V-08 画面を消さない
import { useEffect, useRef, useState } from 'react';
import {
  CANCELABLE_TICKET_STATES,
  FACULTY_SLOT_ID,
  FUNCTION_NAMES,
  aheadOf,
  estimateWaitMinutes,
  formatDuration,
  paths,
  type BoardDoc,
  type SlotDoc,
  type TicketDoc,
  type TicketRequest,
} from '@nt/shared';
import { call, errorMessage } from '../lib/api';
import { navigate, useDoc, useNow } from '../lib/hooks';
import { Chip, Header, Icon, Loading, Notice, Switch } from '../ui';
import type { VisitorContext } from './VisitorApp';

const BASE_TITLE = document.title;

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 案内先（例: 学生相談 A-3 / 教員相談 ブース F-2） */
function boothText(t: TicketDoc): string {
  if (t.slotId === FACULTY_SLOT_ID) return t.booth ? `教員相談 ブース ${t.booth}` : '教員相談のブース';
  return t.booth ? `学生相談 ${t.booth}` : '学生相談のブース';
}

export function TicketView({ ctx, ticketId, onDone }: { ctx: VisitorContext; ticketId: string; onDone: () => void }) {
  const { c, eid, event } = ctx;
  const ticket = useDoc<TicketDoc>(c.db, paths.ticket(eid, ticketId));
  const t = ticket.status === 'ok' ? ticket.data : null;
  const board = useDoc<BoardDoc>(c.db, paths.board(eid));
  const slot = useDoc<SlotDoc>(c.db, t ? paths.slot(eid, t.slotId) : null);
  const now = useNow();
  const alerts = useCallAlerts(t);
  const wake = useWakeLock();
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (ticket.status === 'loading') return <Loading />;
  if (!t) {
    return (
      <main className="page">
        <Header eyebrow="整理券 · YOUR TICKET" />
        <Notice kind="warn" icon="alert">
          整理券を読み込めませんでした。
        </Notice>
        <button className="btn" onClick={onDone}>
          相談をえらぶ
        </button>
      </main>
    );
  }

  if (t.state === 'completed') {
    return (
      <main className="page door">
        <span className="ring" aria-label="明治学院大学">
          MG
        </span>
        <div className="seal" aria-label="完了の印">
          完了
        </div>
        <h1 className="display">
          ご相談
          <br />
          ありがとうございました
        </h1>
        <p className="p small">またキャンパスでお会いできるのを楽しみにしています。</p>
        <span className="dfo">DO FOR OTHERS</span>
        <div className="grow" />
        <button className="btn" onClick={onDone}>
          ほかの相談を見る
        </button>
      </main>
    );
  }

  if (t.state === 'expired' || t.state === 'canceled') {
    return (
      <main className="page">
        <Header eyebrow="整理券 · YOUR TICKET" />
        <div className="card pad">
          <span className="tk-no">
            <span style={{ fontSize: 20 }}>No.</span>
            <b style={{ color: 'var(--p-ink-faint)' }}>{t.number}</b>
          </span>
          <div>
            <Chip kind="void">{t.state === 'canceled' ? 'キャンセルしました' : 'この整理券は使えなくなりました'}</Chip>
          </div>
          <p className="p small">
            {t.state === 'canceled'
              ? '聞きたいことのメモも削除しました。'
              : 'お越しいただける時間を過ぎました。'}
            あらためて整理券をお受け取りいただけます。
          </p>
        </div>
        <div className="grow" />
        <button className="btn" onClick={onDone}>
          相談をえらび直す
        </button>
      </main>
    );
  }

  const b = board.status === 'ok' ? board.data?.slots[t.slotId] : undefined;
  const ahead = b ? aheadOf(b, t.number) : null;
  const est = b && ahead !== null ? estimateWaitMinutes(b, ahead) : null;
  const s = slot.status === 'ok' ? slot.data : null;
  const dest = t.slotId === FACULTY_SLOT_ID ? '教員相談' : s?.kind === 'student' ? `学生相談${s.location ? ` ${s.location}` : ''} · ${s.profile.nickname}（${s.profile.department}）` : '学生相談';
  const left = t.returnDeadline ? t.returnDeadline.toMillis() - now : 0;
  const cancelable = (CANCELABLE_TICKET_STATES as readonly string[]).includes(t.state);

  return (
    <main className="page">
      <Header eyebrow="整理券 · YOUR TICKET" />
      <div className="card hero">
        <div className="tk-top">
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <span className="tk-no">
              <span style={{ fontSize: 20, fontWeight: 500 }}>No.</span>
              <b>{t.number}</b>
            </span>
            <div className="seal" aria-label="受付の印">
              受付
            </div>
          </div>
          <div className="col" style={{ gap: 2 }}>
            <span className="eyebrow">ご案内先</span>
            <span className="hl">{dest}</span>
          </div>
          <div>
            {t.state === 'waiting' && <Chip kind="waiting">お待ちください</Chip>}
            {t.state === 'calling' && (
              <Chip kind="calling" icon="bell">
                お呼び出し中
              </Chip>
            )}
            {t.state === 'in_progress' && <Chip kind="progress">ご相談中</Chip>}
            {t.state === 'skipped' && (
              <Chip kind="skipped" icon="clock">
                あと {formatDuration(left)} のうちにお越しください
              </Chip>
            )}
          </div>
        </div>
        <div className="tear" aria-hidden="true" />
        <div className="tk-bottom" aria-live="polite">
          {t.state === 'waiting' && (
            <>
              <div className="col">
                <span className="small">前にお待ちの方</span>
                <span>
                  {ahead === null ? (
                    '—'
                  ) : ahead > 0 ? (
                    <>
                      あと <b className="big">{ahead}</b> 組
                    </>
                  ) : (
                    <b className="big" style={{ fontSize: 20 }}>
                      次の番です
                    </b>
                  )}
                </span>
              </div>
              <div className="col">
                <span className="small">目安の待ち時間</span>
                <span>
                  {est === null ? (
                    '—'
                  ) : est > 0 ? (
                    <>
                      およそ <b className="big">{est}</b> 分
                    </>
                  ) : (
                    <b className="big" style={{ fontSize: 20 }}>
                      まもなく
                    </b>
                  )}
                </span>
              </div>
              <span className="small span2">発券 {hhmm(t.createdAt.toMillis())} · 順番が来たら、この画面でお知らせします。目安の時間は前後します。</span>
            </>
          )}
          {t.state === 'calling' && (
            <>
              <p className="p span2">
                <b style={{ fontWeight: 500 }}>{boothText(t)}</b> へお越しください。
              </p>
              <button className="btn2 span2" onClick={alerts.reopen}>
                <Icon name="bell" size={16} />
                お呼び出しの画面を開く
              </button>
            </>
          )}
          {t.state === 'in_progress' && <p className="p span2">{boothText(t)} でご相談中です。</p>}
          {t.state === 'skipped' && (
            <p className="p span2">
              お呼びした時にお姿が見えませんでした。
              {left > 0 ? (
                <>
                  あと <b className="num" style={{ fontWeight: 500 }}>{formatDuration(left)}</b> のうちに {boothText(t)} へお越しいただければ、スタッフが列の先頭に戻してご案内します。
                </>
              ) : (
                'お越しいただける時間を過ぎました。まもなくこの整理券は使えなくなります。'
              )}
            </p>
          )}
        </div>
      </div>

      {(t.state === 'waiting' || t.state === 'skipped') && (
        <Notice kind="info" icon="phone">
          画面を閉じたりロックしたりすると、お呼び出しが届きません。この画面を開いたままお待ちください。お待ちのあいだ、ほかの企画をご覧いただけます。
        </Notice>
      )}

      <div className="panel">
        <div>
          <span className="row">
            <Icon name="phone" />
            <span>画面を消さない</span>
          </span>
          <Switch label="画面を消さない" checked={wake.on} onChange={wake.toggle} />
        </div>
        {wake.note && (
          <p className="small p" style={{ padding: '0 16px 10px' }}>
            {wake.note}
          </p>
        )}
        <hr />
        <div>
          <span className="row">
            <Icon name="vol" />
            <span>音で知らせる</span>
          </span>
          <Switch label="音で知らせる" checked={alerts.sound} onChange={alerts.setSound} />
        </div>
      </div>

      <div className="grow" />
      <button className="btn2" onClick={() => navigate('/slots')}>
        <Icon name="users" size={16} />
        ほかの相談員の様子を見る
      </button>
      {cancelable && (
        <button className="quiet" onClick={() => setConfirmCancel(true)}>
          この整理券をキャンセルする
        </button>
      )}

      {confirmCancel && <CancelConfirm ctx={ctx} ticketId={ticketId} number={t.number} onClose={() => setConfirmCancel(false)} />}
      {t.state === 'calling' && alerts.showCall && (
        <CallBanner
          t={t}
          nickname={s?.kind === 'student' ? s.profile.nickname : null}
          skipReturnMinutes={event.skipReturnMinutes}
          onAck={async () => {
            alerts.ack();
            // 「いま向かいます」をスタッフの画面に伝える。失敗しても案内は続ける
            await call<TicketRequest>(c.functions, FUNCTION_NAMES.markArriving, { ticketId }).catch(() => {});
          }}
        />
      )}
    </main>
  );
}

function CallBanner({ t, nickname, skipReturnMinutes, onAck }: { t: TicketDoc; nickname: string | null; skipReturnMinutes: number; onAck: () => void }) {
  const faculty = t.slotId === FACULTY_SLOT_ID;
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => btn.current?.focus(), []);
  return (
    <div className="call" role="alertdialog" aria-modal="true" aria-labelledby="call-title" aria-describedby="call-desc">
      <div className="between">
        <span className="eyebrow">
          <Icon name="bell" size={16} />
          お呼び出し · NOW CALLING
        </span>
        <span className="mg">MG</span>
      </div>
      <div className="col" style={{ marginTop: 12, gap: 2 }}>
        <span id="call-title" style={{ fontSize: 26, lineHeight: '38px', fontWeight: 500, letterSpacing: '.04em' }}>
          お呼び出しです
        </span>
        <span className="hl">整理券 No.{t.number} の方</span>
      </div>
      <div className="call-win">
        <span className="eyebrow" style={{ color: 'var(--p-ink)' }}>
          {faculty ? '教員相談 · BOOTH' : '学生相談 · BOOTH'}
        </span>
        <b>{t.booth ?? '—'}</b>
        {nickname && (
          <span className="small" style={{ color: 'var(--p-ink)' }}>
            相談員 {nickname}
          </span>
        )}
      </div>
      <p className="p" id="call-desc">
        {boothText(t)} へお越しください。
      </p>
      <div className="grow" />
      <button ref={btn} className="btn-on-ink" onClick={onAck}>
        いま向かいます
      </button>
      <p className="on-ink-soft">間に合わなかった場合も、{skipReturnMinutes}分以内にお越しいただければ先頭でご案内します。</p>
    </div>
  );
}

function CancelConfirm({ ctx, ticketId, number, onClose }: { ctx: VisitorContext; ticketId: string; number: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function cancel() {
    setBusy(true);
    try {
      await call<TicketRequest>(ctx.c.functions, FUNCTION_NAMES.cancelTicket, { ticketId });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="scrim">
      <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="cc-title">
        <div className="grip" />
        <span className="hl" id="cc-title">
          整理券 No.{number} をキャンセルしますか
        </span>
        <p className="p small">キャンセルすると、この順番には戻れません。聞きたいことのメモもすぐに消えます。</p>
        {error && (
          <Notice kind="danger" icon="alert">
            {error}
          </Notice>
        )}
        <button className="btn2 danger" onClick={cancel} disabled={busy}>
          キャンセルする
        </button>
        <button className="btn" onClick={onClose} disabled={busy}>
          整理券を持ったまま待つ
        </button>
      </div>
    </div>
  );
}

// ---- V-05 呼出通知: 全画面バナー・タブ名・振動・音（画面を開いている間のみ） ------------

function useCallAlerts(t: TicketDoc | null) {
  const [sound, setSoundState] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  /** 「いま向かいます」を押した呼出（calledAt で区別。復帰して呼ばれ直したらまた出す） */
  const [ackedAt, setAckedAt] = useState<number | null>(null);
  const calledAt = t?.state === 'calling' ? (t.calledAt?.toMillis() ?? 0) : null;
  const prev = useRef<number | null>(null);

  useEffect(() => {
    if (calledAt !== null && calledAt !== prev.current) {
      try {
        navigator.vibrate?.([300, 150, 300, 150, 300]);
      } catch {
        /* 振動できない端末（iOS） */
      }
      if (audio.current) beep(audio.current);
    }
    prev.current = calledAt;
  }, [calledAt]);

  useEffect(() => {
    document.title = calledAt !== null && t ? `【呼出】No.${t.number}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [calledAt, t]);

  function setSound(on: boolean) {
    setSoundState(on);
    if (on) {
      // iOS は利用者の操作の中で作らないと鳴らない
      audio.current ??= new AudioContext();
      void audio.current.resume();
      beep(audio.current, 1);
    }
    if (!on) {
      void audio.current?.close();
      audio.current = null;
    }
  }

  const arrived = !!t?.arrivingAt;
  return {
    sound,
    setSound,
    showCall: calledAt !== null && ackedAt !== calledAt && !arrived,
    ack: () => setAckedAt(calledAt),
    reopen: () => setAckedAt(null),
  };
}

function beep(ctx: AudioContext, times = 3): void {
  try {
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.1;
      o.connect(g);
      g.connect(ctx.destination);
      const at = ctx.currentTime + i * 0.35;
      o.start(at);
      o.stop(at + 0.2);
    }
  } catch {
    /* 音が出せない環境 */
  }
}

// ---- V-08 画面を消さない（Wake Lock） ------------------------------------------------

function useWakeLock() {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lock = useRef<WakeLockSentinel | null>(null);

  async function acquire() {
    try {
      lock.current = await navigator.wakeLock.request('screen');
      setNote(null);
    } catch {
      setNote('この端末では画面を消さない設定が使えません。端末の設定で自動ロックを長くしてください。');
      setOn(false);
    }
  }

  // ほかのアプリから戻ると解除されているので取り直す
  useEffect(() => {
    if (!on) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!lock.current || lock.current.released)) void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [on]);

  useEffect(() => () => void lock.current?.release(), []);

  function toggle(v: boolean) {
    setOn(v);
    if (v) {
      if (!('wakeLock' in navigator)) {
        setNote('この端末では画面を消さない設定が使えません。端末の設定で自動ロックを長くしてください。');
        setOn(false);
        return;
      }
      void acquire();
    } else {
      void lock.current?.release();
      lock.current = null;
      setNote(null);
    }
  }
  return { on, note, toggle };
}
