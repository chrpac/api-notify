# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this service is

`api-notify` (package name `api-screenshot`) is a single-purpose Express microservice with one job: given a URL, launch headless Chrome via Puppeteer, render the page, and return a PNG screenshot. It is part of a larger multi-service system (sibling services observed at runtime: `api-core`, `api-web`, `socketio`, `web`, `redis`) running in the same Kubernetes namespace and called internally over ClusterIP — this repo only contains the `api-notify` service itself.

There is no test suite, no linter, and no build step configured in this repo.

## Commands

- Install deps: `npm install`
- Run locally: `node index.js` (listens on `PORT` env var, defaults to `3333`)
- Build container image: `docker build --platform=linux/amd64 -t gcr.io/jawis-core/api-notify:<tag> .` (the platform flag is required — see Runtime environment)
- Deploy to the cluster: Kubernetes manifests are **not** in this repo. They live in the sibling `deploy-jawis` repo under `api-notify/` (Deployment, Service, HPA, and an nginx Ingress), applied to namespace `default` on the `jawis-gke` GKE cluster, project `jawis-core`. The local kubectl default context may point at a different cluster, so pass `--context=gke_jawis-core_asia-southeast1-a_jawis-gke` explicitly.

`npm test` is a stub (`echo "Error: no test specified" && exit 1`) — there are no real tests to run.

## Architecture

Everything lives in `index.js` — a single Express app with two effective endpoints:

- `POST /screenshot` — the only real endpoint. Accepts `{ url, width, height, waitUntil, fullPage }` in the JSON body, calls `getScreenShot()`, and streams the resulting PNG buffer back as the response body.
- `GET /version`, `GET /` — trivial health/version endpoints.

`getScreenShot()` is the entire core of the service. **One Chrome process is shared by the whole Node process**, launched lazily on the first request and relaunched automatically if it disconnects; each request only gets its own `page`. Requests pass through a small in-process semaphore (`MAX_CONCURRENCY`, default 2) so only that many pages render at once — the rest queue. The page is closed in a `finally` block, so a bad URL or navigation timeout can no longer leak anything.

This is what fixed the long-standing OOMKill problem, where the old one-browser-per-request code plus an inline (non-`finally`) `browser.close()` let failed and concurrent requests pile up unbounded Chrome processes. Keep both properties — a bounded number of concurrent pages, and cleanup guaranteed on the error path — when touching this file. `puppeteer-cluster` was removed; it had never been imported.

Timeouts are all bounded and env-tunable: `NAVIGATION_TIMEOUT` (default 30s, also the page's default timeout) and `PROTOCOL_TIMEOUT` (default 60s — Puppeteer's own default is 180s, long enough for one wedged CDP call to sit on a concurrency slot for minutes). `page.close()` is additionally raced against a 5s cap, since closing a wedged page can itself hang.

`SIGTERM`/`SIGINT` stop the server and close the browser before exit, matching the Deployment's `terminationGracePeriodSeconds: 30`.

Setting **`MOCKUP=1`** makes `/screenshot` return a generated placeholder PNG at exactly the requested `width` x `height` and never launch Chrome — useful for developing callers or load-testing without the cost of real captures. Request validation is unchanged, so a bad `url` still gives the same 400; only the capture is skipped. Two consequences worth knowing: `fullPage` is ignored (there is no page to measure, so the result is always exactly `width` x `height`, whereas a real `fullPage` capture is usually much taller), and unreachable URLs return 200 instead of 500. The placeholder is encoded by hand in `buildMockup()` using `node:zlib` — deliberately no image library, since this is the only feature that would need one.

## Runtime environment

- ESM (`"type": "module"` in `package.json`) — use `import`, not `require`. Node >= 22.12 is required, enforced via `engines`; Puppeteer 25 will not run on anything older.
- Base image: `node:22-bookworm-slim`.
- **The image must be built for `linux/amd64`** (`docker build --platform=linux/amd64 ...`). Chrome for Testing publishes no linux-arm64 build, so on an Apple Silicon machine Puppeteer silently downloads an x86-64 binary into an `linux_arm-*` directory and Chrome fails at launch with a `rosetta error`. GKE nodes are amd64 anyway.
- Puppeteer downloads and manages its own Chrome build. Since Puppeteer 19 that lives in a cache dir, **not** `node_modules/.local-chromium`; the Dockerfile pins it to `/app/.cache/puppeteer` via `PUPPETEER_CACHE_DIR` so it survives the `chown` to `pptruser`. The `apt-get install` list only supplies OS-level shared libraries — plus `unzip`, which modern Puppeteer requires to extract that download, and `dumb-init`, used as the entrypoint to reap Chrome's child processes.
- Runs as non-root user `pptruser` at **uid/gid 1001**, not the 999 used under Debian 9 — on bookworm, `apt-get install` hands 999 to a Debian system group (Debian allocates system ids downward from 999) before the `useradd` runs, so pinning 999 fails the build.
- `npm ci` needs `package-lock.json` committed. Regenerate it without downloading Chrome using `npm install --package-lock-only --ignore-scripts`.
- Deployed with `NODE_OPTIONS=--max_old_space_size=2048` — this only caps the Node.js V8 heap, not the memory used by the separate Chrome OS processes Puppeteer spawns. `MAX_CONCURRENCY` is what actually bounds Chrome's memory; tune that, not the heap flag.
- In-cluster identity: Deployment `api-notify-deploy`, Service `api-notify-service` (ClusterIP, port 80 → container port 3333), HPA scales 1–3 replicas on 80% CPU / 75% memory utilization targets.
