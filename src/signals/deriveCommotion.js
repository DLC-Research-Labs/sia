// Derived commotion — burst detection over live safety dispatches. When ≥N
// distinct dispatches land within a small area inside a short window, that's
// no longer N separate incidents: it reads as one unpredictable pocket of the
// city. This lives downstream of adapters on purpose (contract §1: adapters
// normalize, never think) — it consumes validated CitySignals from any safety
// source and emits contract-valid `commotion` signals.
//
// The derived signal deliberately coexists with its member signals: a burst
// area carries both the individual dispatch pressure and the commotion
// pressure, because a cluster is genuinely worse than the sum of its pins.

import { DEFAULT_TTL_MINUTES } from "./contract.js";

export const BURST_MIN_COUNT = 3;
export const BURST_RADIUS_M = 500;
export const BURST_WINDOW_MINUTES = 30;

const SOURCE_ID = "derived-commotion";
const COMMOTION_TTL_MS = DEFAULT_TTL_MINUTES.commotion * 60_000;

// Equirectangular approximation — fine at city scale.
function metersBetween(a, b) {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * 111_320 * Math.cos(midLat);
  const dy = (a[1] - b[1]) * 111_320;
  return Math.hypot(dx, dy);
}

// Union-find over pairwise proximity: members chain, so a burst spread along
// a street still clusters even when its endpoints exceed BURST_RADIUS_M.
function clusterByProximity(signals) {
  const parent = signals.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let i = 0; i < signals.length; i += 1) {
    for (let j = i + 1; j < signals.length; j += 1) {
      const close =
        metersBetween(signals[i].geometry.coordinates, signals[j].geometry.coordinates) <=
        BURST_RADIUS_M;
      if (close) parent[find(i)] = find(j);
    }
  }

  const clusters = new Map();
  signals.forEach((signal, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(signal);
  });

  return [...clusters.values()];
}

function toCommotionSignal(members) {
  // Anchor on the earliest member so the burst keeps one identity across
  // recomputes as new calls join. When the anchor ages out of the window the
  // id rolls over — acceptable, the burst is decaying by then anyway.
  const ordered = [...members].sort(
    (a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
  );
  const anchor = ordered[0];
  const latest = ordered[ordered.length - 1];

  const centroid = members
    .reduce(
      ([lng, lat], m) => [lng + m.geometry.coordinates[0], lat + m.geometry.coordinates[1]],
      [0, 0],
    )
    .map((sum) => sum / members.length);

  const spreadM = members.reduce(
    (max, m) => Math.max(max, metersBetween(centroid, m.geometry.coordinates)),
    0,
  );

  const count = members.length;
  const maxMemberIntensity = Math.max(...members.map((m) => m.intensity));
  // Rubric: a minimum burst reads 0.5, each extra call adds pressure, a
  // severe member (structure fire tier) bumps it — capped below "confirmed
  // dangerous" territory since this is inference, not a report.
  const intensity = Math.min(
    0.9,
    0.5 + 0.08 * (count - BURST_MIN_COUNT) + (maxMemberIntensity >= 0.8 ? 0.1 : 0),
  );

  const observedAt = latest.observedAt;

  return {
    id: `${SOURCE_ID}:${anchor.id}`,
    source: SOURCE_ID,
    sourceId: anchor.id,
    kind: "commotion",
    subkind: "dispatch_burst",
    label: `Dispatch burst — ${count} calls in ${BURST_WINDOW_MINUTES} min`,
    detail: `${count} emergency dispatches within a few blocks of each other in the last ${BURST_WINDOW_MINUTES} minutes — expect commotion here.`,
    geometry: {
      type: "point",
      coordinates: centroid,
      // The burst's influence covers its footprint plus a buffer; floor keeps
      // a same-address pileup from collapsing to a dot.
      radiusM: Math.max(300, Math.round(spreadM + 150)),
    },
    intensity,
    confidence: 0.7, // official feed underneath, but the clustering is inference
    observedAt,
    expiresAt: new Date(new Date(observedAt).getTime() + COMMOTION_TTL_MS).toISOString(),
    raw: { count, memberIds: members.map((m) => m.id).slice(0, 20) },
  };
}

/**
 * Derive commotion signals from a batch of live CitySignals. Pure: same
 * input, same output — the ingestion store re-runs it on every update.
 *
 * @param {Array} signals validated live CitySignals (any source, any kind)
 * @param {{ now?: () => Date }} [ctx]
 * @returns {Array} contract-valid `commotion` CitySignals (possibly empty)
 */
export function deriveCommotion(signals, { now = () => new Date() } = {}) {
  const cutoff = now().getTime() - BURST_WINDOW_MINUTES * 60_000;

  const recent = signals.filter(
    (signal) =>
      signal.kind === "safety" &&
      signal.geometry?.type === "point" &&
      new Date(signal.observedAt).getTime() >= cutoff,
  );

  return clusterByProximity(recent)
    .filter((members) => members.length >= BURST_MIN_COUNT)
    .map(toCommotionSignal);
}
