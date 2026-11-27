// 定期処理が書き込む運用状態（常駐台数・本日の Firestore 読み取り回数）の表示バー
import { FIRESTORE_FREE_READS_PER_DAY, paths, type RuntimeStatusDoc } from '@nt/shared';
import { useDoc } from '../lib/hooks';
import type { AdminSession } from './session';
import { formatClock } from './time';

export function RuntimeStatusBar({ session }: { session: AdminSession }) {
  const status = useDoc<RuntimeStatusDoc>(session.db, paths.runtimeStatus);
  const data = status.status === 'ok' ? status.data : null;
  const hot = data?.hotInstances ?? null;
  const reads = data?.firestoreReads ?? null;
  const pct = reads ? Math.round((reads.today / FIRESTORE_FREE_READS_PER_DAY) * 100) : null;
  const readsWarn = reads ? reads.today >= FIRESTORE_FREE_READS_PER_DAY * 0.8 : false;
  const readsOver = reads ? reads.today >= FIRESTORE_FREE_READS_PER_DAY : false;

  return (
    <section className="panel" aria-label="システムの運用状態">
      <div style={{ flexWrap: 'wrap', gap: '8px 20px', minHeight: 44 }}>
        <div className="stats" style={{ gap: '6px 20px' }}>
          <span>
            発券・呼出の常駐
            {hot ? (
              <>
                <span className={`st ${hot.applied === 1 ? 'st-available' : 'st-preparing'}`}>
                  {hot.applied === 1 ? '常駐中（オン）' : '待機オフ（0）'}
                </span>
                <span className="small">（{formatClock(hot.checkedAt.toMillis())} 確認）</span>
              </>
            ) : (
              <span className="st st-preparing">未取得</span>
            )}
          </span>
          <span>
            本日のDB読み取り
            {reads ? (
              <>
                <b className="num" style={readsOver ? { color: 'var(--p-danger)' } : readsWarn ? { color: 'var(--p-warning)' } : undefined}>
                  {reads.today.toLocaleString()}
                </b>
                <span className="small num">
                  / {FIRESTORE_FREE_READS_PER_DAY.toLocaleString()}回（{pct}%・{formatClock(reads.updatedAt.toMillis())} 更新）
                </span>
                {readsOver ? (
                  <span className="st st-paused" style={{ background: 'var(--p-danger-wash)', color: 'var(--p-danger)' }}>
                    無料枠超過
                  </span>
                ) : readsWarn ? (
                  <span className="st st-paused">無料枠80%超</span>
                ) : null}
              </>
            ) : (
              <b>—</b>
            )}
          </span>
        </div>
        <span className="small">開場30分前に自動で常駐オン・閉場後にオフ／DB読み取りは当日（JST）の目安（数分遅延）</span>
      </div>
    </section>
  );
}
