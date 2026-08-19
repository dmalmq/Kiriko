# Kiriko verification map

This directory is the maintained source for verifying the user-facing behavior of Kiriko. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs launch` and leave it running after `Driveable at`.
- Origin is `http://127.0.0.1:14173`; backend health is `http://127.0.0.1:18790/healthz`.
- Data directory is `.kiriko-verify/run/data` (not `server/data`, not `.e2e-data`).
- Bootstrap account is `e2e` / `e2e-password`.
- `control-kiriko doctor` reports `"driveable": true`.
- Never drive `:5173`, a LAN share URL, or Playwright's `:4173`.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. Default locale is Japanese.
- Prefer ARIA roles and accessible names over CSS selectors or coordinates. Floor **short** labels are the visible text of `.floor-stack__btn`; the accessible name is the full floor label.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions against the doctor origin. The sign-in feature also has `control-kiriko drive sign-in-gallery`.
- After a mutation, confirm a second view (gallery card, reload, `GET /api/venues` or bundle through the frontend origin).
- Restore or accept leftover datasets only inside `.kiriko-verify/run/data`. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the Kiriko wordmark or sign-in title visible.
- Mutation proof includes a read-only second view of the stored value.
- Record the feature ID and entry point used with every artifact, in `.kiriko-verify/evidence/<feature-id>/`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-kiriko` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Sign in and gallery](./sign-in-gallery.md) covers anonymous sign-in, empty gallery, locale chips, and sign-out.
- [Publish a dataset](./publish-dataset.md) covers IMDF ZIP upload from the gallery, publish, and opening the new card.
- [Indoor map viewer](./indoor-viewer.md) covers floors, search, inspector, warnings, and locale on a published dataset.
- [Map issues](./map-issues.md) covers placing, posting, and seeing a review issue on a published dataset.

GDB import, 3D tiles, routing generation, and network review are user-facing but not in this map yet (they need source files this checkout does not ship).
