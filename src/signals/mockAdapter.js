// Reference adapter proving the CitySignal contract. Emits the same four
// hotspots the prototype ships with, but shaped the way a real feed adapter
// would emit them: WGS84 geometry, kinds, confidence, timestamps.
// Viewport below is downtown Seattle purely for flavor (first target city TBD).

import { DEFAULT_TTL_MINUTES } from "./contract.js";

export const MOCK_VIEWPORT = {
  west: -122.42,
  south: 47.56,
  east: -122.24,
  north: 47.66,
};

const SOURCE_RECORDS = [
  {
    sourceId: "downtown-gridlock",
    kind: "traffic",
    label: "Downtown gridlock",
    detail: "Speeds are well below the usual evening baseline.",
    lng: -122.326,
    lat: 47.606,
    radiusM: 1600,
    intensity: 0.95,
    confidence: 0.9,
  },
  {
    sourceId: "stadium-letting-out",
    kind: "event",
    subkind: "stadium_egress",
    label: "Stadium letting out",
    detail: "Crowds are spilling into nearby arterials.",
    lng: -122.29,
    lat: 47.626,
    radiusM: 1200,
    intensity: 0.72,
    confidence: 0.8,
  },
  {
    sourceId: "midtown-closure",
    kind: "closure",
    subkind: "lane_closure",
    label: "Midtown lane closure",
    detail: "A short closure is creating spillover on cross streets.",
    lng: -122.344,
    lat: 47.618,
    radiusM: 900,
    intensity: 0.55,
    confidence: 0.9,
  },
  {
    sourceId: "southside-commotion",
    kind: "commotion",
    label: "Southside commotion",
    detail: "Clustered incident reports make this area less predictable.",
    lng: -122.357,
    lat: 47.584,
    radiusM: 1300,
    intensity: 0.62,
    confidence: 0.5,
  },
];

export const mockAdapter = {
  id: "mock",
  name: "Prototype mock signals",
  kinds: ["traffic", "event", "closure", "commotion"],
  cadence: { mode: "poll", intervalSec: 60 },

  async pull(ctx) {
    const now = ctx.now();

    return SOURCE_RECORDS.map((record) => ({
      id: `${this.id}:${record.sourceId}`,
      source: this.id,
      sourceId: record.sourceId,
      kind: record.kind,
      ...(record.subkind ? { subkind: record.subkind } : {}),
      label: record.label,
      detail: record.detail,
      geometry: {
        type: "point",
        coordinates: [record.lng, record.lat],
        radiusM: record.radiusM,
      },
      intensity: record.intensity,
      confidence: record.confidence,
      observedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + DEFAULT_TTL_MINUTES[record.kind] * 60_000,
      ).toISOString(),
    }));
  },
};
