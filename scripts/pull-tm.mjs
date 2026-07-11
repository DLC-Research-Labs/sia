// Manual smoke test: pull live Ticketmaster events through the adapter.
//   TM_API_KEY=... node scripts/pull-tm.mjs   (or pass as argv[2])

import { validateBatch, toHotspot } from "../src/signals/contract.js";
import { SEATTLE_VIEWPORT } from "../src/signals/seaFire911Adapter.js";
import { createTmEventsAdapter } from "../src/signals/tmEventsAdapter.js";

const apiKey = process.argv[2] ?? process.env.TM_API_KEY;
if (!apiKey) {
  console.error("usage: TM_API_KEY=... node scripts/pull-tm.mjs");
  process.exit(1);
}

const adapter = createTmEventsAdapter({ apiKey });
const ctx = { now: () => new Date(), log: (msg) => console.log(`[ctx] ${msg}`) };

const signals = await adapter.pull(ctx);
const { valid, rejected } = validateBatch(signals);
const inSeattle = valid.filter((s) => toHotspot(s, SEATTLE_VIEWPORT));

console.log(
  `pulled ${signals.length} events — ${valid.length} valid, ${rejected.length} rejected, ${inSeattle.length} in the Seattle viewport`,
);
for (const { errors } of rejected.slice(0, 5)) console.log(`  rejected: ${errors.join("; ")}`);

for (const signal of inSeattle.slice(0, 12)) {
  console.log(
    `  ${signal.id} ${signal.intensity.toFixed(2)} "${signal.label}" @ ${signal.startsAt}`,
  );
}
