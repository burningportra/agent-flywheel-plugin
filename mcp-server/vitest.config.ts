import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Keep tests off ~/.cache (the real doctor's probe cache) and ~/.config (the user's flywheel.config.yaml lanes).
    env: {
      XDG_CACHE_HOME: join(tmpdir(), 'agent-flywheel-vitest-cache'),
      XDG_CONFIG_HOME: join(tmpdir(), 'agent-flywheel-vitest-config'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
