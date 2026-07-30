import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The store is deliberately DOM-free — visibility handling lives in the
    // provider — so its tests need no browser environment, which keeps them
    // fast enough to run on every change.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
