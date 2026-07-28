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

# Start the backend. `predev:server` rebuilds the @kiriko/node addon first, so
# the first run (or any run after a Rust change) takes a while.
echo "Starting backend on http://127.0.0.1:${KIRIKO_PORT} (data: ${KIRIKO_DATA_DIR})"
"${PNPM[@]}" dev:server &
BACKEND_PID=$!

# Stop the backend when this script exits (e.g. Ctrl-C).
cleanup() {
  echo "Stopping backend (pid ${BACKEND_PID})..."
  if command -v taskkill >/dev/null 2>&1; then
    # Git Bash on Windows: `kill` misses the tsx/node grandchildren.
    taskkill //PID "${BACKEND_PID}" //T //F >/dev/null 2>&1 || true
  fi
  kill "${BACKEND_PID}" 2>/dev/null || true
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
