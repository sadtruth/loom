/**
 * Show each new pin failing on purpose. Throwaway — deleted once the build is verified.
 *
 * Plain string replacement, never a regex: the code being mutated is full of regex literals and a
 * perl one-liner ate them. A mutation is reported NOT APPLIED unless the file actually changed —
 * an unverified mutation reports comfort, not coverage (build ratchet, 2026-07-28).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOM = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const CASES: Array<{ what: string; file: string; from: string; to: string; spec: string }> = [
  {
    what: "the #L590 line form",
    file: "client/chips.ts",
    from: "  const github = /^(.*[^/])#L(\\d+)(?:-L?(\\d+))?$/u.exec(raw);",
    to: "  const github: RegExpExecArray | null = null;",
    spec: "tests/props/link-fixes.props.test.ts",
  },
  {
    what: "an .html file is a page",
    file: "server/files.ts",
    from: '  if (/\\.html?$/i.test(path)) return "page";',
    to: "",
    spec: "tests/props/link-fixes.props.test.ts",
  },
  {
    what: "the worktree twin",
    file: "server/files.ts",
    from: "  if (hat === null) return null;",
    to: "  if (hat !== null) return null;",
    spec: "tests/props/link-fixes.props.test.ts",
  },
  {
    what: "the place written onto a labelled chip",
    file: "client/chips.ts",
    from: '  if ("heading" in place) return `#${place.heading}`;',
    to: '  if ("heading" in place) return null;',
    spec: "tests/props/link-fixes.props.test.ts",
  },
  {
    what: "the widened roots",
    file: "server/files.ts",
    from: '  return ["/", vaultRoot, home];',
    to: "  return [vaultRoot, home];",
    spec: "tests/props/files.props.test.ts",
  },
];

let bad = 0;
for (const one of CASES) {
  const path = join(LOOM, one.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(one.from)) {
    console.log(`NOT APPLIED  ${one.what} — the mutation string is not in ${one.file}`);
    bad += 1;
    continue;
  }
  writeFileSync(path, original.replace(one.from, one.to), "utf8");
  try {
    const run = Bun.spawnSync(["bun", "test", one.spec], { cwd: LOOM });
    if (run.exitCode === 0) {
      console.log(`SURVIVED  ${one.what} — the pin did not notice`);
      bad += 1;
    } else {
      const said = new TextDecoder().decode(run.stderr);
      const line = said.split("\n").find((l) => l.includes("(fail)")) ?? "(a test failed)";
      console.log(`caught    ${one.what} → ${line.trim()}`);
    }
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

process.exit(bad === 0 ? 0 : 1);
