/**
 * The machine-wide poll lock and the reading every loom on the box shares.
 *
 * Development runs a loom SERVER per branch worktree, and each used to poll `/api/oauth/usage` on
 * its own timer against one account — the endpoint answered 429 and the badge flickered between a
 * good reading and none (2026-08-29: *"there should be just one poll every 60s"*). What makes it
 * one poll is this pair: a file holding the last body, and a lock only one process can hold.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPoll, readShared, releasePoll, writeShared } from "../../server/usage.ts";

const dirs: string[] = [];
function freshCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-quota-"));
  dirs.push(dir);
  const path = join(dir, "quota.json");
  process.env["LOOM_QUOTA_CACHE"] = path;
  return path;
}

afterEach(() => {
  delete process.env["LOOM_QUOTA_CACHE"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a body written by one server process is the body another one reads", () => {
  freshCachePath();
  writeShared({ at: 1_700_000_000_000, body: { five_hour: { utilization: 41 } } });
  const back = readShared();
  expect(back?.at).toBe(1_700_000_000_000);
  expect(back?.body).toEqual({ five_hour: { utilization: 41 } });
});

test("a missing or unparseable cache is null, never a throw", () => {
  const path = freshCachePath();
  expect(readShared()).toBeNull();
  Bun.write(path, "{not json");
  expect(readShared()).toBeNull();
});

test("only one caller holds the lock, and releasing hands it on", () => {
  freshCachePath();
  expect(claimPoll()).toBe(true);
  // This is the whole point: the second process does NOT go to the network.
  expect(claimPoll()).toBe(false);
  releasePoll();
  expect(claimPoll()).toBe(true);
  releasePoll();
});

test("a lock left by a process that died is reclaimed, not honoured forever", () => {
  const path = freshCachePath();
  expect(claimPoll()).toBe(true);
  const lock = `${path}.lock`;
  expect(existsSync(lock)).toBe(true);
  // Backdate it past LOCK_STALE_MS: the holder is gone and nobody would ever poll again.
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  expect(claimPoll()).toBe(true);
  releasePoll();
});
