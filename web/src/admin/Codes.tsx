// A-03 コードの表示・再発行。表示も再発行も auditLog に残る
import { Fragment, useState } from 'react';
import { entryUrl, formatCode, type ViewCodesResponse } from '@nt/shared';
import { errorMessage } from '../lib/api';
import { Notice } from '../ui';
import type { AdminEvent } from './Console';
import { useConfirm } from './Confirm';
import type { AdminSession } from './session';

export function Codes({ session, event }: { session: AdminSession; event: AdminEvent }) {
  const [codes, setCodes] = useState<ViewCodesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { confirm, element } = useConfirm();

  async function act(fn: () => Promise<ViewCodesResponse>) {
    setError(null);
    try {
      setCodes(await fn());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const url = codes ? entryUrl(location.origin, codes.entryCode) : null;
  const reissue = (kind: 'entry' | 'faculty' | 'slot', slotId?: string, label?: string) =>
    confirm({
      title:
        kind === 'entry' ? '入場コードを作り直しますか' : kind === 'faculty' ? '教員のスタッフコードを作り直しますか' : `「${label}」のスタッフコードを作り直しますか`,
      body:
        kind === 'entry'
          ? 'ポスターの QR と7桁が使えなくなります。貼り替えシールの準備をしてから行ってください。すでに入場した来場者はそのまま使えます。'
          : '新しくログインするスタッフには新しいコードを伝えてください。ログイン済みの端末はそのまま使えます。',
      confirmLabel: '作り直す',
      danger: true,
      run: () => act(() => session.api<ViewCodesResponse>({ op: 'reissueCode', eid: event.id, kind, ...(slotId ? { slotId } : {}) })),
    });

  return (
    <section className="card pad">
      {element}
      <h1 className="t2">コード</h1>
      <p className="small p">コードを表示すると、表示したことが操作の記録に残ります。人に見られない場所で開いてください。</p>
      {error && (
        <Notice kind="danger" icon="alert">
          {error}
        </Notice>
      )}
      {!codes ? (
        <button className="btn" onClick={() => act(() => session.api<ViewCodesResponse>({ op: 'viewCodes', eid: event.id }))}>
          コードを表示する
        </button>
      ) : (
        <>
          <div className="panel">
            <div>
              <span>
                入場コード（7桁・来場者）
                <br />
                <b className="big num">{formatCode(codes.entryCode)}</b>
              </span>
              <button className="btn2" onClick={() => reissue('entry')}>
                作り直す
              </button>
            </div>
            <hr />
            <div>
              <span>
                教員のスタッフコード（8桁・教員共通）
                <br />
                <b className="big num">{formatCode(codes.facultyCode)}</b>
              </span>
              <button className="btn2" onClick={() => reissue('faculty')}>
                作り直す
              </button>
            </div>
          </div>
          <span className="label">学生枠のスタッフコード（8桁・枠ごと）</span>
          <p className="small p">枠ごとに違うコードです。担当の学生には、その枠のコードだけを伝えてください。そのコードでログインした端末は、その枠だけを操作できます。</p>
          {codes.slotCodes.length === 0 ? (
            <p className="small p">学生枠がまだありません。枠を登録すると、ここにコードが出ます。</p>
          ) : (
            <div className="panel">
              {codes.slotCodes.map((s, i) => (
                <Fragment key={s.slotId}>
                  {i > 0 && <hr />}
                  <div>
                    <span>
                      {s.label || s.slotId}
                      <br />
                      <b className="big num">{s.code ? formatCode(s.code) : '—'}</b>
                    </span>
                    <button className="btn2" onClick={() => reissue('slot', s.slotId, s.label || s.slotId)}>
                      {s.code ? '作り直す' : '作る'}
                    </button>
                  </div>
                </Fragment>
              ))}
            </div>
          )}
          <div className="field">
            <span className="label">ポスターの QR に入れる URL</span>
            <div className="row">
              <code className="memo grow" style={{ overflowWrap: 'anywhere' }}>
                {url}
              </code>
              <button
                className="btn2"
                onClick={() => {
                  void navigator.clipboard?.writeText(url!).then(() => setCopied(true));
                }}
              >
                {copied ? 'コピーしました' : 'コピー'}
              </button>
            </div>
            <p className="small p">公開 URL が決まったら（未決事項 ⑪）、その URL で開いた管理画面からコピーしてください。いま開いている画面のアドレスで作っています。</p>
          </div>
          <button className="quiet" onClick={() => setCodes(null)}>
            コードを隠す
          </button>
        </>
      )}
    </section>
  );
}
