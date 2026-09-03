#!/usr/bin/env bash
# Start the loom and open it. Safe to run any time: it only ever READS the transcript store.
set -euo pipefail
cd "$(dirname "$0")"

[[ -d node_modules ]] || bun install

# A session worktree carries `.session` at the repo root (tools/session/session.sh new). The port is
# the one thing that must differ per worktree, so read it instead of making every session remember an
# env var. The main tree has no marker and keeps 4173, the port loom.service serves.
SESSION_PORT="$(sed -n 's/^port=//p' ../../.session 2>/dev/null || true)"
# The marker beats the environment: loom.service exports LOOM_PORT=4173 and loom spawns
# the sessions, so an inherited 4173 would follow you into every worktree (2026-08-10).
PORT="${SESSION_PORT:-${LOOM_PORT:-4173}}"
export LOOM_PORT="$PORT"

( sleep 1
  if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"
  fi ) &

exec bun server/main.ts
