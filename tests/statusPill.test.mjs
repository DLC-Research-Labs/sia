import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeLiveStatus } from "../src/statusPill.js";

const FIRE = { id: "sea-fire911", name: "Seattle Fire 911", status: "live", error: null, signalCount: 19 };
const WSDOT_DOWN = { id: "wsdot-traffic", name: "WSDOT Traffic", status: "error", error: "HTTP 500", signalCount: 0 };

describe("describeLiveStatus", () => {
  it("shows the plain live read when every feed is up", () => {
    const { text, dotClass, title } = describeLiveStatus({
      liveStatus: "live",
      liveSignalCount: 19,
      adapterStates: [FIRE],
    });
    assert.equal(text, "Seattle live — 19 signals");
    assert.equal(dotClass, "live-dot live");
    assert.equal(title, "Seattle Fire 911 — live · 19 signals");
  });

  it("shows N-of-M feeds when degraded, with the breakdown in the tooltip", () => {
    const { text, dotClass, title } = describeLiveStatus({
      liveStatus: "degraded",
      liveSignalCount: 19,
      adapterStates: [FIRE, WSDOT_DOWN],
    });
    assert.equal(text, "Seattle live — 19 signals · 1/2 feeds");
    assert.equal(dotClass, "live-dot degraded");
    assert.equal(
      title,
      "Seattle Fire 911 — live · 19 signals\nWSDOT Traffic — unreachable (HTTP 500)",
    );
  });

  it("goes red only when nothing is live, keeping the stale-beats-blank copy", () => {
    const { text, dotClass } = describeLiveStatus({
      liveStatus: "error",
      liveSignalCount: 12,
      adapterStates: [{ ...FIRE, status: "error", error: "timeout", signalCount: 12 }],
    });
    assert.equal(text, "Live feeds unreachable — showing last known");
    assert.equal(dotClass, "live-dot error");
  });

  it("reads as connecting before the first pull", () => {
    const { text, dotClass, title } = describeLiveStatus({
      liveStatus: "connecting",
      liveSignalCount: 0,
      adapterStates: [],
    });
    assert.equal(text, "Connecting to Seattle feeds…");
    assert.equal(dotClass, "live-dot connecting");
    assert.equal(title, "Connecting to Seattle feeds…");
  });

  it("pluralizes a single signal correctly", () => {
    const { text } = describeLiveStatus({
      liveStatus: "live",
      liveSignalCount: 1,
      adapterStates: [{ ...FIRE, signalCount: 1 }],
    });
    assert.equal(text, "Seattle live — 1 signal");
  });
});
