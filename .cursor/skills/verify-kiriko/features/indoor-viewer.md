# Indoor map viewer

The indoor viewer loads a published dataset on the map, lets a reviewer change floors, search for a feature, inspect it, read import warnings, and switch language. The map is idle only when `.indoor-map[data-map-idle="true"]`.

## Sub-features

- `viewer-load` shows the venue name, default floor `1F`, and idle map.
- `viewer-floors` selects `B1` and `2F` and updates `.context-bar__level`.
- `viewer-search` finds `駅ナカショップ` / `Station Shop` and selects it.
- `viewer-inspect` shows the inspector panel for the selection.
- `viewer-warnings` lists the fixture warning codes in the Warnings panel.
- `viewer-locale` switches visible labels between 日本語 and EN.
- `viewer-back` returns to the gallery via the context bar.

## How to get to it (user POV)

- From a gallery card, choose `開く` / `Open`.
- From a just-published modal, choose `開く` / `Open`.
- Open `/?dataset=<slug>&lang=ja` (or `lang=en`) as a shareable deep link.

## Driving it with control-kiriko

Preconditions:

- Kiriko is healthy at `http://127.0.0.1:14173` and doctor is driveable.
- A fixture dataset is published (see [publish-dataset](./publish-dataset.md)). Note its slug.
- You are signed in as `e2e` if you will use the gallery entry. The dataset deep link is readable while signed in on this stack.

- **Gallery entry.** On `/`, choose `開く` on the card whose slug matches. Wait until `.context-bar__name` is `東京駅テスト会場` and `.indoor-map[data-map-idle="true"]`.
- **Deep link entry.** Open `http://127.0.0.1:14173/?dataset=<slug>&lang=en`. `.context-bar__name` is `Tokyo Station Test Venue`. Do not treat this as proof of the gallery `開く` button.
- **Default floor.** `.floor-stack__btn` whose text is `1F` has `aria-pressed="true"`. `.context-bar__level` is `1階` (JA) or `1F` (EN). Markers `トイレ` / `Restroom`, `案内キオスク` / `Info Kiosk`, and `駅ナカショップ` / `Station Shop` are visible on 1F in the matching locale.
- **Floor B1.** Choose the floor button with text `B1`. It becomes `aria-pressed="true"`, the map returns to idle, and `.context-bar__level` is `地下1階` (JA) or `B1` (EN).
- **Floor 2F then 1F.** Choose `2F`, wait idle, then `1F` again before search.
- **Search.** If `#viewer-search-input` is hidden, choose the rail button `検索` / `Search`. Fill the search box with `ショップ` (JA) or `Station` (EN). A `.list-row` containing `駅ナカショップ` / `Station Shop` appears. Choose it. Map goes idle; `.floating-panel--inspector` is visible and contains that name.
- **Warnings.** Choose the rail button `警告` / `Warnings` (badge is non-zero on this fixture). `.warnings-panel` lists codes including `missing_display_point`, `unresolved_reference`, and `missing_locale`.
- **Locale.** Choose `EN` then `日本語` in the viewer `言語` / `Language` group. Floor stack accessible names and marker `aria-label`s follow the locale. Pressed floor stays `1F` short text.
- **Back.** Choose `ギャラリーへ戻る` / `Back to gallery`. Gallery title `データセット` / `Datasets` is visible and the card for the slug remains.
- **Proof.** Capture idle 1F with venue name, a non-1F floor, search results + inspector, and the warnings list. Directory: `.kiriko-verify/evidence/indoor-viewer/`. Include the slug and whether you used gallery `開く` or `?dataset=`.

## Gotchas

- Search opens by default on a wide viewport; on a compact viewport the rail starts closed. Check `#viewer-search-input` visibility before clicking the rail.
- Issues are **not** part of this feature. Local `?viewer` ZIP uploads also hide Issues. Use [map-issues](./map-issues.md) on a published dataset.
- Clicking a marker label may miss the polygon; click slightly below the marker if inspect does not open.
- `data-map-idle` can flicker false during a floor change. Assert it true **after** the click, with a wait, not by sampling immediately.
- Fixture warning count is five rows (three `missing_display_point`). Assert codes, not a hard-coded badge you eyeballed once.
- `/?src=` and `/?viewer` load a ZIP without publishing. They do not prove this feature's gallery or `?dataset=` entry points.
