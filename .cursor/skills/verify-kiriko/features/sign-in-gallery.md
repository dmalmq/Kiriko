# Sign in and gallery

Sign in takes an anonymous visitor from the Kiriko sign-in dialog to the dataset gallery for account `e2e`, shows an honest empty state when nothing is published, lets them switch Japanese/English copy, and returns them to the dialog on sign-out.

## Sub-features

- `signin-anonymous` shows the sign-in dialog on `/` with no session.
- `signin-submit` authenticates `e2e` and reveals the gallery chrome.
- `gallery-empty` states that there are no datasets yet, without a zero count.
- `gallery-locale` switches gallery copy between 日本語 and EN.
- `signout` clears the session and restores the sign-in dialog.

## How to get to it (user POV)

- Open `http://127.0.0.1:14173/` with no `kiriko_session` cookie.
- Choose `サインアウト` / `Sign out` from the gallery header.

## Driving it with control-kiriko

Preconditions:

- Kiriko is healthy at `http://127.0.0.1:14173`.
- `control-kiriko doctor` reports `"driveable": true`.
- The disposable data directory has no venues (fresh launch).

- **Anonymous entry.** Open `/`. Run `node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs doctor` then navigate to `http://127.0.0.1:14173/`. A dialog named `Kiriko にサインイン` is visible; `.gallery__title` is not.
- **Wrong password.** Fill `メールアドレス` with `e2e` and `パスワード` with `nope`, then choose `サインイン`. An alert `メールアドレスまたはパスワードが違います` appears and the dialog stays.
- **Sign in.** Fill `メールアドレス` with `e2e` and `パスワード` with `e2e-password`, then choose `サインイン`. `.gallery-header__wordmark` reads `Kiriko`, `.gallery__title` reads `データセット`, and a chip shows `e2e`.
- **Empty gallery.** With no published venues, the page shows `データセットがありません` and the hint `IMDF ZIP をアップロードして最初のデータセットを公開しましょう。` There is no `.dataset-card`.
- **Locale EN.** Choose `EN` in the `Language` group. `aria-pressed` is `true` on `EN`. Title becomes `Datasets`, empty copy becomes `No datasets yet`.
- **Locale JA.** Choose `日本語`. Title returns to `データセット`.
- **Sign out.** Choose `サインアウト`. The sign-in dialog named `Kiriko にサインイン` returns.
- **Automated proof.** Run `node .cursor/skills/verify-kiriko/scripts/control-kiriko.mjs drive sign-in-gallery`. Exit code `0`; `.kiriko-verify/evidence/sign-in-gallery/` contains `signed-out.png`, `signed-in.png`, matching `.aria.yml` files, `venues.json` with `"venues": []`, and `notes.md`.
- **Proof.** Capture signed-out and signed-in states. Artifacts identify Kiriko, the `e2e` chip after submit, and the empty-gallery sentence (not a numeric zero).

## Gotchas

- The username field is labelled Email/メールアドレス but accepts the short name `e2e`; browser `type=email` validation is not used.
- Default locale is Japanese even when the browser is English. Assert JA copy unless you pressed `EN`.
- `drive sign-in-gallery` does not cover wrong-password or sign-out. Those entry points still need a browser pass, or report them unverified.
- A 200 from `/healthz` on **:8790** is the developer backend. Doctor must pass on **:18790** and the frontend origin **:14173**.
- After sign-out, a cached gallery view is a failed proof. The dialog must be the thing on screen.
