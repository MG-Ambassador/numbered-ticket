// 画面の表示用の計算（shared/src/display.ts）。Emulator は使わない（npm run test:unit）
import { describe, expect, it } from 'vitest';
import { aheadOf, estimateWaitMinutes, formatCode, formatStaffCode } from '@nt/shared';

const student = (serving: number, avgMin = 10) => ({ activeBooths: 1, servingNumbers: Array(serving).fill(1), avgConsultSeconds: avgMin * 60 });

describe('目安の待ち時間（V-02・V-04）', () => {
  it('学生: 空いていて前に誰もいなければ 0（まもなく）', () => {
    expect(estimateWaitMinutes(student(0), 0)).toBe(0);
  });
  it('学生: 対応中1・前に0組なら1巡ぶん（10分）', () => {
    expect(estimateWaitMinutes(student(1), 0)).toBe(10);
  });
  it('学生: 対応中1・前に2組なら3巡（30分）', () => {
    expect(estimateWaitMinutes(student(1), 2)).toBe(30);
  });
  it('平均相談時間の実績で計算し、5分単位に切り上げる', () => {
    expect(estimateWaitMinutes(student(1, 7), 1)).toBe(15); // 14分 → 15分
  });
  it('教員: 空きブースの数より前の組が少なければ 0', () => {
    expect(estimateWaitMinutes({ activeBooths: 3, servingNumbers: [1], avgConsultSeconds: 600 }, 1)).toBe(0);
  });
  it('教員: 3ブースすべて対応中・前に5組なら2巡（20分）', () => {
    expect(estimateWaitMinutes({ activeBooths: 3, servingNumbers: [1, 2, 3], avgConsultSeconds: 600 }, 5)).toBe(20);
  });
  it('ブースが0（準備中）でも0分にはしない', () => {
    expect(estimateWaitMinutes({ activeBooths: 0, servingNumbers: [], avgConsultSeconds: 600 }, 0)).toBeGreaterThan(0);
  });
});

describe('表示の補助', () => {
  it('前に何組いるか。列にいなければ null', () => {
    expect(aheadOf({ waitingNumbers: [101, 103, 104] }, 104)).toBe(2);
    expect(aheadOf({ waitingNumbers: [101] }, 105)).toBeNull();
  });
  it('コードの区切り（038-4712、0384-7125）', () => {
    expect(formatCode('0384712')).toBe('038-4712');
    expect(formatCode('03847125')).toBe('0384-7125');
    expect(formatStaffCode('038471')).toBe('0384-71');
  });
});
