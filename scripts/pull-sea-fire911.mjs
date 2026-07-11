// Manual smoke test: pull the live Seattle Fire 911 feed through the adapter,
// validate the batch, and show what would land on the map.
//   node scripts/pull-sea-fire911.mjs

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import {
  SEATTLE_VIEWPORT,
  seaFire911Adapter,
} from "../src/signals/seaFire911Adapter.js";

const ctx = { now: () => new Date(), log: (msg) => console.log(`[ctx] ${msg}`) };

const signals = await seaFire911Adapter.pull(ctx);
const { valid, rejected } = validateBatch(signals);

console.log(`pulled ${signals.length} live signals — ${valid.length} valid, ${rejected.length} rejected`);
for (const { errors } of rejected) console.log(`  rejected: ${errors.join("; ")}`);

for (const signal of valid.slice(0, 10)) {
  const hotspot = toHotspot(signal, SEATTLE_VIEWPORT);
  const place = hotspot
    ? `x=${hotspot.x.toFixed(1)} y=${hotspot.y.toFixed(1)} r=${hotspot.radius.toFixed(1)}`
    : "outside viewport";
  console.log(
    `  ${signal.id} ${signal.intensity.toFixed(2)} "${signal.label}" (${signal.observedAt}) → ${place}`,
  );
}
