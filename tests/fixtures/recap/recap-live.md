# State

Repository is healthy (422 commits, `git fsck --full` passes). Aug 4 incident was repaired non-destructively; tag `vigil-2026-08-05-pre-repair` marks the forensic state. Both a MacBook and this box are running Resilio (Syncthing is not active anywhere). The `.sync/Archive` holds a complete forensic record of what was deleted: 153 loose objects, eight generations of `.git/index` and reflogs, and the commit object at `refs/heads/master`.

Research is complete and committed. User approved option (b): finalize the synthesis, then test the IgnoreList question experimentally before writing the migration procedure.

# Open threads

None. The MacBook's half of the migration procedure is documented but untested — it requires stopping Resilio via `pgrep -fl "Resilio|rslsync"` and confirming the absence of the background agent (closing the menu-bar app is not enough). The external store path must clear all cloud-sync agents (iCloud Drive Desktop/Documents, MDM-managed OneDrive, Google Drive); this is documented as requiring confirmation on the actual Mac, not verified from here.

# Decisions made (with the why)

**The delay hypothesis is dead.** Three independent lines of evidence:

1. Git's `lockfile.h`: *"lockfiles only block other writers. Readers do not block, but they are guaranteed to see either the old contents of the file or the new contents of the file (**assuming that the filesystem implements rename(2) atomically**)"* — the entire safety model is one syscall on one local filesystem. A syncer has no concept of that boundary and cannot respect what it cannot observe.

2. Resilio's own documentation: the Pro-tier "Paused" mode (the vendor's answer to your delay idea from users in 2016) states explicitly *"zero sized files will be synced either way… **file's deletion will be synced either way**; new files will be rescanned."* Deletions propagate even during pause.

3. The Archive evidence: the 153 objects and destroyed commit object in `.sync/Archive/` prove this box received the MacBook's deletions — a settled, complete state being replicated correctly. Waiting longer replicates faithfully, not slower.

**The solution is unanimous and costs the property you hoped to keep.** Every authority consulted says the same: Syncthing's lead dev twice ("Do not use Syncthing to sync Git repositories. Seriously. Do not"); Resilio's own blog (use a bare remote, not a live synced repo, because "if one synced repo gets damaged, that damage reproduces in all"); the obsidian-git maintainer ("As long as you don't sync the `.git` folder, it should be working fine"). The working tree stays in the vault, syncing unattended and visible in Obsidian. Only `.git` stops being replicated; each machine keeps its own outside the vault, reconciling through GitHub. **This is "move git out", scoped to the metadata instead of the project.** Whether that's a real distinction or a reframing of what you rejected is stated in the synthesis as something to argue with, not asserted as settled.

**The three failure classes are real but only one applies here.** Partial-state corruption (sync catches a multi-step operation mid-way) — delay helps. Divergent per-machine files (index, logs differ by design) — delay does nothing. Deletion propagation (gc deletes objects, syncer propagates the deletion) — this is what happened; delay only reduces frequency, not possibility.

# Decided but never written down

**Whether to test IgnoreList's retroactivity.** The user approved (b) — test experimentally, then finalize. The experiment was designed to avoid needing that answer: migration removes `.git` with both daemons stopped, then adds the ignore rule afterwards, so retroactivity doesn't matter. This decision (design the migration to be agnostic about retroactivity) was mine, made while running experiments, not stated back to the user. If IgnoreList's behavior is a dealbreaker, this choice is wrong.

# Landed (git-confirmed)

Commit `3fa2e15`:
- **synthesis.md** — the final recommendation with four ranked configurations (bare-outside + worktree-inside, `--separate-git-dir` via relative pointer, syncing a bundle, using Resilio's CLI pause). Each names its cost per day and residual failure modes.
- **experiment.md** — nine tested procedures: the gitdir pointer approach (tests byte-identical pointer file across machines, commits independently, fsck clean), the daily workflow (`merge --ff-only` + `stash push -u` fallback), and the real-repo migration (copy actual `.git`, reinit, verify byte-identical HEAD/commits/refs/tags with `fsck`).
- **counter-review.md** — two rounds of adversarial review. Round 1 caught six objections; three were testable (reset orphaning commits, checkout destroying work, untracked-file clobber), and counter-review caught me prescribing something dangerous twice. Round 2 verified all patches hold and flagged two new scoping gaps (already fixed by the time it reported).
- **first-party-evidence.md** — the `.sync/Archive` analysis proving the MacBook's write clobbered this box's `.git`, and the deletion sequence.
- **agent-w1/2/3/4-c1.md** — the four research streams (git's on-disk safety model; Resilio and Syncthing's sync knobs; topology and placement options; field evidence from forums). W1 found the `rename(2)` sentence. W2 found Resilio's pause mode still propagates deletions. W3 found Syncthing's dev's "do not" statement and Resilio's blog recommendation. W4 found every multi-year success was because `.git` was never actually exposed to the syncer.
- **sources.md** — 37 sources across 18 domains, with Coverage section flagging two URL gaps.

# Claimed but unconfirmed

- Stopping Resilio on macOS (documented from vendor docs; requires `pgrep` verification on the actual Mac).
- External store path clears all cloud-sync agents on a managed MacBook (documented as a gate; cannot verify from here).
- IgnoreList's per-device, non-retroactive semantics actually prevent a half-migrated state from breaking both peers (the migration is sequenced to avoid testing this, so it's not confirmed).

# Traps

1. **The migration is half-reversible, not fully.** Once `.git` is removed and the ignore rule added, the working tree stays dirty on the other peer until `fetch + merge --ff-only` (or reset if merge fails). Both machines must be migrated within the same sitting, or one side has uncommitted noise every sync cycle. Pausing partway through is the trap.

2. **The daily rule survived testing only because it assumes syncer delivery is reliable.** The tested sequence is `fetch → merge --ff-only → stash push -u if it aborts`. If the syncer already delivered the right content, `merge --ff-only` succeeds in one step — that's the common path. But the rule is correct only if that assumption holds, which is what this whole exercise was built to avoid. It's documented accurately, but it's the kind of assumption that can burn you in edge cases.

3. **The gitdir pointer depth is easy to guess wrong.** It's relative from the `.git` file's location. From `docs/Projects/Personal Claude/<repo>/` it takes four hops to clear the vault, not three. If the user sets up the store with the wrong depth, git fails with `fatal: not a git repository` instead of resolving silently. The experiment tested this and documented the depth; a user setting this up after reading the synthesis might guess.

4. **"Move git out" is a reframing, not an escape.** The synthesis states this plainly and invites the user to argue it, but it's the kind of thing that needs active disagreement if it's not acceptable. The user rejected the tree leaving the vault; here only metadata leaves. Worth flagging as a possible read-mismatch.

5. **The external store must stay outside cloud-sync agents.** iCloud Drive Desktop/Documents, MDM-managed OneDrive, Google Drive on a work MacBook will silently replicate `.git` if it's inside them, reproducing the exact problem. This is named in the synthesis but cannot be verified from Linux; if the user puts the store in one of these without realizing, the approach fails silently.