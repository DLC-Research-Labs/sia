import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";
import {
  createWsdotTrafficAdapter,
  parseDotNetDate,
} from "../src/signals/wsdotTrafficAdapter.js";

const FIXED_NOW = new Date("2026-07-05T21:30:00Z");
const ctx = { now: () => FIXED_NOW, log: () => {} };

// Shapes copied from the REST help pages' example responses.
function alertRecord(overrides = {}) {
  return {
    AlertID: 468632,
    EventCategory: "Collision",
    Priority: "High",
    HeadlineDescription:
      "A collision is blocking the right lane. Expect delays through the evening commute.",
    StartRoadwayLocation: {
      Description: "I-5 at Mercer St",
      Direction: "NB",
      Latitude: 47.624,
      Longitude: -122.33,
      MilePost: 167,
      RoadName: "I-5",
    },
    EndRoadwayLocation: null,
    LastUpdatedTime: "/Date(1783287000000-0700)/", // 2026-07-05T21:30:00Z
    StartTime: "/Date(1783283400000-0700)/",
    EndTime: null,
    EventStatus: "Open",
    ...overrides,
  };
}

function flowRecord(overrides = {}) {
  return {
    FlowDataID: 2482,
    FlowReadingValue: 3,
    FlowStationLocation: {
      Description: "Homewood",
      Direction: "SB",
      Latitude: 47.597,
      Longitude: -122.32,
      MilePost: 165.3,
      RoadName: "005",
    },
    Region: "Northwest",
    StationName: "005es16530",
    Time: "/Date(1783287000000-0700)/",
    ...overrides,
  };
}

function adapterFor({ alerts = [], flows = [], statuses = {} } = {}) {
  return createWsdotTrafficAdapter({
    accessCode: "test-code",
    fetchImpl: async (url) => {
      const isFlow = url.includes("TrafficFlow");
      const status = statuses[isFlow ? "flows" : "alerts"] ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (isFlow ? flows : alerts),
      };
    },
  });
}

describe("parseDotNetDate", () => {
  it("extracts the UTC epoch and ignores the display offset", () => {
    assert.equal(
      parseDotNetDate("/Date(1783287000000-0700)/").toISOString(),
      "2026-07-05T21:30:00.000Z",
    );
    assert.equal(
      parseDotNetDate("/Date(1783287000000)/").toISOString(),
      "2026-07-05T21:30:00.000Z",
    );
  });

  it("returns null on garbage", () => {
    assert.equal(parseDotNetDate("2026-07-05"), null);
    assert.equal(parseDotNetDate(null), null);
  });
});

describe("wsdotTrafficAdapter", () => {
  it("requires an access code", () => {
    assert.throws(() => createWsdotTrafficAdapter({}), /accessCode/);
  });

  it("emits a fully valid batch from alerts and flows", async () => {
    const signals = await adapterFor({
      alerts: [alertRecord()],
      flows: [flowRecord()],
    }).pull(ctx);
    const { valid, rejected } = validateBatch(signals);

    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 2);
    for (const signal of valid) {
      assert.equal(signal.source, "wsdot-traffic");
      assert.equal(signal.confidence, 0.9);
    }
  });

  it("maps construction to closure and collisions to traffic", async () => {
    const signals = await adapterFor({
      alerts: [
        alertRecord({ AlertID: 1, EventCategory: "Construction" }),
        alertRecord({ AlertID: 2, EventCategory: "Collision" }),
        alertRecord({ AlertID: 3, EventCategory: "Lane Closure" }),
      ],
    }).pull(ctx);

    const kinds = new Map(signals.map((s) => [s.sourceId, s.kind]));
    assert.equal(kinds.get("alert-1"), "closure");
    assert.equal(kinds.get("alert-2"), "traffic");
    assert.equal(kinds.get("alert-3"), "closure");
  });

  it("tiers alert intensity by WSDOT priority", async () => {
    const signals = await adapterFor({
      alerts: [
        alertRecord({ AlertID: 1, Priority: "Highest" }),
        alertRecord({ AlertID: 2, Priority: "Low" }),
        alertRecord({ AlertID: 3, Priority: "Mystery" }),
      ],
    }).pull(ctx);

    const byId = new Map(signals.map((s) => [s.sourceId, s.intensity]));
    assert.equal(byId.get("alert-1"), 0.9);
    assert.equal(byId.get("alert-2"), 0.3);
    assert.equal(byId.get("alert-3"), 0.4);
  });

  it("emits a polyline when an alert spans a segment", async () => {
    const [signal] = await adapterFor({
      alerts: [
        alertRecord({
          EndRoadwayLocation: {
            Latitude: 47.64,
            Longitude: -122.32,
            RoadName: "I-5",
          },
        }),
      ],
    }).pull(ctx);

    assert.equal(signal.geometry.type, "polyline");
    assert.equal(signal.geometry.coordinates.length, 2);
    assert.ok(toHotspot(signal, SEATTLE_VIEWPORT));
  });

  it("uses EndTime as expiry when present, TTL backstop otherwise", async () => {
    const signals = await adapterFor({
      alerts: [
        alertRecord({ AlertID: 1, EndTime: "/Date(1783301400000-0700)/" }),
        alertRecord({ AlertID: 2, EventCategory: "Construction" }),
      ],
    }).pull(ctx);

    const byId = new Map(signals.map((s) => [s.sourceId, s]));
    assert.equal(byId.get("alert-1").expiresAt, "2026-07-06T01:30:00.000Z");
    assert.equal(
      new Date(byId.get("alert-2").expiresAt).getTime() - FIXED_NOW.getTime(),
      24 * 60 * 60_000, // unbounded closure backstop
    );
  });

  it("drops closed events and alerts without coordinates", async () => {
    const signals = await adapterFor({
      alerts: [
        alertRecord(),
        alertRecord({ AlertID: 2, EventStatus: "Closed" }),
        alertRecord({ AlertID: 3, StartRoadwayLocation: { Latitude: 0, Longitude: 0 } }),
      ],
    }).pull(ctx);

    assert.equal(signals.length, 1);
  });

  it("only emits flow stations reading Moderate or worse", async () => {
    const signals = await adapterFor({
      flows: [
        flowRecord({ FlowDataID: 1, FlowReadingValue: 1 }), // WideOpen
        flowRecord({ FlowDataID: 2, FlowReadingValue: 2 }),
        flowRecord({ FlowDataID: 3, FlowReadingValue: 4 }),
        flowRecord({ FlowDataID: 4, FlowReadingValue: "StopAndGo" }),
        flowRecord({ FlowDataID: 5, FlowReadingValue: 5 }), // NoData
      ],
    }).pull(ctx);

    const byId = new Map(signals.map((s) => [s.sourceId, s]));
    assert.equal(signals.length, 3);
    assert.equal(byId.get("flow-2").intensity, 0.4);
    assert.equal(byId.get("flow-3").intensity, 0.9);
    assert.equal(byId.get("flow-4").intensity, 0.9);
    assert.match(byId.get("flow-3").label, /Stop-and-go on I-5 SB/);
  });

  it("drops flow readings older than the traffic TTL", async () => {
    const signals = await adapterFor({
      flows: [flowRecord({ Time: "/Date(1783283400000-0700)/" })], // 20:30Z + 15m < now
    }).pull(ctx);

    assert.equal(signals.length, 0);
  });

  it("throws when either endpoint fails — no partial snapshots", async () => {
    await assert.rejects(
      adapterFor({ alerts: [alertRecord()], statuses: { flows: 503 } }).pull(ctx),
      /HTTP 503/,
    );
  });
});

describe("formatRoadName", () => {
  it("humanizes numeric WSDOT route numbers", async () => {
    const { formatRoadName } = await import("../src/signals/wsdotTrafficAdapter.js");
    assert.equal(formatRoadName("005"), "I-5");
    assert.equal(formatRoadName("090"), "I-90");
    assert.equal(formatRoadName("101"), "US 101");
    assert.equal(formatRoadName("520"), "SR 520");
    assert.equal(formatRoadName("I-5 Express"), "I-5 Express");
    assert.equal(formatRoadName(null), "");
  });

  it("flows into labels", async () => {
    const signals = await adapterFor({ flows: [flowRecord()] }).pull(ctx);
    assert.match(signals[0].label, /Heavy traffic on I-5 SB/);
  });
});
