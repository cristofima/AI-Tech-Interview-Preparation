import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Two projects:
//   - unit:        mocked checks, no network, no database, no Azure (pnpm test)
//   - integration: real PostgreSQL through the Prisma client   (pnpm test:integration)
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          // *.test.ts run in Node; *.test.tsx declare `@vitest-environment jsdom`.
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          setupFiles: ['tests/setup/unit.setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/setup/integration.setup.ts'],
          // Integration tests share one database; run them serially.
          sequence: { concurrent: false },
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
