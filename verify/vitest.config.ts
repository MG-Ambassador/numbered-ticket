import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 同時実行のテストは Emulator のロック待ちで 10 秒前後かかる（20人同時の発券で 8〜13 秒）
    testTimeout: 60000,
    fileParallelism: false,
  },
});
