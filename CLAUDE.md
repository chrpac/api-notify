# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this service is

`api-notify` (package name `api-screenshot`) is a single-purpose Express microservice with one job: given a URL, launch headless Chrome via Puppeteer, render the page, and return a PNG screenshot. It is part of a larger multi-service system (sibling services observed at runtime: `api-core`, `api-web`, `socketio`, `web`, `redis`) running in the same Kubernetes namespace and called internally over ClusterIP — this repo only contains the `api-notify` service itself.

There is no test suite, no linter, and no build step configured in this repo.

## Commands

- Install deps: `npm install`
- Run locally: `node index.js` (listens on `PORT` env var, defaults to `3333`)
- Build container image: `docker build -t gcr.io/jawis-core/api-notify:<tag> .`
- Deploy to the cluster: `kubectl apply -f k8s/` (applies Deployment, Service, and HPA to namespace `default` on the `jawis-gke` GKE cluster, project `jawis-core`)

`npm test` is a stub (`echo "Error: no test specified" && exit 1`) — there are no real tests to run.

## Architecture

Everything lives in `index.js` — a single Express app with two effective endpoints:

- `POST /screenshot` — the only real endpoint. Accepts `{ url, width, height, waitUntil, fullPage }` in the JSON body, calls `getScreenShot()`, and streams the resulting PNG buffer back as the response body.
- `GET /version`, `GET /` — trivial health/version endpoints.

`getScreenShot()` is the entire core of the service: `puppeteer.launch()` → `browser.newPage()` → `page.goto(url)` → `page.screenshot()` → `browser.close()`. **A new Chrome browser process is launched per request** — there is no browser reuse, no connection pooling, and no concurrency limiting. `puppeteer-cluster` is listed in `package.json` dependencies but is never imported or used anywhere in the code, so its pooling/queueing capability is currently dead weight.

`browser.close()` is called inline, not in a `finally` block — if `page.goto()` or `page.screenshot()` throws (bad URL, navigation timeout, etc.), the browser process is never closed and leaks for the lifetime of the pod.

These two facts together are the root cause of a known, currently-active production issue: pods get OOMKilled repeatedly because concurrent/failed requests accumulate multiple full Chrome processes in memory at once, with no ceiling. Any change to concurrency handling in this file should close that gap (bound concurrent browsers, guarantee cleanup on error) rather than just raising memory limits.

## Runtime environment

- Base image target: Node 12 + Debian (matches the currently deployed image, which is Debian 9 "stretch" — both are EOL; be aware of this if asked to change the base image).
- Puppeteer downloads and manages its own bundled Chromium under `node_modules/puppeteer/.local-chromium` — the Dockerfile only needs to provide the OS-level shared libraries Chromium needs to run (see the `apt-get install` list), not a separately installed Chrome/Chromium binary.
- Runs as non-root user `pptruser` (uid/gid 999), matching what Puppeteer's own documentation/tooling expects for sandboxed Chrome.
- Deployed with `NODE_OPTIONS=--max_old_space_size=2048` — this only caps the Node.js V8 heap, not the memory used by the separate Chrome OS processes Puppeteer spawns, so it does not protect against the browser-leak/unbounded-concurrency issue above.
- In-cluster identity: Deployment `api-notify-deploy`, Service `api-notify-service` (ClusterIP, port 80 → container port 3333), HPA scales 1–3 replicas on 80% CPU / 75% memory utilization targets.
