REVIEW TASK - do not merge anything, do not "improve" the feature. Produce a verdict.

Repository: sadtruth/loom, branch `preprompt-panel` (already pushed). Compare against `main`.

## What the feature is

Loom is a browser UI over Claude Code sessions. This branch adds "preprompt": before you send an
expensive message, you press `gather` in the composer, a CHEAP model (Gemini flash, via a local
proxy) explores the repository with read-only commands in a child process, and what it found is
drawn in the transcript as a package you can read and then Accept into the session.

New code to review:
- `server/preprompt.ts` - the supervisor: spawns the runner, polls its run directory, turns what
  appears there into a server-sent-event stream.
- `server/main.ts` - six routes (search for "preprompt"), plus a line in the signal handler.
- `client/preprompt.ts` - the package as drawn in the transcript.
- `client/app.ts`, `client/store.ts`, `client/index.html`, `client/style.css` - wiring and styles.

The runner itself is NOT in this repository (it lives in a private vault) and you cannot run it:
it needs a model proxy on localhost. `LOOM_PREPROMPT_CMD` points at it. So you cannot exercise
the feature end to end - `review/real-runs.md` on this branch carries three real runs, captured
on the machine where it does work, with the commands, their outputs, and the packages produced.
Treat that file as the evidence of behaviour, and be as hard on the RESULTS in it as on the code:
were those three gathers any good? Would the package be worth handing to an expensive model, or
is it padding? If the runs are weak, say so and say why.

## The requirements this must satisfy

These come from the design conversation with the user, and the last build ignored half of them,
which is why this review exists.

1. The gather runs beside the session. The session is untouched and usable while it runs.
2. A `gather` button next to Send, and Ctrl+Shift+Enter from the composer.
3. The result appears IN THE TRANSCRIPT, under the question that started it - not in a side rail.
4. Each command is shown with the time it ran and its COMPLETE output.
5. No durations anywhere. They were dropped deliberately.
6. The model's own notes are shown as prose.
7. Controls: a text box plus "Ask for more", "Accept -> send", "Discard".
8. The package that Accept would send is readable BEFORE accepting.
9. Every number is labelled: model, step n of 25, tokens read/written, elapsed.
10. Loom's own light palette. No dark panel. The rest of the UI is white.
11. A page reload mid-run redraws the running gathers rather than losing them.
12. Gathering works BEFORE a session exists - that is the normal case. With no session, Accept
    puts the package in the composer instead of sending it.

## What to report

Write ONE file, `review/preprompt-panel-review.md`, containing:

- A verdict line per requirement: met / partly / missed, each with `file:line` evidence.
- Defects, most severe first, each with `file:line`, what breaks, and the concrete input or
  sequence that breaks it. Reason about at least these, and anything else you find: reload
  mid-run; two browser tabs on one job; Accept pressed twice; "Ask for more" while a round is
  still running; the server killed mid-run; an expired auth cookie; a command whose output is
  megabytes; a job that never finishes; unbounded growth of the in-memory event history; a
  session id or command text containing HTML; a run directory that never appears.
- Anything structurally insane: a wrong place for a decision, a duplicated code path, state that
  cannot survive its own lifecycle, an invariant asserted in a comment but not in the code.
- A judgement on the three captured runs: useful, or theatre?
- If you think a requirement is satisfied only on paper - drawn but useless in practice - say so.

Do not soften anything. A review that says "looks good" is worthless to us. If the design itself
is wrong, say that too, and say what it should have been.
