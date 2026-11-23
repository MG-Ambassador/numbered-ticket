// board/public の計算（V-02・V-04）。queues を書き換えるトランザクションの中で、その枠の分だけ書き直す。
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { paths, type BoardSlot, type EventDoc, type QueueDoc, type SlotDoc } from '@nt/shared';

export function computeBoardSlot(event: EventDoc, slot: SlotDoc, queue: QueueDoc): BoardSlot {
  const activeBooths = queue.booths.length;
  const waitingCount = queue.waiting.length;
  const full = waitingCount >= slot.queueLimit;

  let status: BoardSlot['status'];
  let pauseReason: BoardSlot['pauseReason'] = null;
  if (event.paused) {
    status = 'paused';
    pauseReason = 'global';
  } else if (activeBooths === 0) {
    status = 'preparing';
  } else if (slot.paused) {
    status = 'paused';
    pauseReason = 'staff';
  } else if (full) {
    status = 'paused';
    pauseReason = 'limit';
  } else if (waitingCount === 0 && queue.serving.length < activeBooths) {
    status = 'available';
  } else {
    status = 'accepting';
  }

  const recent = queue.recentDurations;
  const avgConsultSeconds =
    recent.length > 0 ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : event.consultMinutes * 60;

  return {
    kind: slot.kind,
    status,
    pauseReason,
    waitingNumbers: queue.waiting.map((e) => e.number),
    servingNumbers: queue.serving.map((e) => e.number),
    avgConsultSeconds,
    activeBooths,
    queueLimit: slot.queueLimit,
  };
}

/**
 * board/public の slots.<slotId> と全体の停止を書き直す。
 * board 自体は読まない（読むと全枠のトランザクションが board で競合するため）。
 */
export function writeBoardSlot(
  tx: Transaction,
  db: Firestore,
  eid: string,
  slotId: string,
  event: EventDoc,
  slot: SlotDoc,
  queue: QueueDoc,
  now: Date,
): void {
  const ref = db.doc(paths.board(eid));
  tx.set(
    ref,
    { slots: { [slotId]: computeBoardSlot(event, slot, queue) }, paused: event.paused, updatedAt: Timestamp.fromDate(now) },
    { merge: true },
  );
}
