import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";
import { createTmEventsAdapter, eventIntensity } from "../src/signals/tmEventsAdapter.js";

const FIXED_NOW = new Date("2026-07-06T01:00:00Z");
const ctx = { now: () => FIXED_NOW, log: () => {} };

// Shape per the Discovery API v2 docs.
function tmEvent(overrides = {}) {
  const { dates, venue, ...rest } = overrides;
  return {
    id: "G5vYZbpBhplaS",
    name: "Mariners vs. Rangers",
    url: "https://www.ticketmaster.com/event/G5vYZbpBhplaS",
    dates: {
      start: { dateTime: "2026-07-06T02:10:00Z" }, // 7:10pm Pacific
      status: { code: "onsale" },
      ...dates,
    },
    classifications: [{ segment: { name: "Sports" } }],
    _embedded: {
      venues: [
        {
          name: "T-Mobile Park",
          location: { longitude: "-122.3325", latitude: "47.5914" },
          ...venue,
        },
      ],
    },
    ...rest,
  };
}

function adapterFor(events, { status = 200 } = {}) {
  let requestedUrl;
  const adapter = createTmEventsAdapter({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (events === null ? {} : { _embedded: { events } }),
      };
    },
  });
  return { adapter, url: () => requestedUrl };
}

describe("eventIntensity", () => {
  it("peaks through the ingress/egress window", () => {
    assert.equal(eventIntensity("2026-07-06T02:10:00Z", "2026-07-06T01:00:00Z", 0.75), 0.75); // 1h before
    assert.equal(eventIntensity("2026-07-06T02:10:00Z", "2026-07-06T05:00:00Z", 0.75), 0.75); // letting out
  });

  it("runs warm in the hours before, faint far out", () => {
    assert.equal(eventIntensity("2026-07-06T06:00:00Z", "2026-07-06T01:00:00Z", 0.75), 0.45); // 5h out
    assert.equal(eventIntensity("2026-07-06T20:00:00Z", "2026-07-06T01:00:00Z", 0.75), 0.25); // 19h out
  });
});

describe("tmEventsAdapter", () => {
  it("requires an api key", () => {
    assert.throws(() => createTmEventsAdapter({}), /apiKey/);
  });

  it("emits a fully valid event batch that projects into Seattle", async () => {
    const { adapter } = adapterFor([tmEvent()]);
    const signals = await adapter.pull(ctx);
    const { valid, rejected } = validateBatch(signals);

    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 1);
    const [signal] = valid;
    assert.equal(signal.kind, "event");
    assert.equal(signal.subkind, "sports");
    assert.equal(signal.confidence, 0.8);
    assert.equal(signal.intensity, 0.75); // game night, ingress window
    assert.equal(signal.geometry.radiusM, 1000);
    assert.ok(toHotspot(signal, SEATTLE_VIEWPORT));
  });

  it("requests a millisecond-free 24h window", async () => {
    const { adapter, url } = adapterFor([]);
    await adapter.pull(ctx);

    assert.match(url(), /startDateTime=2026-07-06T01%3A00%3A00Z/);
    assert.match(url(), /endDateTime=2026-07-07T01%3A00%3A00Z/);
    assert.ok(!url().includes(".000Z"));
  });

  it("stamps end + expiry from the assumed show length", async () => {
    const { adapter } = adapterFor([tmEvent()]);
    const [signal] = await adapter.pull(ctx);

    assert.equal(signal.endsAt, "2026-07-06T05:10:00.000Z");
    assert.equal(signal.expiresAt, "2026-07-06T05:40:00.000Z");
  });

  it("drops cancelled events, missing venues, and finished shows", async () => {
    const { adapter } = adapterFor([
      tmEvent(),
      tmEvent({ id: "b", dates: { status: { code: "cancelled" } } }),
      tmEvent({ id: "c", _embedded: { venues: [{ name: "No geo" }] } }),
      tmEvent({ id: "d", dates: { start: { dateTime: "2026-07-05T18:00:00Z" } } }),
    ]);
    const signals = await adapter.pull(ctx);

    assert.equal(signals.length, 1);
  });

  it("dedupes repeated event ids", async () => {
    const { adapter } = adapterFor([tmEvent(), tmEvent()]);
    assert.equal((await adapter.pull(ctx)).length, 1);
  });

  it("handles the zero-results shape (no _embedded)", async () => {
    const { adapter } = adapterFor(null);
    assert.deepEqual(await adapter.pull(ctx), []);
  });

  it("throws on HTTP failure instead of returning an empty snapshot", async () => {
    const { adapter } = adapterFor([], { status: 429 });
    await assert.rejects(adapter.pull(ctx), /HTTP 429/);
  });
});
