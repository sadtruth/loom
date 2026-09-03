/**
 * PROPERTY PINS for the read guard — the thing standing between the file pane and `~/.ssh/id_ed25519`.
 *
 * loom listens on a LAN/Tailscale/Yggdrasil-reachable port with no password, so "the browser asks for
 * a path and the server opens it" is only acceptable with a guard. The properties hunt traversal
 * strings rather than relying on the handful of `../` cases I would think to write; the generator
 * builds them out of `..`, absolute jumps, dots and separators and asserts the same rule every time:
 * **an accepted path is inside a root.** That is the whole contract, stated once.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  bases,
  decide,
  defaultRoots,
  guardFrom,
  locate,
  within,
  kindOf,
  looksBinary,
} from "../../server/files.ts";

const guard = guardFrom("/vault:/home/user/.claude", "/vault");

const junkArb = fc.array(
  fc.constantFrom("..", ".", "notes", "sub dir", "Заметки", "a.md", "..%2f", "...", "//", "\\", "-"),
  { minLength: 1, maxLength: 8 },
);

/**
 * The full contract for an ACCEPTED path, asserted in one place.
 *
 * Both halves are load-bearing, and the second was added after a mutation survived: a version of
 * `decide()` with the `resolve()` normalisation deleted passed a "starts with /vault/" check while
 * happily accepting `/vault/../../etc/passwd` — the string starts with the root and the meaning does
 * not. An accepted path must therefore be normalised (no `..` left in it) AND contained.
 */
function assertAccepted(path: string): void {
  expect(path.split("/").includes("..")).toBe(false);
  expect(guard.roots.some((root) => within(root, path))).toBe(true);
}

describe("an accepted path is inside a root — always", () => {
  test("traversal junk appended to a root", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        const verdict = decide(guard, `/vault/${parts.join("/")}`);
        if (verdict.ok) assertAccepted(verdict.path);
      }),
      { numRuns: 600 },
    );
  });

  test("traversal that actually escapes is refused", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.constantFrom("etc/passwd", ".ssh/id_ed25519", "x.md"), (depth, tail) => {
        const verdict = decide(guard, `/vault/${"../".repeat(depth)}${tail}`);
        if (verdict.ok) assertAccepted(verdict.path);
      }),
      { numRuns: 400 },
    );
  });

  test("a path outside every root is refused whatever its shape", () => {
    for (const path of ["/etc/passwd", "/home/user/.ssh/id_ed25519", "/", "/vaultish/x.md", "/vault2/a.md"]) {
      const verdict = decide(guard, path);
      expect(verdict.ok).toBe(false);
    }
  });

  test("relative and empty paths are refused", () => {
    fc.assert(
      fc.property(fc.string().filter((s) => !s.startsWith("/")), (raw) => {
        expect(decide(guard, raw).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the deny list wins inside a root", () => {
  test("denied segments", () => {
    for (const path of [
      "/vault/.ssh/config",
      "/vault/sub/.gnupg/secring",
      "/vault/node_modules/pkg/index.js",
      "/vault/.git/config",
    ]) {
      const verdict = decide(guard, path);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  test("denied names", () => {
    for (const name of [".env", ".env.local", "id_rsa", "id_ed25519.pub", "server.pem", "secrets.kdbx"]) {
      expect(decide(guard, `/vault/notes/${name}`).ok).toBe(false);
    }
  });

  test("a normal note in a root is accepted", () => {
    const verdict = decide(guard, "/vault/Areas/Health/README.md");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe("/vault/Areas/Health/README.md");
  });
});

describe("containment is compared on segment boundaries", () => {
  test("a sibling with a shared prefix is not inside", () => {
    expect(within("/a/b", "/a/bc")).toBe(false);
    expect(within("/a/b", "/a/b/c")).toBe(true);
    expect(within("/a/b", "/a/b")).toBe(true);
  });
});

/**
 * SPEC 220 — the worktrees loom's own builds happen in are readable.
 *
 * The failure this pins, in User's words (2026-08-13): *"cant open the plan though it says 403 -
 * outside loom's readable roots"*. The build skill mandates a worktree before the first edit, so
 * every plan, prototype and record a build produces sat outside all three roots until it landed —
 * which is exactly when reading it stops helping. Parent items 40 and 47.
 *
 * The second case is the half that matters: widening the roots must not widen the deny-list, or the
 * fix trades a 403 he wants gone for a `.git/config` he does not.
 */
describe("a session worktree is inside a root", () => {
  const home = homedir();
  const wtGuard = guardFrom(undefined, "/vault");

  test("home is a root, so every worktree home is inside one", () => {
    // Requirement 225 replaced the list of named subdirectories with HOME itself. The four that were
    // there — `.claude`, `projects`, `wt`, `looms` — were each added the day a file inside it turned
    // out to be unreadable, which is the shape of a list that is always one entry short. So the
    // assertion is no longer "these names are present" but "these places resolve", which is the
    // thing the requirement is actually about.
    expect(defaultRoots("/vault")).toContain(home);
    for (const inside of [join(home, "wt"), join(home, "looms"), join(home, ".claude"), join(home, "projects")]) {
      expect(decide(wtGuard, join(inside, "x", "note.md")).ok).toBe(true);
    }
  });

  test("a plan inside a worktree is accepted", () => {
    const plan = join(home, "wt", "loom-bugs", "tools", "loom", "loom-bugs-plan-2026-08-17.md");
    expect(decide(wtGuard, plan)).toEqual({ ok: true, path: plan });
  });

  test("the deny list still wins inside a worktree", () => {
    for (const bad of [
      join(home, "wt", "loom-bugs", ".git", "config"),
      join(home, "looms", "steady", "node_modules", "x", "index.js"),
      join(home, "wt", "loom-bugs", "id_ed25519"),
    ]) {
      expect(decide(wtGuard, bad).ok).toBe(false);
    }
  });

  // REVISED 2026-08-24 (item 15). This test used to assert that `/etc`, `/opt` and `/srv` are
  // refused, and it was the control that kept a guard accepting EVERYTHING from passing the rest of
  // this file. User approved widening the roots to the machine, so that assertion is false by
  // design now — the 2026-08-24 audit found 339 links refused for sitting outside home and the
  // vault, the NixOS system config most of all, which he edits by hand.
  //
  // The control cannot simply be deleted, or every other case here goes vacuous. It moves onto the
  // DENY list, which is now the only thing that says no: each case below names a refused shape, and
  // the pairs test further down names an ordinary sibling for each, so "refuses everything" and
  // "accepts everything" both fail.
  test("the machine is readable, and the deny list is what still says no", () => {
    for (const good of ["/etc/hosts", "/opt/thing/notes.md", "/srv/data/x.md"]) {
      expect(decide(wtGuard, good).ok).toBe(true);
    }
    for (const bad of ["/etc/ssl/private/site.pem", "/opt/app/.git/config", "/srv/id_ed25519"]) {
      expect(decide(wtGuard, bad).ok).toBe(false);
    }
    // Still not a path at all.
    expect(decide(wtGuard, "relative/thing.md").ok).toBe(false);
    expect(decide(wtGuard, "").ok).toBe(false);
  });

  /**
   * The two-sided half of requirement 225, and the only guard property the widening earns.
   *
   * A control that refused everything would pass a one-sided check, so each case names a denied
   * location under home AND an ordinary sibling of it that must be served. The deny-list is checked
   * before containment, so widening WHERE loom looks cannot widen WHAT it hands over.
   */
  test("a denied location stays denied from inside home, and its ordinary siblings do not", () => {
    const pairs: [string, string][] = [
      [join(home, ".ssh", "id_ed25519"), join(home, "notes", "ssh-setup.md")],
      [join(home, ".gnupg", "trustdb.gpg"), join(home, "notes", "gnupg.md")],
      [join(home, ".aws", "credentials"), join(home, "notes", "aws.md")],
      [join(home, "app", "node_modules", "x", "index.js"), join(home, "app", "src", "index.js")],
      [join(home, "app", ".git", "config"), join(home, "app", "README.md")],
      [join(home, "app", ".env"), join(home, "app", "env.example")],
      [join(home, "keys", "server.pem"), join(home, "keys", "notes.md")],
    ];
    for (const [denied, allowed] of pairs) {
      expect(decide(wtGuard, denied).ok, `${denied} must stay denied`).toBe(false);
      expect(decide(wtGuard, allowed).ok, `${allowed} must be served`).toBe(true);
    }
  });

  /**
   * Metamorphic, with a free oracle: the deny-list alone is a guard whose roots are everything, so
   * the widened guard may never say yes where that one says no.
   */
  test("widening the roots never widens the deny-list", () => {
    const everywhere = guardFrom("/", "/vault");
    for (const name of [".ssh/id_rsa", "a/.git/config", "b/node_modules/i.js", "c/.env.local", "d/x.kdbx", "e/ok.md"]) {
      const path = join(home, name);
      const wide = decide(everywhere, path).ok;
      const ours = decide(wtGuard, path).ok;
      expect(ours && !wide, `${path}: home-as-root is more permissive than the deny-list alone`).toBe(false);
    }
  });
});

describe("kind detection", () => {
  test("markdown, text, image, and the extensionless case", () => {
    expect(kindOf("/vault/a.md")).toBe("markdown");
    expect(kindOf("/vault/a.ts")).toBe("text");
    expect(kindOf("/vault/a.png")).toBe("image");
    expect(kindOf("/vault/Makefile")).toBe("text");
    expect(kindOf("/vault/a.zip")).toBe(null);
    expect(kindOf("/vault/a.pdf")).toBe(null);
  });

  test("a NUL byte in the head means binary", () => {
    expect(looksBinary(new Uint8Array([104, 105, 0, 1]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("# hello\nworld"))).toBe(false);
  });
});

/**
 * SPEC 143 — the base ladder for relative chips.
 *
 * The failure this pins: a chip saying `client/markdown.ts`, written by a session whose cwd is
 * `projects/smart-links/`, resolved to `projects/smart-links/client/markdown.ts` and 400'd. The
 * ladder widens what a relative path may MEAN; the containment property above still owns what loom
 * may READ, which is why the escape case below asserts a refusal and not a resolution.
 */
describe("relative paths climb from the session directory", () => {
  test("the ladder is nearest-first and stops at the outermost root", () => {
    expect(bases(guard, "/vault/a/b/c")).toEqual(["/vault/a/b/c", "/vault/a/b", "/vault/a", "/vault"]);
    expect(bases(guard, "/vault")).toEqual(["/vault"]);
    expect(bases(guard, "/elsewhere/deep")).toEqual([]);
  });

  test("a cwd outside every root offers no bases at all", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        expect(bases(guard, `/elsewhere/${parts.join("/")}`)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  test("an ancestor holds the file the session directory does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-ladder-"));
    const real = await realpath(root);
    const near = join(real, "projects", "smart-links");
    await mkdir(near, { recursive: true });
    await mkdir(join(real, "client"), { recursive: true });
    await writeFile(join(real, "client", "markdown.ts"), "// up the tree\n");

    const local = guardFrom(real, real);
    const found = await locate(local, "client/markdown.ts", near);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.path).toBe(join(real, "client", "markdown.ts"));

    // Nearest wins: the same name beside the session shadows the one above it.
    await mkdir(join(near, "client"), { recursive: true });
    await writeFile(join(near, "client", "markdown.ts"), "// beside the session\n");
    const nearer = await locate(local, "client/markdown.ts", near);
    expect(nearer.ok).toBe(true);
    if (nearer.ok) expect(nearer.path).toBe(join(near, "client", "markdown.ts"));

    // The ladder is not an escape hatch: climbing out of the root still refuses.
    const escape = await locate(local, "../../../etc/passwd", near);
    expect(escape.ok).toBe(false);

    // Nothing anywhere on the ladder — a 404 about the file, not the stale "absolute path required":
    // a relative path is a legitimate thing to send once the ladder exists.
    const missing = await locate(local, "client/nope.ts", near);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    await rm(root, { recursive: true, force: true });
  });
});
