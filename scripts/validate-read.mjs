// Product-truth harness: pull the live feeds, compute the exact corridor read
// the app would show right now, and run diagnostic probes that expose where
// the scoring might lie. Read-only; prints a report.
//   WSDOT_ACCESS_CODE=$(cat ~/.wsdot/access-code) node scripts/validate-read.mjs

import { validateBatch, toHotspot, projectToPlane, planeAspect } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT, seaFire911Adapter } from "../src/signals/seaFire911Adapter.js";
import { createWsdotTrafficAdapter } from "../src/signals/wsdotTrafficAdapter.js";
import { corridorsForScoring, CORRIDORS } from "../src/corridors.js";
import { buildRouteGuidance, scoreRoute } from "../src/domain.js";

const ctx = { now: () => new Date(), log: (m) => console.log(`  [feed] ${m}`) };
const vp = SEATTLE_VIEWPORT;

// ---- 1. Pull live signals -------------------------------------------------
const adapters = [seaFire911Adapter];
if (process.env.WSDOT_ACCESS_CODE) {
  adapters.push(createWsdotTrafficAdapter({ accessCode: process.env.WSDOT_ACCESS_CODE }));
}

const allSignals = [];
for (const adapter of adapters) {
  try {
    const { valid } = validateBatch(await adapter.pull(ctx));
    allSignals.push(...valid);
  } catch (e) {
    console.log(`  [feed] ${adapter.id} FAILED: ${e.message}`);
  }
}
const hotspots = allSignals.map((s) => toHotspot(s, vp)).filter(Boolean);

console.log(`\n=== LIVE READ @ ${new Date().toISOString()} ===`);
console.log(`${allSignals.length} signals, ${hotspots.length} inside viewport`);
const byKind = {};
for (const h of hotspots) byKind[h.type] = (byKind[h.type] ?? 0) + 1;
console.log("by render type:", byKind);

// ---- 2. The corridor read -------------------------------------------------
const corridors = corridorsForScoring(vp);
const aspect = planeAspect(vp);
const guidance = buildRouteGuidance(corridors, hotspots, [], { aspect });
console.log("\n--- corridor scores ---");
for (const { route, score } of guidance.scoredRoutes) {
  console.log(
    `  ${route.name.padEnd(22)} ${String(score.total).padStart(3)}/100  ${score.level.toUpperCase().padEnd(9)} ` +
      `${score.incidentCount} signals · top: ${score.impacts[0]?.label ?? "—"}`,
  );
}
console.log(`\n  guidance: "${guidance.summary}"`);

// ---- 3. Projection-distortion probe --------------------------------------
// The 0-100 plane squashes a non-square bbox, so plane distance != real
// distance, and the ratio differs by axis. Quantify it.
const midLat = (vp.north + vp.south) / 2;
const mPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
const ewMetersPerUnit = ((vp.east - vp.west) * mPerDegLng) / 100;
const nsMetersPerUnit = ((vp.north - vp.south) * 111_320) / 100;
console.log("\n--- projection integrity ---");
console.log(`  1 plane unit east-west  = ${ewMetersPerUnit.toFixed(0)} m`);
console.log(`  1 plane unit north-south= ${nsMetersPerUnit.toFixed(0)} m`);
console.log(`  anisotropy (NS/EW)      = ${(nsMetersPerUnit / ewMetersPerUnit).toFixed(2)}x`);
console.log("  => a circular influence radius on the plane is an ellipse in reality;");
console.log("     and toHotspot sizes radiusM using EW meters only.");

// ---- 4. Single-alert-tanks-a-corridor probe ------------------------------
// Drop one hard closure directly on each corridor's midpoint; see the delta.
console.log("\n--- sensitivity: one 0.9 closure on each corridor midpoint ---");
for (const corridor of corridors) {
  const mid = corridor.points[Math.floor(corridor.points.length / 2)];
  const probe = { id: "probe", label: "probe", type: "closure", x: mid.x, y: mid.y, radius: 6, intensity: 0.9, detail: "" };
  const base = scoreRoute(corridor, hotspots, [], { aspect }).total;
  const withProbe = scoreRoute(corridor, [...hotspots, probe], [], { aspect }).total;
  console.log(`  ${corridor.name.padEnd(22)} ${base} -> ${withProbe}  (+${withProbe - base})`);
}

// ---- 5. Are live signals actually near the corridors? --------------------
// If most signals miss every corridor's influence, the read is driven by a
// handful — worth knowing.
let touching = 0;
for (const h of hotspots) {
  const near = corridors.some((c) =>
    c.points.some((p) => Math.hypot(p.x - h.x, p.y - h.y) < h.radius * 1.35),
  );
  if (near) touching += 1;
}
console.log(`\n--- coverage ---`);
console.log(`  ${touching}/${hotspots.length} in-viewport signals influence at least one corridor`);

// ---- 6. Raw sample for the reality check ---------------------------------
console.log("\n--- 8 strongest signals (for eyeball vs reality) ---");
for (const s of [...allSignals].sort((a, b) => b.intensity - a.intensity).slice(0, 8)) {
  const c = s.geometry.type === "point" ? s.geometry.coordinates : s.geometry.coordinates[0];
  console.log(`  ${s.intensity.toFixed(2)} ${s.kind.padEnd(8)} "${s.label}" [${c[1].toFixed(3)},${c[0].toFixed(3)}]`);
}
