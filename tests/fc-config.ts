/**
 * How hard the property suite hunts — preloaded into every `bun test` run (`bunfig.toml`).
 *
 * The gate used to run the whole property suite THREE TIMES, because `tasks.props` failed on
 * roughly one seed in sixteen and a single green run had been read as a verdict (verify.ts,
 * 2026-08-10). Three runs of fast-check's default 100 is 300 cases per property, bought with three
 * times the wall clock — and it is the worst way to spend it: the same generator, restarted, with
 * no shrinking across the runs.
 *
 * 400 in one run is more cases than the three gave, in a third of the time, and a failure comes
 * back shrunk with a seed to reproduce it. Measured 2026-08-23: 447 properties at 400 runs each is
 * 231,293 assertions in 7.75 seconds.
 *
 * `FC_RUNS=<n>` raises it for a deliberate hunt without touching this file.
 */
import fc from "fast-check";

fc.configureGlobal({ numRuns: Number(Bun.env["FC_RUNS"] ?? "400") });
