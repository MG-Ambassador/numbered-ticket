// スタッフの画面（S-01 ログイン、S-02 担当設定、S-09 担当を外れる）。列の操作は Queue.tsx
import { useEffect, useState, type FormEvent } from 'react';
import { signInAnonymously, signOut } from 'firebase/auth';
import { collection, orderBy, query } from 'firebase/firestore';
import {
  FUNCTION_NAMES,
  formatDuration,
  formatStaffCode,
  paths,
  type ClaimSlotRequest,
  type EventDoc,
  type SetBoothRequest,
  type SlotDoc,
  type StaffDoc,
  type StaffLoginRequest,
  type StaffLoginResponse,
  type StaffRole,
  type StudentSlotDoc,
} from '@nt/shared';
import { clients } from '../firebase';
import { call, errorMessage, toApiError } from '../lib/api';
import { useAuthState, useDoc, useNow, useQuery } from '../lib/hooks';
import { Header, Loading, Notice } from '../ui';
import { Queue } from './Queue';

const c = clients('staff');
export type StaffClients = typeof c;

export interface StaffContext {
  c: StaffClients;
  eid: string;
  uid: string;
  role: StaffRole;
  event: EventDoc;
  staff: StaffDoc;
}

export function StaffApp() {
  const auth = useAuthState(c.auth);
  const role = auth.claims.role === 'student' || auth.claims.role === 'faculty' ? (auth.claims.role as StaffRole) : null;
  const eid = role && typeof auth.claims.eid === 'string' ? auth.claims.eid : null;
  const uid = auth.user?.uid ?? null;
  const event = useDoc<EventDoc>(c.db, eid ? paths.event(eid) : null);
  const staff = useDoc<StaffDoc>(c.db, eid && uid ? paths.staff(eid, uid) : null);

  useHeartbeat(!!eid);

  if (!auth.ready) return <Loading />;
  const ev = event.status === 'ok' ? event.data : null;
  if (!eid || !role || !uid || event.status === 'error' || (event.status === 'ok' && (!ev || ev.state === 'purged'))) return <Login />;
  if (event.status === 'loading' || staff.status === 'loading' || !ev) return <Loading />;
  if (ev.state === 'closed') {
    return (
      <main className="page">
        <Header eyebrow="スタッフ · STAFF" />
        <div className="card pad">
          <h1 className="t2">閉場しました</h1>
          <p className="p">おつかれさまでした。残っていた整理券と問診メモは削除しました。</p>
        </div>
        <button className="quiet" onClick={() => void signOut(c.auth)}>
          この端末のログインを終える
        </button>
      </main>
    );
  }
  const st = staff.status === 'ok' ? staff.data : null;
  if (!st) return <Login />;

  const ctx: StaffContext = { c, eid, uid, role, event: ev, staff: st };
  if (role === 'student' && !st.slotId) return <ClaimSlot ctx={ctx} />;
  if (role === 'faculty' && !st.booth) return <SetBooth />;
  return <Queue ctx={ctx} />;
}

/** 生存確認（staff.lastSeenAt）。画面が見えている間だけ1分ごと */
function useHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const beat = () => {
      if (document.visibilityState === 'visible') void call(c.functions, FUNCTION_NAMES.heartbeat).catch(() => {});
    };
    const id = setInterval(beat, 60_000);
    return () => clearInterval(id);
  }, [enabled]);
}

// ---- S-01 ログイン ---------------------------------------------------------------

function Login() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockUntil, setLockUntil] = useState(0);
  const now = useNow();
  const locked = lockUntil > now;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 8) {
      setError('8桁のスタッフコードを入れてください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = c.auth.currentUser ?? (await signInAnonymously(c.auth)).user;
      await call<StaffLoginRequest, StaffLoginResponse>(c.functions, FUNCTION_NAMES.staffLogin, { code });
      await user.getIdToken(true);
    } catch (err) {
      const a = toApiError(err);
      if (a.reason === 'rateLimited' && a.details?.retryAfterSeconds) setLockUntil(Date.now() + a.details.retryAfterSeconds * 1000);
      else setError(a.reason === 'wrongCode' ? 'スタッフコードが違います。' : a.message);
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <Header eyebrow="スタッフ · STAFF" />
      <h1 className="t1">ログイン</h1>
      <form className="list" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="s-code">
            スタッフコード（8桁）
          </label>
          <p className="small p">担当ごとに違うコードです。学生スタッフは自分の枠のコード、教員スタッフは教員用のコードを入れてください。</p>
          <input
            id="s-code"
            className="code-in"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000-0000"
            maxLength={9}
            value={formatStaffCode(code)}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            disabled={locked}
          />
        </div>
        {locked ? (
          <Notice kind="warn" icon="clock">
            しばらく時間をおいてから、もう一度お試しください（あと {formatDuration(lockUntil - now)}）。
          </Notice>
        ) : (
          error && (
            <Notice kind="danger" icon="alert">
              {error}
            </Notice>
          )
        )}
        <button className="btn" type="submit" disabled={busy || locked}>
          {busy ? '確認しています' : 'ログインする'}
        </button>
      </form>
    </main>
  );
}

// ---- S-02 担当設定（学生: 枠の占有） ----------------------------------------------

function ClaimSlot({ ctx }: { ctx: StaffContext }) {
  const slots = useQuery<SlotDoc>(query(collection(c.db, paths.slots(ctx.eid)), orderBy('order')), `staff-slots:${ctx.eid}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim(slotId: string) {
    setBusy(slotId);
    setError(null);
    try {
      await call<ClaimSlotRequest>(c.functions, FUNCTION_NAMES.claimSlot, { slotId });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  // スタッフコードで決まった枠だけを出す
  const list =
    slots.status === 'ok'
      ? slots.data.filter((s): s is StudentSlotDoc & { id: string } => s.kind === 'student' && s.id === ctx.staff.allowedSlotId)
      : [];
  return (
    <main className="page">
      <Header eyebrow="スタッフ · STAFF" />
      <h1 className="t1">担当の枠</h1>
      <p className="small p">
        このスタッフコードで担当できる枠です。1つの枠は1台の端末だけが担当できます。ほかの端末が担当中のときは、その端末で「担当を外れる」を押すか、管理者に解除を頼んでください。
      </p>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      {slots.status === 'loading' && <Loading />}
      {slots.status === 'ok' && list.length === 0 && (
        <Notice kind="warn" icon="alert">
          このスタッフコードの枠が見つかりません。管理者に確かめてください。
        </Notice>
      )}
      <div className="list">
        {list.map((s) => {
          const taken = !!s.occupant;
          return (
            <div key={s.id} className="card pad" style={{ gap: 8 }}>
              <div className="between">
                <span className="eyebrow">学生相談{s.location ? ` ${s.location}` : ''}</span>
                {taken && <span className="st st-preparing">ほかの端末が担当中</span>}
              </div>
              <span className="hl">
                {s.profile.nickname} · {s.profile.department}
              </span>
              <button className="btn" disabled={taken || busy !== null} onClick={() => claim(s.id)}>
                {busy === s.id ? '担当しています' : 'この枠を担当して受付を始める'}
              </button>
            </div>
          );
        })}
      </div>
      <button className="quiet" onClick={() => void signOut(c.auth)}>
        ログインをやめる（コードを入れ直す）
      </button>
    </main>
  );
}

// ---- S-02 担当設定（教員: ブース番号） --------------------------------------------

function SetBooth() {
  const [booth, setBooth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call<SetBoothRequest>(c.functions, FUNCTION_NAMES.setBooth, { booth: booth.trim() });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <Header eyebrow="スタッフ · STAFF" />
      <h1 className="t1">座っているブース</h1>
      <p className="small p">教員相談は全学で一つの列です。ブースを設定すると、そのブースに次の方をお呼びできます。</p>
      <form className="list" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="s-booth">
            ブース番号（例: F-2）
          </label>
          <input id="s-booth" className="in" value={booth} maxLength={16} autoCapitalize="characters" onChange={(e) => setBooth(e.target.value)} />
        </div>
        {error && (
          <Notice kind="danger" icon="alert">
            {error}
          </Notice>
        )}
        <button className="btn" type="submit" disabled={busy || !booth.trim()}>
          このブースで始める
        </button>
      </form>
      <button className="quiet" onClick={() => void signOut(c.auth)}>
        ログインをやめる（コードを入れ直す）
      </button>
    </main>
  );
}
