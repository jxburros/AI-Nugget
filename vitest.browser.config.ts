import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Prefer a pre-provisioned Chromium (this sandbox, CHROMIUM_PATH) when present;
// otherwise fall back to Playwright's own downloaded browser (GitHub CI runs
// `npx playwright install chromium`). Pointing at the full chromium keeps
// headless mode from reaching for a separately-versioned chrome-headless-shell.
const chromiumPath = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const launchOptions = existsSync(chromiumPath) ? { executablePath: chromiumPath } : {};

// Headless-Chromium run of the same contract suite (design §10: the core is
// isomorphic, so CI proves it in a browser as well as in Node).
//
// The live smoke tests are excluded here: they read process.env and reach
// out to real localhost/cloud providers, neither of which belongs in a
// sandboxed browser page.
//
// executablePath points at the full pre-provisioned Chromium so headless mode
// does not reach for a separately-versioned chrome-headless-shell download.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live-smoke.test.ts', 'node_modules/**'],
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: 'chromium' }],
      provider: playwright({ launchOptions }),
    },
  },
});
