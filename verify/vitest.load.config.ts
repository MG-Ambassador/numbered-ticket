import { defineConfig } from 'vitest/config';

// P4 の負荷シナリオだけを流す（npm run test:load）。通常のテスト（vitest.config.ts）には含めない
export default defineConfig({
  test: {
    include: ['src/p4/**/*.scenario.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
