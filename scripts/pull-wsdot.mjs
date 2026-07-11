// Manual smoke test: pull the live WSDOT feeds through the adapter, validate,
// and show what would land on the map (Seattle viewport).
//   WSDOT_ACCESS_CODE=... node scripts/pull-wsdot.mjs
//   node scripts/pull-wsdot.mjs <access-code>

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";
import { createWsdotTrafficAdapter } from "../src/signals/wsdotTrafficAdapter.js";

const accessCode = process.argv[2] ?? process.env.WSDOT_ACCESS_CODE;
if (!accessCode) {
  console.error("usage: WSDOT_ACCESS_CODE=... node scripts/pull-wsdot.mjs");
  process.exit(1);
}

const adapter = createWsdotTrafficAdapter({ accessCode });
const ctx = { now: () => new Date(), log: (msg) => console.log(`[ctx] ${msg}`) };

const signals = await adapter.pull(ctx);
const { valid, rejected } = validateBatch(signals);
const inSeattle = valid.filter((s) => toHotspot(s, SEATTLE_VIEWPORT));

console.log(
  `pulled ${signals.length} statewide — ${valid.length} valid, ${rejected.length} rejected, ${inSeattle.length} in the Seattle viewport`,
);
for (const { errors } of rejected.slice(0, 5)) console.log(`  rejected: ${errors.join("; ")}`);

const byKind = {};
for (const s of valid) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
console.log("by kind:", byKind);

for (const signal of inSeattle.slice(0, 12)) {
  console.log(`  ${signal.id} ${signal.kind} ${signal.intensity.toFixed(2)} "${signal.label}"`);
}
