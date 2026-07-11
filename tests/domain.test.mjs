import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFocusedGuidance,
  buildRouteGuidance,
  createAvoidZone,
  scoreRoute,
} from "../src/domain.js";

const hotspots = [
  {
    id: "downtown-traffic",
    label: "Downtown gridlock",
    type: "traffic",
    x: 52,
    y: 54,
    radius: 16,
    intensity: 0.95,
  },
  {
    id: "stadium-event",
    label: "Stadium letting out",
    type: "event",
    x: 72,
    y: 34,
    radius: 12,
    intensity: 0.72,
  },
];

const routes = [
  {
    id: "north",
    name: "North side",
    points: [
      { x: 12, y: 36 },
      { x: 34, y: 28 },
      { x: 58, y: 26 },
      { x: 86, y: 32 },
    ],
  },
  {
    id: "downtown",
    name: "Downtown corridor",
    points: [
      { x: 12, y: 62 },
      { x: 34, y: 58 },
      { x: 54, y: 54 },
      { x: 86, y: 58 },
    ],
  },
];

describe("route intuition scoring", () => {
  it("penalizes routes that pass through hotter city areas", () => {
    const northScore = scoreRoute(routes[0], hotspots, []);
    const downtownScore = scoreRoute(routes[1], hotspots, []);

    assert.equal(northScore.incidentCount, 1);
    assert.equal(downtownScore.incidentCount, 1);
    assert.ok(downtownScore.total > northScore.total);
    assert.ok(downtownScore.total >= 70);
  });

  it("adds a strong penalty for user-created avoid zones", () => {
    const avoidZone = createAvoidZone({ x: 58, y: 26 }, "personal");
    const cleanScore = scoreRoute(routes[0], hotspots, []);
    const avoidedScore = scoreRoute(routes[0], hotspots, [avoidZone]);

    assert.equal(avoidedScore.avoidCount, 1);
    assert.ok(avoidedScore.total > cleanScore.total + 20);
  });

  it("builds plain-language route guidance from route scores", () => {
    const guidance = buildRouteGuidance(routes, hotspots, []);

    assert.equal(guidance.bestRoute.id, "north");
    assert.equal(guidance.worstRoute.id, "downtown");
    assert.match(guidance.summary, /North side/);
    assert.match(guidance.summary, /calmer/i);
    assert.match(guidance.alternatives[0].summary, /Downtown corridor/);
  });
});

describe("buildFocusedGuidance", () => {
  const guidance = buildRouteGuidance(routes, hotspots, []);

  it("confirms the pick when the destination is the calm corridor", () => {
    const focused = buildFocusedGuidance("north", guidance);

    assert.equal(focused.routeId, "north");
    assert.match(focused.summary, /Good call/);
    assert.match(focused.summary, /North side/);
  });

  it("names the calmer alternative when the destination runs hot", () => {
    const focused = buildFocusedGuidance("downtown", guidance);

    assert.equal(focused.routeId, "downtown");
    assert.match(focused.title, /Downtown corridor/);
    assert.match(focused.summary, /North side is calmer if you have the option/);
  });

  it("returns null for a corridor it does not know", () => {
    assert.equal(buildFocusedGuidance("nowhere", guidance), null);
  });
});
