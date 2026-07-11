// sea-fire911 — first real adapter. Polls Seattle Fire Department's real-time
// 911 dispatch feed (Socrata dataset kzjm-xkqj, ~5 min lag, no API key needed)
// and normalizes dispatches into `safety` CitySignals per the contract.
//
// Feed quirks this adapter absorbs:
// - `datetime` is a floating timestamp in Pacific local time (no offset);
//   pacificToUtc() resolves it against America/Los_Angeles including DST.
// - `latitude`/`longitude` arrive as strings and are sometimes absent.
// - The same `incident_number` can appear more than once as a call updates;
//   the newest row wins (dedupe within snapshot, contract §4).

import { DEFAULT_TTL_MINUTES } from "./contract.js";

export const SEATTLE_VIEWPORT = {
  west: -122.46,
  south: 47.48,
  east: -122.22,
  north: 47.74,
};

const FEED_URL = "https://data.seattle.gov/resource/kzjm-xkqj.json";
const SAFETY_TTL_MS = DEFAULT_TTL_MINUTES.safety * 60_000;

// Contract §5: safety intensity = dispatch severity tier. Keyword tiers over
// SFD dispatch types, checked in order; first match wins, default is minor.
const SEVERITY_TIERS = [
  {
    keywords: [
      "fire in",
      "structure",
      "explosion",
      "hazmat",
      "hazardous",
      "multiple casualty",
      "mci",
      "rescue heavy",
      "water rescue",
    ],
    intensity: 0.8,
    radiusM: 600,
  },
  {
    keywords: [
      "fire",
      "mvi",
      "motor vehicle",
      "rescue",
      "violence",
      "shoot",
      "stab",
      "assault",
    ],
    intensity: 0.55,
    radiusM: 350,
  },
];
const MINOR_TIER = { intensity: 0.3, radiusM: 150 };

function severityTier(type) {
  const lowered = type.toLowerCase();
  for (const tier of SEVERITY_TIERS) {
    if (tier.keywords.some((keyword) => lowered.includes(keyword))) {
      return tier;
    }
  }
  return MINOR_TIER;
}

// "SYLVAN WAY SW / SW MORGAN ST" → "Sylvan Way Sw / Sw Morgan St" — good
// enough for a map pin; the feed mixes shouting and mixed case freely.
function titleCase(text) {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function buildLabel(type, address) {
  const withAddress = `${type} near ${titleCase(address ?? "")}`.trim();
  return withAddress.length <= 60 || !address ? withAddress : type.slice(0, 60);
}

function toSubkind(type) {
  return type
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// Resolve a floating "YYYY-MM-DDTHH:mm:ss[.sss]" Pacific wall-clock timestamp
// to a real UTC Date, honoring DST for that date. Returns null on garbage.
export function pacificToUtc(floating) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(
    floating ?? "",
  );
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match.map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);

  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date(wallAsUtc))
    .find((part) => part.type === "timeZoneName").value; // e.g. "GMT-7"

  const offsetMatch = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetName);
  if (!offsetMatch) return null;

  const offsetMs =
    Number(offsetMatch[1]) * 3_600_000 +
    Math.sign(Number(offsetMatch[1])) * Number(offsetMatch[2] ?? 0) * 60_000;

  return new Date(wallAsUtc - offsetMs);
}

function toSignal(record, sourceId) {
  const lng = Number(record.longitude);
  const lat = Number(record.latitude);
  if (!record.type || Number.isNaN(lng) || Number.isNaN(lat) || (!lng && !lat)) {
    return null;
  }

  const observed = pacificToUtc(record.datetime);
  if (!observed) return null;

  const tier = severityTier(record.type);

  return {
    id: `sea-fire911:${record.incident_number}`,
    source: sourceId,
    sourceId: record.incident_number,
    kind: "safety",
    subkind: toSubkind(record.type),
    label: buildLabel(record.type, record.address),
    detail: "Seattle Fire has an active dispatch here.",
    geometry: { type: "point", coordinates: [lng, lat], radiusM: tier.radiusM },
    intensity: tier.intensity,
    confidence: 0.9, // official CAD feed (§5)
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + SAFETY_TTL_MS).toISOString(),
    raw: {
      address: record.address,
      type: record.type,
      datetime: record.datetime,
    },
  };
}

/**
 * @param {{ fetchImpl?: typeof fetch, limit?: number, appToken?: string }} [options]
 *   `fetchImpl` is injectable for tests; `appToken` is an optional Socrata app
 *   token that raises rate limits (anonymous access works fine at our cadence).
 */
export function createSeaFire911Adapter({
  fetchImpl = globalThis.fetch,
  limit = 250,
  appToken,
} = {}) {
  return {
    id: "sea-fire911",
    name: "Seattle Fire real-time 911 dispatches",
    kinds: ["safety"],
    cadence: { mode: "poll", intervalSec: 300 },

    async pull(ctx) {
      const url = `${FEED_URL}?$order=datetime%20DESC&$limit=${limit}`;
      const response = await fetchImpl(url, {
        headers: appToken ? { "X-App-Token": appToken } : {},
      });

      // A failed pull must throw, not return [] — an empty snapshot would
      // retire every live signal under the contract's diffing semantics.
      if (!response.ok) {
        throw new Error(`sea-fire911 feed returned HTTP ${response.status}`);
      }

      const records = await response.json();
      const now = ctx.now().getTime();
      const bySourceId = new Map();
      let dropped = 0;

      for (const record of records) {
        if (!record?.incident_number) {
          dropped += 1;
          continue;
        }

        const signal = toSignal(record, this.id);
        if (!signal || new Date(signal.expiresAt).getTime() <= now) {
          dropped += 1;
          continue;
        }

        const existing = bySourceId.get(signal.sourceId);
        if (!existing || signal.observedAt > existing.observedAt) {
          bySourceId.set(signal.sourceId, signal);
        }
      }

      if (dropped > 0) {
        ctx.log?.(`sea-fire911: dropped ${dropped} of ${records.length} records`);
      }

      return [...bySourceId.values()];
    },
  };
}

export const seaFire911Adapter = createSeaFire911Adapter();
