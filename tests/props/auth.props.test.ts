/**
 * Auth decision logic (SPEC §Auth). The cookie parser gets a property — arbitrary header junk must
 * never crash it or make a non-matching token pass — and token persistence gets plain cases.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieName, cookieToken, loadToken } from "../../server/auth.ts";

describe("cookieToken", () => {
  test("finds the token among other cookies, wherever it sits", () => {
    expect(cookieToken("a=1; loom_token=abc; b=2")).toBe("abc");
    expect(cookieToken("loom_token=abc")).toBe("abc");
    expect(cookieToken("loom_token=with=equals; x=y")).toBe("with=equals");
    expect(cookieToken(null)).toBeNull();
    expect(cookieToken("a=1; b=2")).toBeNull();
  });

  test("property: arbitrary junk never throws and never yields a phantom token", () => {
    fc.assert(
      fc.property(fc.string(), (header) => {
        const got = cookieToken(header);
        // If a token came back, the header really contained a loom_token cookie.
        if (got !== null) {
          expect(header).toContain("loom_token=");
        }
      }),
    );
  });
});

describe("loadToken", () => {
  test("generates once, persists, survives a second load, and is 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-auth-"));
    delete Bun.env["LOOM_TOKEN"];
    const first = await loadToken(dir);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    const second = await loadToken(dir);
    expect(second).toBe(first);
    expect(readFileSync(join(dir, "auth-token"), "utf8").trim()).toBe(first);
    expect(statSync(join(dir, "auth-token")).mode & 0o777).toBe(0o600);
  });

  test("LOOM_TOKEN overrides the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-auth-"));
    Bun.env["LOOM_TOKEN"] = "override-token";
    try {
      expect(await loadToken(dir)).toBe("override-token");
    } finally {
      delete Bun.env["LOOM_TOKEN"];
    }
  });
});

describe("the cookie is scoped to its port (SPEC 154)", () => {
  test("a login on one port is not a login on another", () => {
    const header = `${cookieName(4335)}=worktree-token`;
    expect(cookieToken(header, 4335)).toBe("worktree-token");
    expect(cookieToken(header, 4173)).toBeNull();
  });

  test("both cookies coexist in one jar, each server reading its own", () => {
    const header = `${cookieName(4173)}=stable; ${cookieName(4335)}=worktree`;
    expect(cookieToken(header, 4173)).toBe("stable");
    expect(cookieToken(header, 4335)).toBe("worktree");
  });

  test("an existing bare loom_token still logs you in, on any port", () => {
    expect(cookieToken("loom_token=old", 4173)).toBe("old");
    expect(cookieToken("loom_token=old", 4335)).toBe("old");
  });

  test("this port's own cookie beats the legacy one", () => {
    expect(cookieToken(`loom_token=old; ${cookieName(4335)}=new`, 4335)).toBe("new");
  });
});
