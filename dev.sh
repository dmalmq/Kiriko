#!/usr/bin/env bash
# Run the backend (Fastify platform server) and the frontend (Vite dev server)
# together, with the testing accounts seeded and the frontend reachable from the
# office LAN so colleagues can open it.
# Usage: ./dev.sh
#
# Equivalent to running these in two terminals (backend first — Vite proxies
# /api and /v to the backend):
#   KIRIKO_SEED_DEV_USERS=1 KIRIKO_SEED_PASSWORD=… pnpm dev:server
#   pnpm share        # = vite --host, so :5173 answers on the LAN
#
# One port is enough: Vite serves the app and proxies both /api and /v to the
# backend on loopback, so the backend itself stays unexposed.
#
# Environment:
#   KIRIKO_SEED_PASSWORD  shared password for every seeded account. Read from the
#                         environment, else from <data dir>/dev-password, else
#                         prompted for once and saved there. Never has a default:
#                         a guessable password on a network-reachable instance is
#                         the one failure this cannot be allowed to have.
#   KIRIKO_SHARE=0        keep Vite on loopback (the old behaviour).
#   KIRIKO_SEED=0         start without touching accounts.
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

# The same directory the backend will use. `pnpm dev:server` runs with cwd
# `server/`, so a relative KIRIKO_DATA_DIR resolves under it — and this script
# needs the same path to read the account list and keep the password beside it.
case "${KIRIKO_DATA_DIR}" in
  /* | [A-Za-z]:[\\/]*) DATA_DIR="${KIRIKO_DATA_DIR}" ;;
  *) DATA_DIR="server/${KIRIKO_DATA_DIR#./}" ;;
esac

# Seed the testing accounts, so the people this is shared with can sign in.
#
# The server upserts them on every start: it resets password and role for the
# accounts it is given and leaves every other account alone. The list comes from
# `<data dir>/seed-users.json`, which is deliberately not in the repository —
# adding a colleague should not be a commit. With no such file the server seeds
# its built-in admin/member/viewer trio instead.
if [ "${KIRIKO_SEED:-1}" = "1" ]; then
  export KIRIKO_SEED_DEV_USERS=1

  # No default, ever. This instance answers on the LAN in a moment, and a
  # guessable shared password is the one thing that must not be inherited from a
  # script. Stored in the gitignored data directory so it is typed once.
  PASSWORD_FILE="${DATA_DIR}/dev-password"
  if [ -z "${KIRIKO_SEED_PASSWORD:-}" ] && [ -s "${PASSWORD_FILE}" ]; then
    KIRIKO_SEED_PASSWORD="$(tr -d '\r\n' < "${PASSWORD_FILE}")"
  fi
  if [ -z "${KIRIKO_SEED_PASSWORD:-}" ]; then
    if [ ! -t 0 ]; then
      echo "No KIRIKO_SEED_PASSWORD, no ${PASSWORD_FILE}, and no terminal to ask." >&2
      echo "Set KIRIKO_SEED_PASSWORD, or run once interactively to save one." >&2
      exit 1
    fi
    printf 'Password for the shared testing accounts: ' >&2
    IFS= read -rs KIRIKO_SEED_PASSWORD || true
    printf '\n' >&2
    if [ -z "${KIRIKO_SEED_PASSWORD}" ]; then
      echo "Empty password; nothing would be seeded. Aborting." >&2
      exit 1
    fi
    mkdir -p "${DATA_DIR}"
    (
      umask 077
      printf '%s\n' "${KIRIKO_SEED_PASSWORD}" > "${PASSWORD_FILE}"
    )
    echo "Saved to ${PASSWORD_FILE} (gitignored) — delete it to change the password."
  fi
  export KIRIKO_SEED_PASSWORD
fi

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

# Who can sign in, so the list can be handed out without opening a JSON file.
# The password is not printed: it is the one that was typed or supplied.
if [ "${KIRIKO_SEED:-1}" = "1" ]; then
  SEED_FILE="${DATA_DIR}/seed-users.json"
  if [ -s "${SEED_FILE}" ]; then
    echo "Accounts seeded from ${SEED_FILE}:"
    # Parsed rather than pattern-matched: this file is edited by hand, and a
    # grep pairing `username` with `role` silently swaps them the moment someone
    # writes the keys the other way round. Node is already a prerequisite here.
    node -e '
      const { users } = require(process.argv[1]);
      for (const user of users) console.log(`  ${user.username} (${user.role})`);
    ' "$(pwd)/${SEED_FILE}" || echo "  (could not read the list — the server logs what it seeded)"
  else
    echo "Accounts seeded (built-in set — no ${SEED_FILE}):"
    echo "  admin (admin)"
    echo "  member (member)"
    echo "  viewer (viewer)"
  fi
  echo "  ...all sharing the password you supplied."
fi

# Start the frontend in the foreground; when you Ctrl-C, cleanup kills the
# backend. `preshare`/`predev` rebuilds @kiriko/wasm (needs clang for wasm32 —
# see AGENTS.md).
if [ "${KIRIKO_SHARE:-1}" = "1" ]; then
  # The address this machine would actually use to reach the network, which is
  # not the same as the first one it enumerates: on a box with Hyper-V or WSL,
  # enumeration order hands out a virtual adapter (172.28.x here) that no
  # colleague can reach. `Find-NetRoute` answers the routing question directly
  # and sends no traffic.
  LAN_IP=""
  if command -v powershell >/dev/null 2>&1; then
    LAN_IP="$(powershell -NoProfile -Command \
      "(Find-NetRoute -RemoteIPAddress 1.1.1.1 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress" \
      2>/dev/null | tr -d '\r\n ' || true)"
  elif command -v ip >/dev/null 2>&1; then
    LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)"
  fi
  # A machine with no default route still has a LAN address worth printing.
  if [ -z "${LAN_IP}" ] && command -v hostname >/dev/null 2>&1; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi

  echo
  if [ -n "${LAN_IP}" ]; then
    echo "Sharing on http://${LAN_IP}:5173 — hand that out."
  else
    echo "Sharing on port 5173 of this machine's LAN address."
  fi
  # Plaintext HTTP with a shared password and non-Secure session cookies: anyone
  # on this network can read a session. Fine for colleague testing, not for
  # anything real — said here because this is the moment it becomes true.
  echo "Plaintext HTTP, shared password, non-Secure cookies: colleague testing only."
  echo "If nobody can connect, the firewall needs this once, in an elevated shell:"
  echo "  New-NetFirewallRule -DisplayName \"Kiriko dev\" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow"
  echo
  "${PNPM[@]}" share
else
  echo "Starting frontend (Vite) on http://127.0.0.1:5173 (loopback only)"
  "${PNPM[@]}" dev
fi
