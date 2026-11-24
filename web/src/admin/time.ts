// 日時は JST で入力・表示する（会場は東京。管理者の端末のタイムゾーンに左右されないように）
const JST_OFFSET_MS = 9 * 3600_000;

/** `YYYY-MM-DDTHH:mm`（input[type=datetime-local] の値、JST） */
export function toJstInput(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** input の値（JST）→ ISO 8601（+09:00） */
export function fromJstInput(value: string): string {
  return `${value}:00+09:00`;
}

/** `YYYY-MM-DD HH:mm`（JST） */
export function formatJst(ms: number): string {
  return toJstInput(ms).replace('T', ' ');
}

export function formatClock(ms: number): string {
  return toJstInput(ms).slice(11, 16);
}
