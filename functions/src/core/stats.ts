// 統計（A-07）。個人性のない集計だけを作る。閉場＋1時間の削除の前に stats/{date} に保存する（定期処理）。
import type { EventDoc, StatsDoc, TicketDoc } from '@nt/shared';

const JST_OFFSET_MS = 9 * 3600_000;
export const NO_GRADE = '未回答';
export const NO_THEME = '(テーマなし)';

/** JST の日付（YYYY-MM-DD） */
export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function jstHour(ms: number): string {
  return String(new Date(ms + JST_OFFSET_MS).getUTCHours());
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function buildStats(event: EventDoc, tickets: TicketDoc[]): Omit<StatsDoc, 'createdAt'> {
  const gradeTheme: StatsDoc['gradeTheme'] = {};
  const issuedByHour: StatsDoc['issuedByHour'] = {};
  const waits: number[] = [];
  const consults: number[] = [];
  let completed = 0;
  let canceled = 0;
  let expired = 0;

  for (const t of tickets) {
    const grade = t.grade ?? NO_GRADE;
    const row = (gradeTheme[grade] ??= {});
    for (const theme of t.themes.length > 0 ? t.themes : [NO_THEME]) row[theme] = (row[theme] ?? 0) + 1;

    const hour = jstHour(t.createdAt.toMillis());
    issuedByHour[hour] = (issuedByHour[hour] ?? 0) + 1;

    if (t.calledAt) waits.push((t.calledAt.toMillis() - t.createdAt.toMillis()) / 1000);
    if (t.state === 'completed' && t.startedAt && t.completedAt) consults.push((t.completedAt.toMillis() - t.startedAt.toMillis()) / 1000);
    if (t.state === 'completed') completed++;
    if (t.state === 'canceled') canceled++;
    if (t.state === 'expired') expired++;
  }

  return {
    date: jstDate(event.opensAt.toMillis()),
    issued: tickets.length,
    completed,
    canceled,
    expired,
    gradeTheme,
    avgWaitSeconds: avg(waits),
    avgConsultSeconds: avg(consults),
    issuedByHour,
  };
}
