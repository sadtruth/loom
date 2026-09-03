import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const ROOT = "/Users/serbir/docs/Projects/Personal Claude/tools/loom";
const PORT = 4181;
const FIXTURE = join(ROOT, "tests/fixture/projects/-fixture-project/00000000-fixture-0000-000000000001.jsonl");

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "/tmp/loom-drive-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun tests/fixture/make-fixture.ts && bun server/main.ts",
    cwd: ROOT,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: {
      LOOM_PORT: String(PORT),
      LOOM_PROJECTS_ROOT: join(ROOT, "tests", "fixture", "projects"),
      LOOM_STATE: "/tmp/loom-drive-state",
      LOOM_POLL_MS: "200",
      NODE_ENV: "test",
    },
  },
});
process.env.LOOM_FIXTURE_FILE = FIXTURE;
