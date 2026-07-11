import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CORRIDORS, corridorsForScoring } from "../src/corridors.js";
import { projectToPlane } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";
import { buildRouteGuidance } from "../src/domain.js";

describe("projectToPlane", () => {
  it("maps viewport corners to plane corners", () => {
    const { west, south, east, north } = SEATTLE_VIEWPORT;
    assert.deepEqual(projectToPlane([west, north], SEATTLE_VIEWPORT), { x: 0, y: 0 });
    assert.deepEqual(projectToPlane([east, south], SEATTLE_VIEWPORT), { x: 100, y: 100 });
    const center = projectToPlane([(west + east) / 2, (south + north) / 2], SEATTLE_VIEWPORT);
    assert.ok(Math.abs(center.x - 50) < 1e-9 && Math.abs(center.y - 50) < 1e-9);
  });
});

describe("corridors", () => {
  it("all corridor vertices project inside the scoring plane", () => {
    for (const corridor of corridorsForScoring(SEATTLE_VIEWPORT)) {
      for (const point of corridor.points) {
        assert.ok(
          point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100,
          `${corridor.id} vertex out of plane: ${JSON.stringify(point)}`,
        );
      }
    }
  });

  it("scoring corridors are domain.js-compatible routes", () => {
    const guidance = buildRouteGuidance(corridorsForScoring(SEATTLE_VIEWPORT), [], []);
    assert.equal(guidance.scoredRoutes.length, CORRIDORS.length);
    assert.ok(guidance.summary.length > 0);
  });

  it("a downtown hotspot pressures the I-5 corridor most", () => {
    // Real coords for I-5 at Seneca St, projected the same way toHotspot does.
    const downtown = projectToPlane([-122.328, 47.607], SEATTLE_VIEWPORT);
    const hotspot = {
      id: "test", label: "Downtown incident", type: "traffic",
      x: downtown.x, y: downtown.y, radius: 8, intensity: 0.9, detail: "",
    };
    const guidance = buildRouteGuidance(corridorsForScoring(SEATTLE_VIEWPORT), [hotspot], []);
    assert.equal(guidance.worstRoute.id, "i5");
  });
});
