# Fixture Audit Report

## 1. The inventory

Here is every fixture artefact `make-fixture.ts` writes, its path, and its source:

- **The Main Fixture Project (`-fixture-project`)**
  - Path: `tests/fixture/projects/-fixture-project/00000000-fixture-0000-000000000001.jsonl`
  - Source: A real transcript (under 2MB, no poisoned paths) read from `~/.claude/projects/` (or a synthetic base if missing), appended with generated rows containing specific chips, images, prototypes, and tool calls.
  - Path: `tests/fixture/projects/-fixture-project/shot-a.png`
  - Source: Generated 2400×1400 PNG (`PNG_BIG`).
  - Path: `tests/fixture/projects/-fixture-project/shot-b.png`
  - Source: Generated 1×1 PNG (`PNG_1X1`).
  - Path: `tests/fixture/projects/-fixture-project/gutter-frame.html`
  - Source: Generated HTML string.
  - Path: `tests/fixture/projects/-fixture-project/gutter-plan.md`
  - Source: Generated markdown string.

- **The Input-Path Fixture Project (`-fixture-project` for input)**
  - Path: `tests/fixture/projects/<escaped_loom_root>/00000000-fixture-0000-000000000002.jsonl`
  - Source: Generated synthetic rows (2 turns).

- **The Scroll Fixture Project**
  - Path: `tests/fixture/projects/<escaped_tests_dir>/00000000-fixture-0000-000000000004.jsonl`
  - Source: Generated synthetic rows (41 turns).

- **The Train Fixture (Two Cars)**
  - Path: `tests/fixture/projects/<escaped_train_dir>/00000000-fixture-0000-000000000005.jsonl`
  - Path: `tests/fixture/projects/<escaped_train_dir>/00000000-fixture-0000-000000000006.jsonl`
  - Source: Generated synthetic rows via `car()` helper.

- **The Recap Fixture**
  - Path: `tests/fixture/projects/<escaped_recap_dir>/00000000-fixture-0000-000000000008.jsonl`
  - Source: Generated synthetic rows via `car()` helper.
  - Path: `tests/fixture/.records/loom-fixture-parent/loom-fixture-recap/project.md`
  - Source: Generated markdown string.

- **The Restore Fixture (Two Cars + Ledger)**
  - Path: `tests/fixture/projects/<escaped_restore_dir>/00000000-fixture-0000-000000000010.jsonl`
  - Path: `tests/fixture/projects/<escaped_restore_dir>/00000000-fixture-0000-000000000011.jsonl`
  - Source: Generated synthetic rows via `car()` helper.
  - Path: `tests/fixture/.records/loom-fixture-parent/loom-fixture-restore/project.md`
  - Path: `tests/fixture/.records/loom-fixture-parent/loom-fixture-restore/recap-ledger.md`
  - Source: Generated markdown strings.

- **The Queue Fixture**
  - Path: `tests/fixture/projects/<escaped_fixture_dir>/00000000-fixture-0000-000000000007.jsonl`
  - Source: Generated synthetic rows (2 turns).

- **The Windowed Transcript Project (Huge)**
  - Path: `tests/fixture/projects/<escaped_big_cwd>/00000000-fixture-0000-000000000008.jsonl`
  - Source: Generated synthetic rows (2,600 turns).
  - Path: `tests/fixture/big/big-frame.html`
  - Path: `tests/fixture/big/big-plan.md`
  - Source: Generated strings.

- **The Records Tree (`LOOM_FIXTURE_RECORDS`)**
  - Paths: `tests/fixture/.records/loom-fixture-parent/project.md`, `notes.md`, `table-note.md`, `fixture-visual-plan-2026-08-11.md`, and its prototypes/frames.
  - Paths: `tests/fixture/.records/loom-fixture-parent/loom-fixture-child/project.md`, `notes.md`, and its prototypes.
  - Paths: `tests/fixture/.records/loom-fixture-parent/loom-fixture-done/project.md`.
  - Paths: `tests/fixture/.records/loom-fixture-parent/loom-fixture-child/loom-fixture-dormant/project.md`.
  - Source: Generated markdown strings, HTML strings, and PNGs.
  - Path: `tests/fixture/projects/<escaped_parent_dir>/00000000-fixture-0000-000000000003.jsonl`
  - Source: Generated synthetic rows.

- **The Bar Archive (`LOOM_BAR_ARCHIVE`)**
  - Path: `bar-project/block.jsonl` (inside the env path).
  - Source: Generated via `barRow()` helper (200 rows).

- **Storage State (Auth)**
  - Path: `storage-state.json` (inside `.state/` or `LOOM_FIXTURE_AUTH`).
  - Source: Constructed JSON object containing the `LOOM_TOKEN` cookie.

- **Core Vault (`LOOM_CORE_VAULT`)**
  - Paths: `Projects/claude/`, `Projects/Personal Claude/` (inside the env path).
  - Source: Created empty directories.

## 2. The external reads, exactly

1. **`~/.claude/projects/` directory**
   - **Used for:** Searching for the largest valid, non-poisoned real Claude Code transcript to use as the base for the main fixture session (`00000000-fixture-0000-000000000001`).
   - **What would break:** If absent, `pickRealTranscript` fails and falls back to a 2-turn synthetic base. While tests might survive, the UI would not be proven against real-world shapes (large bash outputs, thinking blocks) as mandated by `VERIFY.md`.

2. **`LOOM_TOKEN` (environment variable)**
   - **Used for:** Generating the `storage-state.json` file which pre-authenticates the Playwright browser.
   - **What would break:** Every data route requires the device token. All driven specs (except the login flow spec) would fail with 401 Unauthorized or redirect to the login screen, causing UI assertions to fail.

3. **`ARCHITECTURE.md` (and `SPEC.md`) inside the loom root**
   - **Used for:** Providing a real file for the file pane to render (`tests/drive/specs/journey19-links.spec.mjs`, etc). `make-fixture.ts` writes a bash tool run that does `grep -rn loom client/` and reads `ARCHITECTURE.md`.
   - **What would break:** If missing, the file reads in the fixture would fail, and specs asserting on the contents of the file pane (`await expect(page.locator(".file-md")).toContainText("ARCHITECTURE");`) would fail.

## 3. Per fixture, what is load-bearing

### Main Fixture Project (`-fixture-project`)
*Asserted properties:*
- **journey.spec.mjs**
  - Line 80: `expect(box.height, "the fixture is taller than one screen").toBeGreaterThan(box.client + 200);` (Asserts exact minimum height greater than window)
  - Line 210: `expect(await reveal(page, "details.steps"), "the fixture's folded strip is reachable").toBe(true);` (Asserts existence of folded strip element)
- **journey21-gutter.spec.mjs**
  - Line 67: `expect(counts.withArtifact, "the fixture must carry artifacts, or this proves nothing").toBeGreaterThan(2);` (Asserts minimal artifact turn count > 2)
  - Line 71: `expect(counts.plain, "the fixture must also carry ordinary turns").toBeGreaterThan(2);` (Asserts plain turn count > 2)
  - Line 175: `expect(boxes.length, "the fixture has enough points to crowd").toBeGreaterThan(3);` (Asserts points >= 4 to test crowding)
- **journey13-zoom.spec.mjs**
  - Line 77: `expect(rest.natW, "the fixture image must have real dimensions or this pin proves nothing").toBe(NAT_W);` (Asserts dimensions precisely matching `PNG_BIG`)
- **journey6-layout.spec.mjs**
  - Line 119: `expect(measured.scrollHeight, "the fixture must be taller than the pane, or there is nothing to measure").toBeGreaterThan(` (Asserts height > pane viewport)
- **journey19-links.spec.mjs**
  - Line 83: `await expect(pane.locator(".file-dir-row .chip", { hasText: "fixture-widget-v2-bigger-2026-08-02.html" })).toBeVisible();` (Asserts presence of exactly named file in file pane)

*Incidental properties:*
While the main fixture contains ~1.9 MB of real Claude Code organic data (with thinking blocks, multi-line tool outputs, varied text), **no spec asserts on these exact real-world elements**. The presence of Cyrillic text, specific spaced path chips, and nested blocks are properties that *happen to be there* and provide realistic complexity for manual viewing/stress-testing, but the Playwright assertions only verify specific appended rows (artifacts > 2, height > window, precise filenames), not the vast bulk of the transcript's natural content.

### Train Fixture
*Asserted properties:*
- **journey9-train.spec.mjs**
  - Line 41: `await expect(page.locator("#transcript-body")).toContainText("the newest car of this train", {` (Asserts exact specific appended row text)
  - Line 154: `await expect(page.locator("#transcript-body")).toContainText("the first car of this train", {` (Asserts exact specific appended row text)
  - Line 193: `expect(ids.length, "the train has two cars, so there are two sessions to switch between").toBeGreaterThan(1);` (Asserts there are at least two sessions/cars)

*Incidental properties:*
The specific exact token counts (e.g. 61k vs 9k cache bytes) and specific `filler` padding text happens to be there to push the DOM layout, but the text contents of the filler turns is incidental.

### Recap and Restore Fixtures
*Asserted properties:*
- **journey21-recap.spec.mjs**
  - Line 90: `await expect(firstSaid).toContainText("Stubbed recap of", { timeout: 15_000 });` (Asserts exact message text indicating stub recap)
- **journey22-recap-restore.spec.mjs**
  - Line 80: `await expect(block).toContainText("RESTORED");` (Asserts specific matching ledger line text)

### Records Tree
*Asserted properties:*
- **journey4-records.spec.mjs**
  - Line 32: `await expect(items.nth(1)).toContainText("Fixture parent project");` (Asserts specific title text in panel)
- **journey10-panel.spec.mjs**
  - Line 60: `await expect(row(page, "Fixture train project"), "a sibling is out of view").toHaveCount(0);` (Asserts exactly 0 matches when filtered)
  - Line 65: `await expect(row(page, "Fixture dormant project"), "focus beats the recency window").toHaveCount(1);` (Asserts presence indicating focus overrules recency)

*Incidental properties:*
The specific markdown inside the notes (e.g. specific table values about wifi signal or struck-through text) is read and rendered, but mostly assertions only check for the presence of the table `thead`, not the exact content string values of every cell.

### Scroll Fixture
*Asserted properties:*
- **journey12-scroll.spec.mjs**
  - Line 123: `expect(at.scrollHeight, "the fixture must be taller than the pane, or there is nothing to measure").toBeGreaterThan(` (Asserts scrolling is possible)
  - Line 150: `expect(rest.composerInScroller, "the composer is the last element of the chat (SPEC 199)").toBe(true);` (Asserts DOM ordering)

*Incidental properties:*
The text of the 40 filler lines (`scroll fixture line X`) is purely incidental; any text producing enough height would satisfy the spec.

### Windowed Transcript Fixture
*Asserted properties:*
- **journey33-windowed.spec.mjs**
  - Line 72: `expect(at.scrollHeight, "the whole session is still reachable by scrolling").toBeGreaterThan(at.client * 20);` (Asserts total height is massive)
  - Line 119: `expect(start - moved.scrollTop, "the page went where the wheel sent it").toBeGreaterThan(3_000);` (Asserts large jumps occur correctly)

## 4. The hard cases

- **The Main Transcript (`journey.spec.mjs`)**:
  - *Why it's a hard case:* It relies on an external, real Claude Code transcript from `~/.claude/projects/`. The specs only explicitly require it to have enough turns/artifacts to crowd the gutter (e.g. >2 plain, >2 artifacts) and enough height to exceed the viewport (e.g., `expect(box.height).toBeGreaterThan(box.client + 200)`). There are NO assertions that explicitly establish that it requires hundreds or thousands of organic turns from a 1.9MB transcript. The requirement for a massive real transcript stems entirely from the human mandate in `VERIFY.md` to test against real-world layout "shapes that break a viewer", not from the code's `expect()` calls.
- **The Windowed Transcript (`journey33-windowed.spec.mjs`)**:
  - *Why it's a hard case:* It requires exactly 2,600 turns. The specs assert that `at.scrollHeight` is `toBeGreaterThan(at.client * 20)` and that a large scroll jump is possible (`toBeGreaterThan(3_000)`). The sheer volume dictates generating thousands of nodes to test the virtualized scrolling engine.
- **The Train Fixture (`journey9-train.spec.mjs`)**:
  - *Why it's a hard case:* It deeply couples token accounting logic to specific, temporally staggered synthetic inputs (one cold car vs. one fresh car).
- **The Queue and Scroll Fixtures (`journey18-queue.spec.mjs`, `journey12-scroll.spec.mjs`)**:
  - *Why they are hard cases:* These isolated projects are required because mutating lines mid-turn or manipulating scroll state in a shared fixture file caused race conditions and moved assertions for other concurrently running Playwright tests.

## 5. A verdict

Every external read **can** technically be replaced by generated data without weakening any explicit Playwright assertion in the test suite. Not a single Playwright spec actually asserts on the organic contents (such as unexpected thinking tags, specific 20k-char bash output) found within the real 1.9MB `~/.claude/projects/` base transcript. The specs only assert on the *appended* synthetic rows and minimal DOM geometry logic (e.g., "the fixture is taller than one screen"). Therefore, replacing the external transcript with purely generated synthetic data (or a much simpler 10-line base transcript) would satisfy 100% of the automated CI assertions.

The only "resistance" to generating this data comes from a non-programmatic, human policy: the documentation in `VERIFY.md` forbidding testing against a "synthetic three-line file" to avoid missing layout defects. However, from a strict assertion standpoint, replacing the external file breaks zero specs.
