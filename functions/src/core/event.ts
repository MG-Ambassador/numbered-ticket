import type { Firestore } from 'firebase-admin/firestore';
import type { EventDoc } from '@nt/shared';
import { fail } from './errors.js';

/**
 * 入場コード・スタッフコードの照合先のイベント。
 * QR やコードにはイベント ID を入れないため、開場前・開場中のイベントのうち開場時刻が最も早いものを使う。
 */
export async function findActiveEvent(db: Firestore): Promise<{ eid: string; event: EventDoc }> {
  const snap = await db.collection('events').where('state', 'in', ['scheduled', 'open']).get();
  const events = snap.docs
    .map((d) => ({ eid: d.id, event: d.data() as EventDoc }))
    .sort((a, b) => a.event.opensAt.toMillis() - b.event.opensAt.toMillis());
  const first = events[0];
  if (!first) fail('failed-precondition', 'noEvent');
  return first;
}
