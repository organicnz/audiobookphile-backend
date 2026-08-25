import { defineConfig } from "@playwright/test";

/**
 * API-level e2e suite for the deployed Edge API.
 *
 * Runs against a REAL project (env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 * because playback/cover behavior is inseparable from storage reality. All
 * fixtures are created and removed by the suite itself; nothing user-owned is
 * touched. See tests/e2e-api/fixtures.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e-api",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // fixtures share storage state
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SUPABASE_URL,
    extraHTTPHeaders: { "Content-Type": "application/json" },
    actionTimeout: 20_000,
  },
});
