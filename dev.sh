#!/usr/bin/env bash
# Run the backend (Fastify platform server) and the frontend (Vite dev server) together.
# Usage: ./dev.sh
#
# Equivalent to running these in two terminals (backend first — Vite proxies
# /api and /v to the backend):
#   pnpm dev:server   # predev:server rebuilds @kiriko/node; tsx watch
#   pnpm dev          # predev rebuilds @kiriko/wasm; Vite on :5173
set -euo pipefail

cd "$(dirname "$0")"

# `pnpm` directly if it is on PATH, otherwise via corepack (pinned by
# package.json "packageManager").
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(corepack pnpm)
fi

# The Vite dev/preview proxies hardcode http://127.0.0.1:8790, so overriding
# KIRIKO_PORT here also requires editing vite.config.ts.
export KIRIKO_PORT="${KIRIKO_PORT:-8790}"
export KIRIKO_DATA_DIR="${KIRIKO_DATA_DIR:-./data}"

# Kill a process and its children. Git Bash on Windows needs taskkill, because
# `kill` misses the tsx/node grandchildren.
kill_tree() {
  local pid="$1"
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "${pid}" //T //F >/dev/null 2>&1 || true
  fi
  kill "${pid}" 2>/dev/null || true
}

# PIDs listening on KIRIKO_PORT, one per line (empty when the port is free).
# Git Bash on Windows has no lsof, so fall back to parsing netstat.
listening_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${KIRIKO_PORT}" -sTCP:LISTEN 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    # Windows netstat -ano columns: proto local foreign state pid
    netstat -ano 2>/dev/null |
      awk -v port=":${KIRIKO_PORT}$" \
        '$1 == "TCP" && $2 ~ port && $4 == "LISTENING" { print $5 }' |
      sort -u
  fi
}

# A leftover backend still holding the port answers /healthz below, so the
# readiness probe would report success while the backend started here dies with
# EADDRINUSE — leaving Vite proxying to the stale server. Refuse to start (or
# clear it out with KIRIKO_KILL_STALE=1) rather than serve stale code.
STALE_PIDS="$(listening_pids)"
if [ -n "${STALE_PIDS}" ]; then
  STALE_LIST="$(echo "${STALE_PIDS}" | tr '\n' ' ')"
  if [ "${KIRIKO_KILL_STALE:-0}" = "1" ]; then
    echo "Port ${KIRIKO_PORT} held by pid(s) ${STALE_LIST}— killing (KIRIKO_KILL_STALE=1)."
    for pid in ${STALE_PIDS}; do
      kill_tree "${pid}"
    done
    for _ in $(seq 1 10); do
      [ -z "$(listening_pids)" ] && break
      sleep 1
    done
    if [ -n "$(listening_pids)" ]; then
      echo "Port ${KIRIKO_PORT} is still held after the kill; stop it manually." >&2
      exit 1
    fi
  else
    echo "Port ${KIRIKO_PORT} is already in use by pid(s) ${STALE_LIST}(likely a" >&2
    echo "backend left over from an earlier run). Starting now would serve that" >&2
    echo "stale server. Re-run with KIRIKO_KILL_STALE=1 ./dev.sh to replace it." >&2
    exit 1
  fi
fi

# Start the backend. `predev:server` rebuilds the @kiriko/node addon first, so
# the first run (or any run after a Rust change) takes a while.
echo "Starting backend on http://127.0.0.1:${KIRIKO_PORT} (data: ${KIRIKO_DATA_DIR})"
"${PNPM[@]}" dev:server &
BACKEND_PID=$!

# Stop the backend when this script exits (e.g. Ctrl-C).
cleanup() {
  echo "Stopping backend (pid ${BACKEND_PID})..."
  kill_tree "${BACKEND_PID}"
}
trap cleanup EXIT

# Wait for the backend to answer before starting Vite, so the proxy has
# something to talk to. Give the addon rebuild plenty of time.
echo "Waiting for backend..."
for _ in $(seq 1 300); do
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found; starting frontend without waiting."
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "Backend exited before becoming ready." >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${KIRIKO_PORT}/healthz" >/dev/null 2>&1; then
    echo "Backend ready."
    break
  fi
  sleep 1
done

# Start the frontend in the foreground; when you Ctrl-C, cleanup kills the
# backend. `predev` rebuilds @kiriko/wasm (needs clang for wasm32 — see
# CLAUDE.md).
echo "Starting frontend (Vite) on http://127.0.0.1:5173"
"${PNPM[@]}" dev
