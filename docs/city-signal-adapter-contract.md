# City Signal Adapter Contract v0.1

Status: draft for review · Owner: City Intuition Lab · 2026-07-05

The prototype renders **hotspots**: `{ id, label, type, x, y, radius, intensity, detail }` on a
0–100 mock plane, scored against routes by `src/domain.js`. This document defines the contract
that real data sources normalize into so that traffic, closures, events, crowding, commotion,
public safety, 311/open data, and user reports all flow through one shape — the **CitySignal** —
and land on the map through one projection step.

Machine-readable companion: `src/signals/contract.js` (JSDoc typedefs + `validateSignal` +
`toHotspot`). Reference implementation: `src/signals/mockAdapter.js`.

## 1. Design rules

1. **Adapters normalize; they do not think.** An adapter's only job is to turn a source payload
   into valid CitySignals. Clustering, scoring, decay, H3 aggregation, and projection to the
   render plane are downstream concerns and must not be done in adapters.
2. **Real geography in, render plane out.** Signals carry WGS84 coordinates and meters.
   The mock 0–100 x/y plane is a *render* concern; `toHotspot(signal, viewport)` performs the
   projection. No adapter may emit x/y percentages.
3. **Everything expires.** `expiresAt` is required. A signal with no natural end gets the
   default TTL for its kind (§5). Nothing haunts the map.
4. **Idempotent by source identity.** `(source, sourceId)` is the upsert key. Re-pulling a feed
   updates signals in place; it never duplicates them.
5. **Invalid signals are dropped, not thrown.** A bad record in a 500-row feed must not kill the
   batch. Validators count and report rejects.
6. **`personal` is not a signal kind.** Avoid/prefer zones are client-side overlays owned by the
   user, merged at scoring time (`scoreRoute(route, hotspots, avoidZones)`). They never pass
   through an adapter.

## 2. Signal kinds

| kind        | covers                                              | example sources                          |
|-------------|-----------------------------------------------------|------------------------------------------|
| `traffic`   | congestion, slowdowns vs. baseline                  | DOT speed feeds, Waze/TomTom-style feeds |
| `closure`   | road/lane/sidewalk closures, planned or live        | 511 feeds, city permit calendars          |
| `event`     | scheduled gatherings: games, concerts, parades      | venue calendars, Ticketmaster-style APIs |
| `crowding`  | ambient density without a scheduled cause           | transit load, place-busyness feeds       |
| `commotion` | unplanned disturbance: protest, brawl, chaos        | scanner-derived feeds, social bursts     |
| `safety`    | public-safety incidents: police/fire/medical        | CAD/incident feeds, crime blotters       |
| `civic`     | 311 / open-data quality-of-life records             | 311 APIs, open-data portals              |
| `report`    | first-party user reports from inside the app        | our own report endpoint                  |

`commotion` vs `safety`: commotion is *unverified disorder* (fast, noisy, short-lived);
safety is *dispatched/confirmed incident* (slower, authoritative). They decay differently and
score differently, which is why the mock's single `safety` type splits in two.
`subkind` carries the source-specific refinement (`"lane_closure"`, `"parade"`, `"structure_fire"`)
without growing the canonical enum.

## 3. CitySignal shape

```js
{
  // identity
  id: "sea511:evt-88213",        // ALWAYS `${source}:${sourceId}`
  source: "sea511",              // adapter id (§4)
  sourceId: "evt-88213",         // stable within the source; upsert key with `source`
  kind: "closure",               // §2
  subkind: "lane_closure",       // optional, freeform, lowercase snake_case

  // presentation (human-readable, present tense, no jargon)
  label: "Midtown lane closure",         // ≤ 60 chars, map pin text
  detail: "A short closure is creating spillover on cross streets.", // optional, 1 sentence

  // geometry — WGS84 only
  geometry: {
    type: "point",               // "point" | "polyline" | "polygon"
    coordinates: [-122.335, 47.608],  // GeoJSON order: [lng, lat]; nested arrays for line/polygon
    radiusM: 350,                // required for point; influence radius in meters
  },

  // strength
  intensity: 0.55,               // 0..1, normalized per the rubric in §5
  confidence: 0.9,               // 0..1, how much the source is to be believed (§5)

  // time — ISO 8601 strings, UTC
  observedAt: "2026-07-05T22:14:00Z",  // when the source last saw this be true
  startsAt: "2026-07-05T21:00:00Z",    // optional, scheduled window start (closures/events)
  endsAt:   "2026-07-06T02:00:00Z",    // optional, scheduled window end
  expiresAt: "2026-07-06T02:30:00Z",   // REQUIRED — drop-dead time for the signal

  // provenance
  reportCount: 1,                // optional; >1 when the adapter aggregated multiple raw records
  url: "https://…",              // optional deep link to the source record
  raw: { … },                    // optional; original payload for debugging, never sent to clients
}
```

Field notes:

- **`label`/`detail`** feed straight into the render layer's `aria-label` and pin text — write
  them like the mock data reads: short, present tense, human ("Stadium letting out", not
  "EVENT_EGRESS_ACTIVE").
- **`geometry`**: points cover most kinds; closures may be polylines (the closed segment);
  events/crowding may be polygons (venue footprint). Downstream computes an effective center +
  radius for scoring until `domain.js` learns segment-aware impact.
- **`raw`** is capped at 8 KB by the validator; adapters that need more should store a URL.

## 4. Adapter interface

```js
{
  id: "sea511",                  // lowercase, stable, becomes `source` on every signal
  name: "Seattle 511 closures",
  kinds: ["closure", "traffic"],  // every kind this adapter may emit
  cadence: { mode: "poll", intervalSec: 300 },  // "poll" | "push" | "batch"

  // poll/batch mode: return the FULL current snapshot for this source.
  // Ingestion diffs against the previous snapshot; signals absent from the
  // snapshot and past expiresAt are retired.
  async pull(ctx) { return [/* CitySignal[] */]; },

  // push mode instead of pull: adapter calls ctx.emit(signals) as data arrives.
  // start/stop own the connection lifecycle.
  async start(ctx) {},
  async stop() {},
}
```

`ctx` provides `{ now(), emit(signals), log(msg), state }` — `state` is a small persisted
KV scratchpad (cursors, etags). Adapters must be stateless beyond it.

**What adapters must do:** map raw fields to the CitySignal shape, normalize intensity per §5,
set honest `confidence`, dedupe within their own snapshot, keep `sourceId` stable across pulls.

**What adapters must not do:** cluster across sources, apply freshness decay, compute H3 cells,
project to x/y, filter by viewport, or invent signals a human at the source couldn't point to.

## 5. Normalization rubrics

**Intensity anchors** (same meaning across all kinds — this is the whole point):

| intensity | means for a person routing through it     |
|-----------|--------------------------------------------|
| 0.25      | noticeable; wouldn't change your route      |
| 0.50      | plan around it if it's on your way          |
| 0.75      | avoid unless you have a reason to be there  |
| 1.00      | hard blocker / do not route through         |

Per-kind guidance: traffic = deviation below time-of-day baseline (−20% ≈ 0.3, −60% ≈ 0.9);
closure = fraction of capacity removed (single lane ≈ 0.4, full street ≈ 0.9); event = expected
attendance vs. area capacity, peaking at ingress/egress windows; crowding = density percentile
vs. usual; commotion starts at 0.5 by definition (if it isn't plan-around, it isn't commotion);
safety = dispatch severity tier; civic caps at 0.5 (quality-of-life, rarely routing-relevant);
report = 0.5 base, scaled up by corroboration (`reportCount`).

**Confidence defaults**: official/sensor feeds 0.9; venue calendars 0.8; scanner/social-derived
0.5; single user report 0.4, +0.15 per corroborating report, cap 0.9. Effective weight downstream
is `intensity × confidence × freshness` — adapters set the first two, never the third.

**Default TTLs** (when the source gives no `endsAt`): traffic 15 min, crowding 30 min,
commotion 45 min, safety 2 h, event `endsAt + 30 min`, closure `endsAt` (or 24 h if unbounded),
civic 7 days, report 60 min.

## 6. Mapping to the current prototype

`toHotspot(signal, viewport)` in `src/signals/contract.js` bridges to today's renderer:

- `viewport` is a WGS84 bbox `{ west, south, east, north }`; lng/lat project linearly to x/y 0–100.
- `radiusM` converts to plane units via the viewport's width in meters.
- `kind` maps to the existing CSS classes: `traffic`, `event`, `closure` pass through;
  `commotion` and `safety` both render as `safety` for now; `civic` and `report` render as
  `crowding`-muted styling until the stylesheet grows classes for them.
- `TYPE_WEIGHTS` in `domain.js` extends when kinds land for real; proposed:
  `commotion: 1.15`, `civic: 0.7`, `report: 0.85` (tunable, keep in one place).
- Non-point geometry: `toHotspot` uses the centroid + a radius that circumscribes the shape —
  lossy but honest until `domain.js` scores segments directly.

## 7. Open questions (deliberately not decided here)

1. **H3 aggregation layer** — ingestion will likely index signals by H3 cell, but resolution
   choice belongs to the clustering design, not the adapter contract.
2. ~~Standalone app vs module~~ — resolved: SIA is a standalone app. The contract stays
   placement-neutral regardless.
3. ~~First target city~~ — resolved: Seattle.
