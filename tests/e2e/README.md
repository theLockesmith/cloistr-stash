# The Playwright suite in this directory does not run in CI, on purpose

Measured 2026-09-04. This is the "no job, and here is why" answer, not an oversight.

## What was asked

`cloistr-stash` was one of eight repos found shipping a test suite that no CI job
ever executed. Seven of the eight got a test job. This one was scoped as
*investigate first*, because an E2E suite that needs a live service can be worse
than the gap it closes: a flaky blocking gate teaches people to ignore red
pipelines. That call was already made once, on `cloistr-space`.

## What the investigation found

**The suite has not been runnable in its configured form since the Vite
migration.** `playwright.config.js` started the server with no `-web` flag, so it
served `web/` — the Vite *source* tree — instead of `web/dist`. What a browser
got back was `web/index.html` verbatim: `<div id="root"></div>` and
`<script type="module" src="/src/main.tsx">`. The Go static handler serves
`/src/main.tsx` with content type `application/x-tiled-tsx`, which a browser will
not execute as a module. The app never mounted. Every spec ran against an empty
`#root`, and every failure was a locator that could not have existed.

Production has always served the build: `Dockerfile:47` copies `/web/dist` to
`/app/web`, and `Dockerfile:54` passes `-web /app/web`. That mismatch is fixed in
this commit — the config now builds `web/` and serves `web/dist`, so a local run
tests what ships.

**With that fixed, the suite still fails almost completely.** Against the real
built app, served correctly:

    npx playwright test --project=chromium --retries=0 --workers=4
    169 failed, 5 passed (8.2m)

Chromium alone. The config declares four browser projects, `workers: 1` and
`retries: 2` under CI, so a CI run would be roughly an order of magnitude longer.

**The reason is that the specs describe a UI that no longer ships.** They were
written against the pre-migration vanilla-JS app in `web/legacy/`. Of 146 DOM ids
the specs target, 76 exist only under `web/legacy/` and appear nowhere in
`web/src` or the built bundle — `#file-explorer`, `#landing-page`,
`#upload-drop-zone`, `#relay-settings-modal`, `#theme-toggle` and 71 others. The
current app renders the `@cloistr/ui` AppShell: a header with an Apps menu and a
Sign In button, a `main` region, a footer. A page snapshot from a failing run is
in the error context of any test-results directory.

## Why no CI job

Adding one would turn every merge request red on day one, for a reason unrelated
to the change under review. That is the failure this whole sweep exists to
prevent, one layer up: an instrument that reports something other than the truth
about the code.

## What would change this

Rewriting the specs against the current UI. That is application work, not CI
work, and it is a real decision — 174 tests describing a deleted interface are
not a small rewrite. Once the suite passes against `master`, a job belongs here.

## Also cleaned up here

133 files under `test-results/` — screenshots, videos and traces of a *failing*
run — were tracked in Git. They are now ignored.

## Coverage that does exist

The gap is E2E only. `.gitlab-ci.yml` already gates the Go half (`test`, `lint`,
scoped to Go changes on merge requests, always on `master`) and the frontend
(`frontend`: conflict-marker scan, `npm run typecheck`, then `npm test`, which
runs `web/`'s six vitest files).
