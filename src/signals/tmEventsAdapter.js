// tm-events — third real adapter. Polls Ticketmaster's Discovery API (free
// key, 5000 calls/day, 5 rps) for events near the city center in the next
// 24 hours and normalizes them into `event` CitySignals.
//
// Contract §5: event intensity = expected attendance vs. area capacity,
// peaking at ingress/egress. Discovery gives no attendance, so the proxy is
// segment (sports venues spill wider than clubs) shaped by the time window:
// an event is a routing concern around showtime, not at 9am for a 7pm game.
// The shaping recomputes from ctx.now() on every pull — it is normalization,
// not decay (decay stays downstream).
//
// Feed quirks this adapter absorbs:
// - startDateTime/endDateTime params reject milliseconds — trim to seconds.
// - Venue coordinates arrive as strings; some events carry no venue geo.
// - The same event can repeat in a page; last write wins by id.

const FEED_URL = "https://app.ticketmaster.com/discovery/v2/events.json";

const SEGMENT_PROFILES = {
  sports: { radiusM: 1000, peak: 0.75 },
  music: { radiusM: 800, peak: 0.65 },
  "arts & theatre": { radiusM: 500, peak: 0.5 },
};
const DEFAULT_PROFILE = { radiusM: 500, peak: 0.5 };

const SKIP_STATUS = new Set(["cancelled", "postponed"]);

// Ingress (2h before) through egress (start + ~3h + 30min tail) is the hot
// window; a scheduled event outside it is visible but faint.
export function eventIntensity(startsAtIso, nowIso, peak) {
  const start = Date.parse(startsAtIso);
  const now = Date.parse(nowIso);
  const hoursFromStart = (now - start) / 3_600_000;

  if (hoursFromStart >= -2 && hoursFromStart <= 3.5) return peak;
  if (hoursFromStart < -2 && hoursFromStart >= -6) return Math.round(peak * 0.6 * 100) / 100;
  return 0.25; // rubric floor: noticeable, wouldn't change your route yet
}

function toSecondsIso(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function toSignal(event, sourceId, now) {
  const venue = event._embedded?.venues?.[0];
  const lng = Number(venue?.location?.longitude);
  const lat = Number(venue?.location?.latitude);
  const startsAt = event.dates?.start?.dateTime;
  if (!event.id || !startsAt || Number.isNaN(lng) || Number.isNaN(lat) || (!lng && !lat)) {
    return null;
  }
  if (SKIP_STATUS.has(event.dates?.status?.code)) return null;

  const segment = (event.classifications?.[0]?.segment?.name ?? "").toLowerCase();
  const profile = SEGMENT_PROFILES[segment] ?? DEFAULT_PROFILE;

  // No end time in the feed: assume ~3h show, expire 30min after (§5 TTL).
  const endsAt = new Date(Date.parse(startsAt) + 3 * 3_600_000);
  const expiresAt = new Date(endsAt.getTime() + 30 * 60_000);
  if (expiresAt.getTime() <= now.getTime()) return null;

  const name = event.name ?? "Scheduled event";
  return {
    id: `tm-events:${event.id}`,
    source: sourceId,
    sourceId: event.id,
    kind: "event",
    ...(segment ? { subkind: segment.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") } : {}),
    label: name.length <= 60 ? name : `${name.slice(0, 57)}…`,
    detail: venue.name
      ? `Crowds around ${venue.name} near showtime.`
      : "Scheduled gathering nearby.",
    geometry: { type: "point", coordinates: [lng, lat], radiusM: profile.radiusM },
    intensity: eventIntensity(startsAt, now.toISOString(), profile.peak),
    confidence: 0.8, // venue calendar (§5)
    observedAt: now.toISOString(),
    startsAt,
    endsAt: endsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(event.url ? { url: event.url } : {}),
  };
}

/**
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, latlong?: string,
 *           radiusMiles?: number, windowHours?: number }} options
 *   Defaults center on downtown Seattle; `fetchImpl` injectable for tests.
 */
export function createTmEventsAdapter({
  apiKey,
  fetchImpl = globalThis.fetch,
  latlong = "47.6062,-122.3321",
  radiusMiles = 15,
  windowHours = 24,
} = {}) {
  if (!apiKey) {
    throw new Error("tm-events requires an apiKey (free at developer.ticketmaster.com)");
  }

  return {
    id: "tm-events",
    name: "Ticketmaster events (next 24h)",
    kinds: ["event"],
    cadence: { mode: "poll", intervalSec: 3600 },

    async pull(ctx) {
      const now = ctx.now();
      const params = new URLSearchParams({
        apikey: apiKey,
        latlong,
        radius: String(radiusMiles),
        unit: "miles",
        startDateTime: toSecondsIso(now),
        endDateTime: toSecondsIso(new Date(now.getTime() + windowHours * 3_600_000)),
        size: "100",
        sort: "date,asc",
      });

      const response = await fetchImpl(`${FEED_URL}?${params}`);
      if (!response.ok) {
        throw new Error(`tm-events feed returned HTTP ${response.status}`);
      }

      const body = await response.json();
      const events = body._embedded?.events ?? []; // absent when zero results
      const byId = new Map();
      let dropped = 0;

      for (const event of events) {
        const signal = toSignal(event, this.id, now);
        signal ? byId.set(signal.sourceId, signal) : (dropped += 1);
      }

      if (dropped > 0) {
        ctx.log?.(`tm-events: dropped ${dropped} of ${events.length} events`);
      }

      return [...byId.values()];
    },
  };
}
