// 入場コード（7桁）・スタッフコード（8桁）の生成（A-03）。推測されやすいコードは使わない。
import { randomInt } from 'node:crypto';

/**
 * 推測されやすいか。
 * - 使っている数字が3種類以下（0000000、1212121、1122334 の一部など）
 * - 同じ数字が4つ以上続く
 * - 1ずつ増える・減る並び（0123456、9876543。0 と 9 の折り返しも含む）
 * - 3桁以下の繰り返し（1231231、12341234）
 * - 8桁で 19xx / 20xx から始まる日付の形（20270320）
 */
export function isGuessableCode(code: string): boolean {
  const d = [...code].map(Number);
  if (new Set(d).size <= 3) return true;
  if (/(\d)\1{3}/.test(code)) return true;
  const steps = d.slice(1).map((x, i) => (x - d[i]! + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true;
  for (let p = 1; p <= 4; p++) {
    if (p < code.length && [...code].every((c, i) => c === code[i % p])) return true;
  }
  if (code.length === 8 && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(code)) return true;
  return false;
}

export function generateCode(digits: number, avoid: string[] = []): string {
  for (;;) {
    const code = Array.from({ length: digits }, () => randomInt(10)).join('');
    if (isGuessableCode(code)) continue;
    // 入場コードとスタッフコードの先頭が同じだと、片方からもう片方を推測しやすい
    if (avoid.some((a) => a.slice(0, 4) === code.slice(0, 4))) continue;
    return code;
  }
}
