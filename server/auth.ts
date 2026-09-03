/**
 * Device auth: one token, one cookie, set once per device (SPEC §Auth).
 *
 * The cookie's NAME carries the port (SPEC 154). Cookies are scoped by host and ignore the port
 * entirely, so logging into a worktree's loom on :4335 overwrote the cookie for :4173 and threw
 * User out of his real session (2026-08-10). A bare `loom_token` is still accepted, so the
 * server he is already logged into does not ask him to log in again.
 *
 * The token lives in state/auth-token so a deploy can never rotate it by accident; LOOM_TOKEN
 * overrides for tests and controlled deploys. Comparison is constant-time over digests — cheap,
 * and it removes the classic mistake in a hand-rolled token check.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadToken(stateDir: string): Promise<string> {
  const override = Bun.env["LOOM_TOKEN"];
  if (override !== undefined && override.length > 0) return override;

  const path = join(stateDir, "auth-token");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // First boot — generate below.
  }
  const token = randomBytes(16).toString("hex");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

function matches(candidate: string, token: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** This server's cookie name — `loom_token_4335`. The legacy bare name is read, never written. */
export function cookieName(port: number): string {
  return `loom_token_${port}`;
}

/** Parsed without a cookie library — one format, this port's name first, then the legacy one. */
export function cookieToken(header: string | null, port?: number): string | null {
  if (header === null) return null;
  const wanted = port === undefined ? null : cookieName(port);
  let legacy: string | null = null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (wanted !== null && name === wanted) return value;
    if (name === "loom_token") legacy = value;
  }
  return legacy;
}

export function authed(req: Request, token: string, port?: number): boolean {
  const candidate = cookieToken(req.headers.get("cookie"), port);
  return candidate !== null && matches(candidate, token);
}

/** GET /login?token=<t> — the one way in. Ten years, HttpOnly, SameSite=Lax, no Secure (SPEC 30). */
export function loginResponse(req: Request, token: string, port: number): Response {
  const candidate = new URL(req.url).searchParams.get("token") ?? "";
  if (candidate.length === 0 || !matches(candidate, token)) {
    return new Response("wrong token", { status: 403 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": `${cookieName(port)}=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; HttpOnly; SameSite=Lax`,
    },
  });
}
