// wsdot-traffic — second real adapter. Polls two WSDOT Traveler API endpoints
// (free access code from https://wsdot.wa.gov/traffic/api/) and normalizes:
// - Highway Alerts → `closure` (construction/maintenance/closures) or
//   `traffic` (collisions, disabled vehicles, everything else that slows you)
// - Traffic Flow stations → `traffic` congestion signals; only Moderate and
//   worse emit — a wide-open sensor is not a signal.
//
// Feed quirks this adapter absorbs:
// - Timestamps arrive as .NET "/Date(1720223400000-0700)/" strings; the
//   milliseconds are the UTC epoch, the trailing offset is display-only.
// - FlowReadingValue is an enum serialized as an int (0 Unknown, 1 WideOpen,
//   2 Moderate, 3 Heavy, 4 StopAndGo, 5 NoData) — or occasionally its name.
// - Alerts may span a segment: when start and end locations differ we emit a
//   polyline, otherwise a point.

import { DEFAULT_TTL_MINUTES } from "./contract.js";

const ALERTS_URL =
  "https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson";
const FLOWS_URL =
  "https://wsdot.wa.gov/Traffic/api/TrafficFlow/TrafficFlowREST.svc/GetTrafficFlowsAsJson";

const CLOSURE_KEYWORDS = ["closure", "closed", "construction", "maintenance", "lane"];

// Contract §5: closure = capacity removed, traffic = deviation from baseline.
// WSDOT Priority is the closest severity proxy the feed offers.
const PRIORITY_INTENSITY = {
  highest: 0.9,
  high: 0.7,
  medium: 0.5,
  low: 0.3,
  lowest: 0.2,
};

const FLOW_READINGS = {
  2: { word: "Slow traffic", intensity: 0.4 },
  3: { word: "Heavy traffic", intensity: 0.7 },
  4: { word: "Stop-and-go", intensity: 0.9 },
  moderate: { word: "Slow traffic", intensity: 0.4 },
  heavy: { word: "Heavy traffic", intensity: 0.7 },
  stopandgo: { word: "Stop-and-go", intensity: 0.9 },
};

// "/Date(1720223400000-0700)/" → Date. The ms value is already UTC epoch.
export function parseDotNetDate(value) {
  const match = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value ?? "");
  return match ? new Date(Number(match[1])) : null;
}

function alertKind(category) {
  const lowered = (category ?? "").toLowerCase();
  return CLOSURE_KEYWORDS.some((keyword) => lowered.includes(keyword)) ? "closure" : "traffic";
}

// WSDOT road names arrive as bare route numbers ("005", "090", "520").
// Humanize per Washington convention: interstates → I-x, US routes → US x,
// everything else → SR x. Non-numeric names pass through untouched.
const INTERSTATES = new Set([5, 82, 90, 182, 205, 405, 705]);
const US_ROUTES = new Set([2, 12, 97, 101, 195, 197, 395, 730]);

export function formatRoadName(roadName) {
  const trimmed = (roadName ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;

  const number = Number(trimmed);
  if (INTERSTATES.has(number)) return `I-${number}`;
  if (US_ROUTES.has(number)) return `US ${number}`;
  return `SR ${number}`;
}

function toSubkind(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function clampLabel(label) {
  return label.length <= 60 ? label : `${label.slice(0, 57)}…`;
}

function firstSentence(text, max = 140) {
  if (!text) return undefined;
  const period = text.indexOf(". ");
  const sentence = period > 0 ? text.slice(0, period + 1) : text;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

function isFiniteCoord(location) {
  return (
    location &&
    Number.isFinite(location.Longitude) &&
    Number.isFinite(location.Latitude) &&
    (location.Longitude !== 0 || location.Latitude !== 0)
  );
}

function alertToSignal(alert, sourceId, now) {
  if (!alert?.AlertID || !isFiniteCoord(alert.StartRoadwayLocation)) return null;
  if ((alert.EventStatus ?? "").toLowerCase() === "closed") return null;

  const observed = parseDotNetDate(alert.LastUpdatedTime) ?? now;
  const startsAt = parseDotNetDate(alert.StartTime);
  const endsAt = parseDotNetDate(alert.EndTime);
  const kind = alertKind(alert.EventCategory);
  const intensity =
    PRIORITY_INTENSITY[(alert.Priority ?? "").toLowerCase()] ?? 0.4;

  const start = alert.StartRoadwayLocation;
  const end = alert.EndRoadwayLocation;
  const spansSegment =
    isFiniteCoord(end) &&
    (end.Longitude !== start.Longitude || end.Latitude !== start.Latitude);

  const geometry = spansSegment
    ? {
        type: "polyline",
        coordinates: [
          [start.Longitude, start.Latitude],
          [end.Longitude, end.Latitude],
        ],
      }
    : { type: "point", coordinates: [start.Longitude, start.Latitude], radiusM: 500 };

  const road = formatRoadName(start.RoadName);
  const roadName = road ? ` on ${road}` : "";
  const ttlMs = DEFAULT_TTL_MINUTES[kind] * 60_000;

  return {
    id: `wsdot-traffic:alert-${alert.AlertID}`,
    source: sourceId,
    sourceId: `alert-${alert.AlertID}`,
    kind,
    subkind: toSubkind(alert.EventCategory),
    label: clampLabel(`${alert.EventCategory ?? "Incident"}${roadName}`),
    detail: firstSentence(alert.HeadlineDescription),
    geometry,
    intensity,
    confidence: 0.9, // official DOT feed (§5)
    observedAt: observed.toISOString(),
    ...(startsAt ? { startsAt: startsAt.toISOString() } : {}),
    ...(endsAt ? { endsAt: endsAt.toISOString() } : {}),
    // The feed is the live snapshot; expiry is the backstop for failed pulls.
    expiresAt: (endsAt ?? new Date(now.getTime() + ttlMs)).toISOString(),
    raw: {
      category: alert.EventCategory,
      priority: alert.Priority,
      headline: alert.HeadlineDescription?.slice(0, 500),
    },
  };
}

function flowToSignal(flow, sourceId, now) {
  if (!flow?.FlowDataID || !isFiniteCoord(flow.FlowStationLocation)) return null;

  const readingKey =
    typeof flow.FlowReadingValue === "string"
      ? flow.FlowReadingValue.toLowerCase()
      : flow.FlowReadingValue;
  const reading = FLOW_READINGS[readingKey];
  if (!reading) return null; // Unknown / WideOpen / NoData — not a signal

  const observed = parseDotNetDate(flow.Time) ?? now;
  const expires = new Date(observed.getTime() + DEFAULT_TTL_MINUTES.traffic * 60_000);
  if (expires.getTime() <= now.getTime()) return null; // stale sensor

  const location = flow.FlowStationLocation;
  const where = [formatRoadName(location.RoadName), location.Direction]
    .filter(Boolean)
    .join(" ");

  return {
    id: `wsdot-traffic:flow-${flow.FlowDataID}`,
    source: sourceId,
    sourceId: `flow-${flow.FlowDataID}`,
    kind: "traffic",
    subkind: "congestion",
    label: clampLabel(where ? `${reading.word} on ${where}` : reading.word),
    detail: location.Description ? firstSentence(location.Description) : undefined,
    geometry: {
      type: "point",
      coordinates: [location.Longitude, location.Latitude],
      radiusM: 400,
    },
    intensity: reading.intensity,
    confidence: 0.9,
    observedAt: observed.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

/**
 * @param {{ accessCode: string, fetchImpl?: typeof fetch, includeFlow?: boolean }} options
 *   `accessCode` is the free WSDOT Traveler API key. `includeFlow: false`
 *   skips the flow-station endpoint (alerts only).
 */
export function createWsdotTrafficAdapter({
  accessCode,
  fetchImpl = globalThis.fetch,
  includeFlow = true,
} = {}) {
  if (!accessCode) {
    throw new Error("wsdot-traffic requires an accessCode (free at wsdot.wa.gov/traffic/api)");
  }

  async function fetchJson(url) {
    const response = await fetchImpl(`${url}?AccessCode=${encodeURIComponent(accessCode)}`);
    // Throw, don't return [] — a partial snapshot would retire live signals.
    if (!response.ok) {
      throw new Error(`wsdot-traffic feed returned HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    id: "wsdot-traffic",
    name: "WSDOT highway alerts + traffic flow",
    kinds: ["traffic", "closure"],
    cadence: { mode: "poll", intervalSec: 300 },

    async pull(ctx) {
      const now = ctx.now();
      const [alerts, flows] = await Promise.all([
        fetchJson(ALERTS_URL),
        includeFlow ? fetchJson(FLOWS_URL) : Promise.resolve([]),
      ]);

      const signals = [];
      let dropped = 0;

      for (const alert of alerts) {
        const signal = alertToSignal(alert, this.id, now);
        signal ? signals.push(signal) : (dropped += 1);
      }
      for (const flow of flows) {
        const signal = flowToSignal(flow, this.id, now);
        if (signal) signals.push(signal); // quiet sensors are expected, not drops
      }

      if (dropped > 0) {
        ctx.log?.(`wsdot-traffic: dropped ${dropped} of ${alerts.length} alerts`);
      }

      return signals;
    },
  };
}
