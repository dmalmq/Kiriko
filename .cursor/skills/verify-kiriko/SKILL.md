---
name: verify-kiriko
description: Drive the Kiriko indoor-GIS web app (gallery + MapLibre viewer) on an isolated local stack to prove user-facing behavior. Use when verifying a UI change, reproducing a gallery/viewer/issue bug, or capturing evidence of sign-in, publish, map, or review flows. Do not use Playwright's e2e ports (4173/8790) or the developer's ./dev.sh session as the proof target.
---

# Verify Kiriko

Kiriko is a bilingual (ja default, en peer) React/MapLibre indoor-GIS app: a gallery of published datasets and a floor-aware viewer with search, inspector, and map-pinned review issues. Fastify+SQLite is the backend; Vite proxies `/api` and `/v` to it.

This skill is for proving **user-visible** behavior on a stack this helper started. Unit tests and `pnpm test:e2e` are not a substitute: e2e boots `http://127.0.0.1:4173` plus a wiped `.e2e-data` on **:8790**, which collides with `./dev.sh` and is a different instance.

Read `features/README.md` before driving. Drive every entry point the matched feature file lists, or report the unmet one as unverified.

## Launch

Isolated ports so this can sit next to `./dev.sh` (`:5173` + `:8790`) without sharing cookies or SQLite:

| | Verify instance | Developer `./dev.sh` | Playwright e2e |
|---|---|---|---|
| Frontend | `http://127.0.0.1:14173` | `:5173` | `:4173` (preview) |
| Backend | `http://127.0.0.1:18790` | `:8790` | `:8790` |
| Data | `.kiriko-verify/run/data` | `server/data` | `.e2e-data` |
| Account | `e2e` / `e2e-password` | seeded LAN accounts | `e2e` / `e2e-password` |

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs launch
```

Leave this process running. It prints `Driveable at http://127.0.0.1:14173` when both ports answer, then holds the Vite **preview** + Fastify tree. Background it in the agent shell and wait for that line. First launch may run `pnpm core:build` and `vite build` (the preview server is the Playwright e2e shape: static `dist/`, no HMR). If you changed frontend files since `dist/` was built, stop the instance, set `KIRIKO_VERIFY_REBUILD=1`, and launch again — otherwise you will prove a stale bundle.

Override ports with `KIRIKO_VERIFY_FRONTEND_PORT` and `KIRIKO_VERIFY_BACKEND_PORT` only when 14173/18790 are taken by something that is **not** this instance. Vite's repo config hardcodes the 8790 proxy; the helper writes `.kiriko-verify/run/vite.config.mjs` so verify traffic never hits the developer backend, and so Vite does not watch `.kiriko-verify` (log writes would otherwise stall the dev server).

**Refuse to drive** `http://127.0.0.1:5173`, a LAN share URL, or any origin `doctor` did not mark `driveable`. A shared instance is the user's session.

Teardown:

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs stop
```

## Doctor

Run this first whenever anything looks off, and before the first interaction of a proof:

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs doctor
```

Exit `0` means driveable. The JSON must show:

- recorded frontend/backend PIDs still alive
- ports 14173 / 18790, data dir `.kiriko-verify/run/data`
- `healthz.ok === true`
- frontend HTML contains `#root` and the document title `IMDF Map Viewer` (the Kiriko wordmark is painted after React boots)
- unauthenticated `GET http://127.0.0.1:18790/api/auth/me` is 401
- `POST /api/auth/login` as `e2e` / `e2e-password` on the **backend** origin sets `kiriko_session` and `GET /api/auth/me` then returns that user
- frontend `GET /` on :14173 returns the `IMDF Map Viewer` document (one request; helper fetches send `Connection: close` so Windows Vite is not wedged by keep-alive)

Exit `2` means do not click anything. `launch` again, or stop a stale verify stack. Never kill by process name (`node`, `vite`, `tsx`); only `stop`, which kills PIDs from `.kiriko-verify/run/instance.json`.

## Drive

Open `http://127.0.0.1:14173` in the Cursor browser (or Playwright against that origin). Default UI locale is **Japanese**. Switch with the `日本語` / `EN` chips (`aria-pressed="true"` on the active one) before asserting English copy.

Stable handles (from `e2e/helpers.ts` and the live UI):

| What | Handle |
|---|---|
| Sign-in dialog | `role=dialog` name `Kiriko にサインイン` / `Sign in to Kiriko` |
| Username | label `メールアドレス` / `Email` (plain text; short names like `e2e` are valid) |
| Password | label `パスワード` / `Password` |
| Submit | button `サインイン` / `Sign in` |
| Gallery title | `.gallery__title` → `データセット` / `Datasets` |
| Open local data | button `ローカルデータを開く` / `Open local data` |
| IMDF file input | `input[type="file"][accept*=".zip"]` inside `.upload-modal` |
| Dataset name | label `データセット名` / `Dataset name` |
| Publish | button `公開` / `Publish` |
| Open published | link `開く` / `Open` (`href` starts `/?dataset=`) |
| Map ready | `.indoor-map[data-map-idle="true"]` and `.context-bar__name` |
| Floor | `.floor-stack__btn` whose **visible text** is the short label (`1F`, `B1`, `2F`); `aria-pressed="true"` when selected. Accessible name is the full floor label (`1階`, …) |
| Search rail | button `検索` / `Search` |
| Search box | `#viewer-search-input` label `検索` / `Search` |
| Inspector | `.floating-panel--inspector` |
| Issues rail | button `課題` / `Issues` (only on a **published** dataset, not a local ZIP) |
| Issues panel | `role=region` name `課題` / `Issues` |
| Back to gallery | link `ギャラリーへ戻る` / `Back to gallery` |
| Marker | `.indoor-marker[aria-label="…"]` |

Synthetic IMDF ZIP (venue 東京駅テスト会場 / Tokyo Station Test Venue):

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs fixture-zip
```

Writes `.kiriko-verify/run/minimal-imdf.zip` (path printed). Occupant `駅ナカショップ`, amenity `トイレ`, kiosk `案内キオスク`, floors `1F` / `B1` / `2F`.

Headless recipe for the mapped sign-in feature:

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs drive sign-in-gallery
```

Do not use `/?viewer` local-ZIP mode as proof that gallery publish works. Do not POST `/api/venues` as proof that the Open-local-data dialog works. `GET /api/venues` **after** a UI publish is the allowed side-effect check.

Map clicks that need a polygon under a marker: click a few pixels **below** the marker box (see `clickBelowMarker` in `e2e/helpers.ts`). Wait for `data-map-idle="true"` after floor changes, search selection, and pan/zoom; do not sleep a fixed number.

## Evidence

Write under `.kiriko-verify/evidence/<feature-id>/`. `stop` deletes `.kiriko-verify/run/` only.

Every proof includes:

1. **Action** — screenshot or ARIA snapshot of the control about to be used (signed-out dialog, upload form, floor stack, composer).
2. **Result** — screenshot or ARIA snapshot of the state after the action (gallery heading, published card, idle map + venue name, issue pin).
3. **Side effect** — a second user-facing view or a read through the **frontend origin**: `GET /api/venues`, `GET /v/default/<slug>/bundle` (200 + `Kiriko-Version-Id` header), or `GET /api/review/versions/<64-hex>/issues`.
4. `notes.md` naming the feature id, the entry point, and the locale used.

Proof standards:

- Exercise the path a producer/reviewer uses (gallery, map, issue panel), not test-only query params except where the feature file says a deep link **is** a user entry (`?dataset=`, `?lang=`, `?review=1`).
- `?src=` local ZIP and `?viewer` bypass the gallery; they prove the viewer shell, not publish.
- Absence is not a zero: empty gallery copy is `データセットがありません` / `No datasets yet`, never a card with `0 floors`.
- Mocks: none on this stack. The helper's Vite proxy talks to the helper's Fastify. Do not `page.route` a bundle or login.

## Cleanup

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs stop
```

Kills only `backendPid` and `frontendPid` from `instance.json` (Windows: `taskkill /T`). Deletes `.kiriko-verify/run/` (SQLite, logs, generated Vite config, fixture zip). Leaves `.kiriko-verify/evidence/` in place.

If launch fails halfway, run `stop` before retrying so 14173/18790 are not held by a half-started tree.

## Helpers

All invocations are from the repo root. `control-kiriko.mjs` is the only script; Node 24+ (see root `package.json` engines).

```bash
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs launch
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs doctor
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs fixture-zip
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs drive sign-in-gallery
node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs stop
```

Logs while a run exists: `.kiriko-verify/run/backend.log`, `.kiriko-verify/run/frontend.log`.
