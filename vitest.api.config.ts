import { defineConfig } from 'vitest/config';

// Pruebas de integración: requieren levantar wrangler dev (lo hace global-setup).
export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts'],
    globalSetup: ['tests/api/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
