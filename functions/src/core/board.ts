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

/** rebuildBoard に渡す、このトランザクションでまだ書いていない枠の内容。null は削除 */
export type BoardOverrides = Map<string, { slot: SlotDoc; queue: QueueDoc } | null>;

/**
 * board/public を全枠ぶん作り直す。全体停止・相談時間の変更・枠の追加と削除のときに使う。
 * 全枠の slots と queues を読むので、当日の頻繁な操作には使わない。
 * 読み取りを含むので、トランザクションの書き込みより前に呼ぶこと（Firestore は読み→書きの順しか許さない）。
 */
export async function rebuildBoard(
  tx: Transaction,
  db: Firestore,
  eid: string,
  event: EventDoc,
  now: Date,
  overrides: BoardOverrides = new Map(),
): Promise<void> {
  const [slots, queues] = await Promise.all([tx.get(db.collection(paths.slots(eid))), tx.get(db.collection(`events/${eid}/queues`))]);
  const merged = new Map<string, { slot?: SlotDoc; queue?: QueueDoc }>();
  for (const d of slots.docs) merged.set(d.id, { ...merged.get(d.id), slot: d.data() as SlotDoc });
  for (const d of queues.docs) merged.set(d.id, { ...merged.get(d.id), queue: d.data() as QueueDoc });
  for (const [id, v] of overrides) {
    if (v === null) merged.delete(id);
    else merged.set(id, v);
  }
  const out: Record<string, BoardSlot> = {};
  for (const [id, { slot, queue }] of merged) {
    if (slot && queue) out[id] = computeBoardSlot(event, slot, queue);
  }
  tx.set(db.doc(paths.board(eid)), { slots: out, paused: event.paused, updatedAt: Timestamp.fromDate(now) });
}
