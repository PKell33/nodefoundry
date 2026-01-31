import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/**/*.test.ts', 'vitest.config.ts'],
    },
  },
  resolve: {
    alias: {
      '@ownprem/shared': '../../../packages/shared/src/index.ts',
    },
  },
});
