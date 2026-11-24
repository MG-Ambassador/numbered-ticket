// 画面（P3）の表示用の計算。関数に依存しないのでテストしやすいように shared に置く。
import type { BoardSlot } from './model.js';

/**
 * 目安の待ち時間（分、5分単位に切り上げ）。V-02・V-04。
 * ahead は自分より前に待っている組数（一覧で「いま並ぶと」を出すときは待ち組数そのもの）。
 *
 * 稼働ブースのうち空いている数（free）より ahead が少なければすぐ案内できるので 0。
 * それ以外は「何巡目で自分の番が来るか」× 平均相談時間。
 * 例: 学生（ブース1）で対応中1・前に2組 → 3巡 × 10分 = 30分
 */
export function estimateWaitMinutes(slot: Pick<BoardSlot, 'activeBooths' | 'servingNumbers' | 'avgConsultSeconds'>, ahead: number): number {
  const booths = Math.max(slot.activeBooths, 1);
  const free = Math.max(0, booths - slot.servingNumbers.length);
  if (slot.activeBooths > 0 && ahead < free) return 0;
  const rounds = Math.ceil((ahead + 1 - free) / booths);
  const minutes = (rounds * slot.avgConsultSeconds) / 60;
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

/** 来場者の待ち表示（V-04）: 自分の番号の前に何組いるか。列にいなければ null */
export function aheadOf(slot: Pick<BoardSlot, 'waitingNumbers'>, number: number): number | null {
  const i = slot.waitingNumbers.indexOf(number);
  return i < 0 ? null : i;
}

/** 入場コード `038-4712`、スタッフコード `0384-7125`（設計書 4章 使いやすさ） */
export function formatCode(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length <= 7) return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
  return `${d.slice(0, 4)}-${d.slice(4, 8)}`;
}

/** スタッフコードの入力中の区切り（8桁を 4-4 で） */
export function formatStaffCode(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d;
}

/** m:ss */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
