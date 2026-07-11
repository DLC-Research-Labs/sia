import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scoreRoute } from "../src/domain.js";

// A simple vertical corridor down x=50.
const vertical = { id: "v", name: "Vertical", points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] };
// A simple horizontal corridor across y=50.
const horizontal = { id: "h", name: "Horizontal", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] };

function hotspot(over = {}) {
  return { id: "s", label: "sig", type: "closure", x: 50, y: 50, radius: 3, intensity: 0.9, ...over };
}

describe("per-segment line scoring (P1: no bounding-disc bleed)", () => {
  it("excludes a parallel line whose path stays outside the band", () => {
    // Line 10 units east of the corridor, band radius 3 (influence 4.05).
    const line = hotspot({ x: 60, y: 50, radius: 3, path: [{ x: 60, y: 0 }, { x: 60, y: 100 }] });
    assert.equal(scoreRoute(vertical, [line]).incidentCount, 0);
  });

  it("but the same feature collapsed to a wide point disc WOULD bleed", () => {
    // Demonstrates the old failure mode: point at the line's center, big radius.
    const disc = hotspot({ x: 60, y: 50, radius: 10 }); // no path → point scoring
    assert.equal(scoreRoute(vertical, [disc]).incidentCount, 1);
  });

  it("includes a line that crosses the corridor, at full proximity", () => {
    const crossing = hotspot({ x: 50, y: 50, radius: 2, path: [{ x: 0, y: 50 }, { x: 100, y: 50 }] });
    const score = scoreRoute(vertical, [crossing]);
    assert.equal(score.incidentCount, 1);
    assert.ok(score.total > 60); // distance 0 → strong
  });
});

describe("anisotropy-aware distance (P2)", () => {
  it("a north-south offset reaches less far than the same plane offset east-west", () => {
    // Point 4 units due north of a horizontal corridor; band influence = 3*1.35 = 4.05.
    const north = hotspot({ x: 50, y: 54, radius: 3 });
    assert.equal(scoreRoute(horizontal, [north], [], { aspect: 1 }).incidentCount, 1); // 4 < 4.05
    assert.equal(scoreRoute(horizontal, [north], [], { aspect: 1.6 }).incidentCount, 0); // 6.4 > 4.05
  });
});

describe("phantom impacts (F)", () => {
  it("a 0.25-intensity signal on the corridor neither counts nor scores", () => {
    const faint = hotspot({ x: 50, y: 50, radius: 5, intensity: 0.25 });
    const score = scoreRoute(vertical, [faint]);
    assert.equal(score.incidentCount, 0);
    assert.equal(score.total, 0);
  });
});

describe("personal avoid zones dominate (E)", () => {
  it("a user avoid zone out-penalizes an identical automatic closure", () => {
    const spot = { x: 50, y: 50, radius: 10, intensity: 1 };
    const closureTotal = scoreRoute(vertical, [{ ...spot, id: "c", label: "c", type: "closure" }]).total;
    const avoidTotal = scoreRoute(vertical, [], [{ ...spot, id: "a", label: "a", type: "personal" }]).total;
    assert.ok(avoidTotal >= closureTotal, `avoid ${avoidTotal} should dominate closure ${closureTotal}`);
  });
});
