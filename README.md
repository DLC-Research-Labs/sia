# SIA

> **SIA** — sounds like "see ya." Formerly *City Intuition / City Signal*.

Bird's-eye city awareness for people who already know their city. Live map heat — safety
dispatches, closures, traffic, event crowds — plus personal avoid zones and corridor-level
route reads in plain sentences. Deliberately **not** turn-by-turn navigation: you glance at
the city, then drive it your own way. If a feature asks you to operate it, it's wrong here
(see `docs/ethos.md`).

**Live demo:** [dlc-research-labs.github.io/sia](https://dlc-research-labs.github.io/sia/)
(GitHub Pages, straight from this repo) · also exported to
[dalovecompany.com/demos/city-signal](https://dalovecompany.com/demos/city-signal) for the
DLC LABS site — see `scripts/export-demo.mjs`.

## What's live vs mock

Seattle is the first city. Honest inventory:

| Signal | Source | Status |
| --- | --- | --- |
| safety | `sea-fire911` — Seattle Fire 911 CAD (Socrata `kzjm-xkqj`) | **live** |
| traffic, closure | `wsdot-traffic` — WSDOT highway alerts + flow stations | **live** (needs a free access code) |
| event | `tm-events` — Ticketmaster Discovery | code-complete + tested, **waiting on an API key**; event heat is mock until then |
| crowding | derived from event windows | mock |
| commotion | planned: burst-detection over the 911 feed (many dispatches, same area, short window) | future |
| civic (311), report | contract kinds only, no adapter yet | future |

Personal avoid zones are never a feed — they live in `localStorage` and stay on your machine.

On the mock-plane page, mock hotspots stand in only for signal types no connected adapter
covers; once a real feed connects, its types retire their mocks even when the feed reports
nothing (a quiet feed is information, not an excuse to show fake gridlock). The real-map
page renders live signals only.

## Two pages

- `index.html` — the front door: MapLibre GL over a real Seattle basemap (vendored in
  `vendor/`, keyless OpenFreeMap tiles). Signals render straight from WGS84; three real
  corridors (Aurora/SR-99, I-5, eastern surface streets). The 0–100 plane survives
  underneath purely as a scoring space. Live signals only — no mock stand-ins.
- `plane.html` — the original prototype: stylized SVG city on a 0–100 coordinate plane,
  three abstract corridors, mock stand-ins as described above. Kept as the scoring-space
  visualizer.

## How it works

- **Adapter contract v0.1** (`docs/city-signal-adapter-contract.md`, `src/signals/contract.js`):
  every source normalizes into `CitySignal`s — one of 8 kinds (traffic, closure, event,
  crowding, commotion, safety, civic, report) with geometry, intensity, confidence, and an
  expiry. Adapters declare which kinds they cover.
- **Ingestion store** (`src/signals/liveSignals.js`): polls adapters on their declared
  cadence, validates each batch, prunes expired signals, projects survivors onto the render
  plane. A failed pull keeps the previous snapshot — stale beats blank — and expiry still
  ages it out. Per-feed health drives the status pill: green when every feed is live, amber
  when some are, red only when nothing is (hover the pill for the per-feed breakdown).
- **Scoring** (`src/domain.js`): corridors score 0–100 against signals and personal zones —
  line signals by nearest approach to their projected path, point signals by
  anisotropy-aware distance. Guidance is deterministic sentences built from the scores.
  No LLM anywhere.
- **Companion**: a single "Where are we going?" question with corridor chips. Answering
  focuses the route read (and names the calmer alternative when your pick runs hot);
  dismissing it is one tap and it stays gone for the session.

No build step, no dependencies. MapLibre is vendored; everything else is hand-rolled ES
modules.

## Run it

```bash
npm start   # python http.server on http://localhost:5173
npm test    # node:test — 92 tests
```

Optional keys (both free): set them in `demo-config.js`, or once in the browser:

```js
localStorage.setItem("wsdot-access-code", "…"); // wsdot.wa.gov/traffic/api
localStorage.setItem("tm-api-key", "…");        // developer.ticketmaster.com
```

Without them those adapters simply don't register and the Sources panel says so. WSDOT
sends no CORS headers, so the browser transport is JSONP (`src/signals/jsonpFetch.js`);
node scripts use plain fetch.

Useful scripts: `scripts/pull-sea-fire911.mjs`, `pull-wsdot.mjs`, `pull-tm.mjs` (feed smoke
tests), `scripts/validate-read.mjs` (re-runnable live scoring read, see
`docs/validation-2026-07.md`), `scripts/export-demo.mjs` (builds the public demo bundle).

## Project state

`HANDOFF.md` is the single source of truth for current state, open work, and deploy rules.
