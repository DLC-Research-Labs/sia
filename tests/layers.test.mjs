import test from "node:test";
import assert from "node:assert/strict";

import {
  signalCenter,
  signalListEntries,
  visibleTypesFromToggles,
} from "../src/layers.js";

const signal = (overrides = {}) => ({
  kind: "safety",
  label: "Aid Response",
  detail: "3rd Ave & Pine St",
  intensity: 0.55,
  geometry: { type: "point", coordinates: [-122.33, 47.61] },
  ...overrides,
});

test("visibleTypesFromToggles", async (t) => {
  await t.test("all toggles on by default — every render type visible", () => {
    assert.deepEqual(
      [...visibleTypesFromToggles()].sort(),
      ["closure", "crowding", "event", "safety", "traffic"],
    );
  });

  await t.test("traffic off removes traffic AND closure", () => {
    const visible = visibleTypesFromToggles({ traffic: false });
    assert.equal(visible.has("traffic"), false);
    assert.equal(visible.has("closure"), false);
    assert.equal(visible.has("safety"), true);
  });

  await t.test("events off removes event AND crowding", () => {
    const visible = visibleTypesFromToggles({ events: false });
    assert.equal(visible.has("event"), false);
    assert.equal(visible.has("crowding"), false);
  });

  await t.test("everything off yields an empty set", () => {
    assert.equal(visibleTypesFromToggles({ traffic: false, events: false, safety: false }).size, 0);
  });
});

test("signalCenter", async (t) => {
  await t.test("point passes through", () => {
    assert.deepEqual(signalCenter({ type: "point", coordinates: [-122.3, 47.6] }), [-122.3, 47.6]);
  });

  await t.test("line uses its first vertex", () => {
    assert.deepEqual(
      signalCenter({ type: "line", coordinates: [[-122.3, 47.6], [-122.2, 47.7]] }),
      [-122.3, 47.6],
    );
  });

  await t.test("polygon uses the first vertex of its outer ring", () => {
    assert.deepEqual(
      signalCenter({ type: "polygon", coordinates: [[[-122.3, 47.6], [-122.2, 47.6], [-122.2, 47.7]]] }),
      [-122.3, 47.6],
    );
  });
});

test("signalListEntries", async (t) => {
  await t.test("filters by visible render type, mapping kind first", () => {
    const entries = signalListEntries(
      [signal(), signal({ kind: "commotion", label: "Disturbance" }), signal({ kind: "traffic", label: "I-5 slow" })],
      new Set(["safety"]),
    );
    assert.deepEqual(entries.map((entry) => entry.label), ["Aid Response", "Disturbance"]);
    assert.ok(entries.every((entry) => entry.type === "safety"));
  });

  await t.test("sorts hottest first", () => {
    const entries = signalListEntries(
      [signal({ intensity: 0.3, label: "calm" }), signal({ intensity: 0.9, label: "hot" })],
      new Set(["safety"]),
    );
    assert.deepEqual(entries.map((entry) => entry.label), ["hot", "calm"]);
  });

  await t.test("missing detail becomes empty string, center is extracted", () => {
    const [entry] = signalListEntries([signal({ detail: undefined })], new Set(["safety"]));
    assert.equal(entry.detail, "");
    assert.deepEqual(entry.coordinates, [-122.33, 47.61]);
  });
});
