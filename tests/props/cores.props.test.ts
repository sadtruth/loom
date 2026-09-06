/**
 * Which core a record's sessions run in.
 *
 * The boundary case is the one that bites: `Projects/claude` and `Projects/claude-optimization` are
 * different projects with different CLAUDE.md files, and a prefix match that ignores the segment
 * boundary sends the second one's sessions into the first one's vault. Same trap `parseAliases`
 * documents for `/home/user/docsomething`.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CORES, SPOUSE_DIR, VAULT, coreFor, cwdFor, defaultCore, homeFor, under, usableCores } from "../../server/cores.ts";

// VAULT and SPOUSE_DIR come from the module, not a literal repeated here. When the source carried a
// hardcoded vault path the two happened to agree and these tests looked like they tested `coreFor`;
// the moment the path moved to the environment they failed, because what they had really pinned was
// the literal (2026-09-05). Read from the module and they say what they meant: these RELATIONSHIPS
// hold on whatever vault this install names.
const always = (): boolean => true;
const never = (): boolean => false;

describe("under", () => {
  test("matches only on a segment boundary", () => {
    expect(under(`${VAULT}/Projects/claude`, `${VAULT}/Projects/claude`)).toBe(true);
    expect(under(`${VAULT}/Projects/claude/x.md`, `${VAULT}/Projects/claude`)).toBe(true);
    expect(under(`${VAULT}/Projects/claude-optimization/x.md`, `${VAULT}/Projects/claude`)).toBe(false);
    expect(under(`${VAULT}/Projects/claudex`, `${VAULT}/Projects/claude`)).toBe(false);
  });

  test("a suffix appended to a prefix is under it only when a slash follows", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes("/") && !s.includes("\0")), (rest) => {
        expect(under(`${VAULT}/Projects/claude${rest}`, `${VAULT}/Projects/claude`)).toBe(false);
      }),
    );
  });
});

describe("coreFor", () => {
  test("is total — every path gets a core", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }).filter((s) => !s.includes("\0")), (p) => {
        expect(CORES).toContain(coreFor(p));
      }),
    );
  });

  test("the work core owns Projects/claude and nothing adjacent to it", () => {
    expect(coreFor(`${VAULT}/Projects/claude/specs/x.md`).id).toBe("work");
    expect(coreFor(`${VAULT}/Projects/claude-optimization/project.md`).id).toBe("personal");
    expect(coreFor(`${VAULT}/Projects/claude-shared/skills/research/SKILL.md`).id).toBe("personal");
  });

  test("an unknown record lands in the default core, which is personal", () => {
    expect(coreFor(`${VAULT}/Projects/tablet-for-drawing/project.md`).id).toBe("personal");
    expect(defaultCore().id).toBe("personal");
  });

  test("Spouse owns her area", () => {
    expect(coreFor(`${SPOUSE_DIR}/anything.pdf`).id).toBe("spouse");
  });
});

const segment = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => !s.includes("/") && !s.includes("\0") && s !== "." && s !== "..");

describe("cwdFor", () => {
  test("uses the core's own cwd when it exists", () => {
    expect(cwdFor(`${VAULT}/Projects/claude/x.md`, VAULT, CORES, always)).toBe(`${VAULT}/Projects/claude`);
    expect(cwdFor(`${VAULT}/Areas/Family/spouse/x.pdf`, VAULT, CORES, always)).toBe(`${VAULT}/Projects/Spouse Claude`);
  });

  // Spouse has no vault yet. Spawning into a directory with no `.claude` is the exact failure this
  // change exists to end, so a missing core must fall back rather than be used.
  test("falls back to the default core when the core's cwd is missing", () => {
    const onlyPersonal = (p: string): boolean => p.endsWith("Personal Claude");
    expect(cwdFor(`${VAULT}/Areas/Family/spouse/x.pdf`, VAULT, CORES, onlyPersonal)).toBe(defaultCore().cwd);
  });

  /**
   * The regression the FIRST driven run found, now pinned. `journey4-records` sent a fixture
   * record's child into the real Personal Claude, so its transcript landed in the real store and
   * the journey waited 30s for a reply written somewhere else. Cores are an opinion about the
   * vault; outside it, nothing changes.
   */
  test("a record OUTSIDE the vault keeps running in its own directory", () => {
    fc.assert(
      fc.property(fc.constantFrom("/tmp/fixture", "/var/data", "/home/someone"), segment, (dir, name) => {
        expect(cwdFor(`${dir}/${name}/project.md`, VAULT, CORES, always)).toBe(`${dir}/${name}`);
      }),
    );
  });

  test("inside the vault it is always one of the declared cores", () => {
    fc.assert(
      fc.property(segment, (name) => {
        const cwd = cwdFor(`${VAULT}/Projects/${name}/project.md`, VAULT, CORES, always);
        expect(CORES.map((c) => c.cwd)).toContain(cwd);
      }),
    );
  });

  test("with no core directory present at all it still answers, never throws", () => {
    expect(cwdFor(`${VAULT}/Projects/x/project.md`, VAULT, CORES, never)).toBe(`${VAULT}/Projects/x`);
  });
});

describe("usableCores", () => {
  test("drops a core whose directory is not there", () => {
    expect(usableCores(CORES, never)).toEqual([]);
    expect(usableCores(CORES, always)).toEqual([...CORES]);
    const onlyPersonal = usableCores(CORES, (p) => p.endsWith("Personal Claude"));
    expect(onlyPersonal.map((c) => c.id)).toEqual(["personal"]);
  });
});

/**
 * Where a NEW record goes. The gap User found in ten seconds: the selector scoped the VIEW and
 * not the write, so a project made in the Work core landed in the personal tree and was then
 * correctly filtered out of the core it was made in.
 */
describe("homeFor", () => {
  test("each core has its own home, and work's is the projects folder", () => {
    expect(homeFor("work")).toBe(`${VAULT}/Projects/claude/projects`);
    expect(homeFor("personal")).toBe(`${VAULT}/Projects`);
    expect(homeFor("spouse")).toBe(`${VAULT}/Projects/Spouse Claude/projects`);
  });

  test("an unknown or absent core falls back to the default's home, never undefined", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 12 }), { nil: null }), (id) => {
        const home = homeFor(id);
        expect(typeof home).toBe("string");
        expect(home.length).toBeGreaterThan(0);
        if (!CORES.some((c) => c.id === id)) expect(home).toBe(defaultCore().home);
      }),
    );
  });

  // A home outside the scanned roots would create a record the tree can never show again.
  test("every core's home is inside the vault's Projects tree", () => {
    for (const core of CORES) expect(under(core.home, `${VAULT}/Projects`)).toBe(true);
  });
});
