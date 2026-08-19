# Map issues

Map issues let a signed-in reviewer pin a comment on a **published** dataset version, type a body, post it, and see the same issue as a map pin and in the Issues list. Local ZIP viewer mode has no issue rail.

## Sub-features

- `issues-open` opens the Issues panel from the icon rail.
- `issues-place` starts a new issue and places the pin at map center.
- `issues-post` submits a body and shows issue `#1` as Open.
- `issues-pin` exposes an accessible pin named with the number, excerpt, and status.
- `issues-reload` still shows the issue after a full reload of the same `?dataset=` URL.

## How to get to it (user POV)

- Open a published dataset (gallery `開く` or `/?dataset=<slug>&lang=en`) while signed in.
- Choose the rail button `課題` / `Issues`.
- Choose `新しい課題` / `New issue`, then `地図の中心に配置` / `Place at map center`.

## Driving it with control-kiriko

Preconditions:

- Kiriko is healthy at `http://127.0.0.1:14173` and doctor is driveable.
- Signed in as `e2e`.
- A fixture dataset is published (see [publish-dataset](./publish-dataset.md)).
- Locale EN is recommended for this recipe so names match `e2e/issues.spec.ts`: choose `EN` after load, or open `/?dataset=<slug>&lang=en`.

- **Open dataset.** Load the published slug. Wait for idle map and venue name `Tokyo Station Test Venue` (EN) or `東京駅テスト会場` (JA).
- **Open Issues.** Choose the rail button `Issues` / `課題` so `aria-pressed="true"`. A region named `Issues` / `課題` is visible. Empty active copy is `No active issues` / `進行中の課題はありません`.
- **Start placement.** Choose `New issue` / `新しい課題`. Choose `Place at map center` / `地図の中心に配置`.
- **Compose.** Fill `Issue body` / `課題の本文` with `Check the ticket gate alignment`. Optionally set `Assignee` to `e2e`.
- **Post.** Choose `Post issue` / `課題を投稿`. One `.issue-pin` appears. Its accessible name matches `/Issue #1.*Check the ticket gate alignment.*Open/` (EN) or `/課題 #1.*Check the ticket gate alignment.*オープン/` (JA). The queue lists that excerpt.
- **Reload.** Reload the same URL. After idle, open Issues if needed. The pin count is still 1 and the body excerpt remains. `GET /api/review/versions/<Kiriko-Version-Id>/issues` through the frontend origin returns an `issues` array whose first body is that markdown.
- **Proof.** Capture the composer before post, the pin + queue after post, and the post-reload queue. Directory: `.kiriko-verify/evidence/map-issues/`. Record the public version id from the bundle response header `Kiriko-Version-Id`.

## Gotchas

- The Issues rail is omitted for `?src=` / `?viewer` local ZIP loads and when the bundle has no review identity. If the button is missing, you are not on a published dataset; do not improvise a pin in local mode.
- Switch locale only after the panel is open if you need to prove bilingual controls (`Place at map center` vs `地図の中心に配置`). Placement mode is a bad time to lose the draft.
- Posting without placement is impossible; the composer mounts after a successful place. If you do not see `Issue body`, you are still in placement.
- Assignee and due date are optional and must not block post.
- Proving via `POST /api/review/versions/.../issues` from a script skips `issues-place` and `issues-post` UI entry points. Use that GET only as the reload side effect.
- Click-the-map placement is a second user path; this map documents map-center as the stable one. If you use a map click, say so in `notes.md` and still wait for idle.
