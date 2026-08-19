# Publish a dataset

Publish lets a signed-in producer upload a local IMDF ZIP from the gallery, name the dataset, wait until validation finishes, and open the published venue from the success link or the new gallery card.

## Sub-features

- `publish-open-modal` opens the local-data dialog from the gallery button.
- `publish-file` accepts a `.zip` and prefills the dataset name from the file name.
- `publish-run` runs validation/publish and reaches the `公開しました` / `Published` state.
- `publish-open` opens the viewer from the modal `開く` / `Open` link.
- `publish-card` shows the new dataset on `/` with floor/feature stats, not "not published yet".

## How to get to it (user POV)

- Choose `ローカルデータを開く` / `Open local data` on the gallery.
- After success, choose the modal link `開く` / `Open`.
- After closing the modal, choose `開く` / `Open` on the dataset card.

## Driving it with control-kiriko

Preconditions:

- Kiriko is healthy at `http://127.0.0.1:14173` and `control-kiriko doctor` is driveable.
- You are signed in as `e2e` (see [sign-in-gallery](./sign-in-gallery.md)).
- A fixture ZIP exists. Run `node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs fixture-zip`.

- **Open modal.** Choose `ローカルデータを開く`. A dialog named `ローカルデータを開く` appears with an `IMDF ZIP` file input.
- **Choose file.** Set the file input to the fixture zip from `fixture-zip`. The `データセット名` field becomes the zip basename without `.zip`.
- **Publish.** Choose `公開`. The dialog shows `検証・公開処理中…` then `公開しました`. An `開く` link is visible within 20s; its `href` contains `?dataset=` and a slug derived from the name.
- **Open viewer.** Choose that `開く` link. `.context-bar__name` reads `東京駅テスト会場` (JA default) and `.indoor-map` has `data-map-idle="true"`. The document requested `/v/default/<slug>/bundle` with status 200 and a `Kiriko-Version-Id` header of 64 hex characters.
- **Card stats.** Go to `/`. The `.dataset-card` whose `.dataset-card__slug` matches that slug shows meta containing `3` and `フロア` (fixture has three levels). It does not show `処理中・未公開`.
- **Proof.** Save the published dialog, the idle map with venue name, and the gallery card. Also save the bundle URL and `Kiriko-Version-Id`. Put files in `.kiriko-verify/evidence/publish-dataset/`.

## Gotchas

- The modal `開く` is an `<a href="/?dataset=…">`, not the card button. Both are entry points; proving only `GET /?dataset=` typed by hand skips the modal path.
- Publish is asynchronous. Wait for `公開しました`, not a fixed sleep. If you only see `公開処理はサーバーで続いています`, choose `状況を確認` rather than assuming failure.
- Card filter: concurrent leftovers (if the data dir was reused) mean you must match `.dataset-card__slug`, not the first card.
- Fixture venue name is Japanese in the viewer even if the gallery is in EN, until you press `EN` on the viewer locale chips.
- Uploading through `/api/venues` + `/api/venues/:id/versions` is the e2e helper path, not this feature. Do not cite it as publish-modal proof.
