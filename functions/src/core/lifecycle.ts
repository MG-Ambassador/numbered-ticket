// 開場・閉場（A-05・3.4）。定期処理（P2-4）もここを呼ぶ。
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { ACTIVE_TICKET_STATES, paths, type EventDoc, type QueueDoc } from '@nt/shared';
import { rebuildBoard } from './board.js';
import { getOrFail, runTx } from './common.js';
import { fail } from './errors.js';

/** scheduled → open。すでに open なら何もしない（false を返す） */
export async function openEvent(db: Firestore, eid: string, now: Date): Promise<boolean> {
  return runTx(db, async (tx) => {
    const ref = db.doc(paths.event(eid));
    const event = await getOrFail<EventDoc>(tx, ref);
    if (event.state === 'open') return false;
    if (event.state !== 'scheduled') fail('failed-precondition', 'invalidState');
    const next: EventDoc = { ...event, state: 'open', updatedAt: Timestamp.fromDate(now) };
    await rebuildBoard(tx, db, eid, next, now);
    tx.update(ref, { state: 'open', updatedAt: next.updatedAt });
    return true;
  });
}

const BATCH = 400;

/**
 * open（または scheduled）→ closed。残っている整理券を expired にし、問診メモを全削除する。
 * 1. まず状態を closed にする（以降の発券・呼出は eventNotOpen で止まり、購読もルールで止まる。7.4-4）
 * 2. 有効な整理券を expired にして memo を消す（件数が多いのでトランザクションではなくバッチで）
 * 3. 列を空にする
 * すでに closed / purged なら何もしない（false を返す）。途中で失敗しても、もう一度呼べば続きから進む。
 */
export async function closeEvent(db: Firestore, eid: string, now: Date): Promise<boolean> {
  const ref = db.doc(paths.event(eid));
  const changed = await runTx(db, async (tx) => {
    const event = await getOrFail<EventDoc>(tx, ref);
    if (event.state === 'closed' || event.state === 'purged') return false;
    tx.update(ref, { state: 'closed', updatedAt: Timestamp.fromDate(now) });
    return true;
  });
  await expireRemaining(db, eid, now);
  return changed;
}

/** 閉場後の後片付け。closed のイベントに対して何度呼んでもよい */
export async function expireRemaining(db: Firestore, eid: string, now: Date): Promise<number> {
  const ts = Timestamp.fromDate(now);
  const active = await db.collection(paths.tickets(eid)).where('state', 'in', [...ACTIVE_TICKET_STATES]).get();
  for (let i = 0; i < active.docs.length; i += BATCH) {
    const batch = db.batch();
    for (const d of active.docs.slice(i, i + BATCH)) {
      batch.update(d.ref, { state: 'expired', expiredAt: ts, memo: null, returnDeadline: null });
    }
    await batch.commit();
  }
  // 完了・キャンセル済みの memo は消してあるが、念のため残りも消す（索引から外しているので全件読む）
  const withMemo = (await db.collection(paths.tickets(eid)).get()).docs.filter((d) => d.get('memo') !== null);
  for (let i = 0; i < withMemo.length; i += BATCH) {
    const batch = db.batch();
    for (const d of withMemo.slice(i, i + BATCH)) batch.update(d.ref, { memo: null });
    await batch.commit();
  }
  const queues = await db.collection(`events/${eid}/queues`).get();
  const batch = db.batch();
  for (const q of queues.docs) {
    const queue = q.data() as QueueDoc;
    if (queue.waiting.length + queue.serving.length + queue.skipped.length > 0) {
      batch.update(q.ref, { waiting: [], serving: [], skipped: [], updatedAt: ts });
    }
  }
  await batch.commit();
  return active.size;
}
