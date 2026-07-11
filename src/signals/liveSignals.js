// Live-signal ingestion for the prototype: polls adapters on their declared
// cadence, validates batches, prunes expired signals, and projects survivors
// onto the render plane. Owns the snapshot semantics the contract promises —
// a successful pull replaces that adapter's signals; a failed pull keeps the
// previous snapshot (stale beats blank).

import { validateBatch, toHotspot } from "./contract.js";

/**
 * @param {{
 *   adapters: Array<{ id: string, name?: string, cadence: { intervalSec: number }, pull: Function }>,
 *   viewport: { west: number, south: number, east: number, north: number },
 *   onUpdate: (update: {
 *     status: "live"|"degraded"|"error",
 *     adapterStates: Array<{ id: string, name: string, status: "live"|"error", error: string|null, signalCount: number }>,
 *     hotspots: Array<Object>,
 *     signalCount: number,
 *     rejectedCount: number,
 *     lastPullAt: Date,
 *   }) => void,
 *   now?: () => Date,
 * }} options
 *
 * Overall status is worst-of-feeds with a middle tier: every feed live →
 * "live", some live → "degraded", none live → "error". One failing feed
 * should not paint the whole pill red while another is still reporting.
 */
export function createLiveSignalStore({ adapters, viewport, onUpdate, now = () => new Date() }) {
  const snapshots = new Map(); // adapter.id → CitySignal[]
  const health = new Map(); // adapter.id → { status: "live"|"error", error: string|null }
  const timers = [];

  const ctx = { now, log: (msg) => console.info(`[signals] ${msg}`) };

  function liveState() {
    const current = now().getTime();
    const hotspots = [];
    const liveSignals = [];

    for (const [adapterId, signals] of snapshots) {
      const fresh = signals.filter((s) => new Date(s.expiresAt).getTime() > current);
      snapshots.set(adapterId, fresh);
      for (const signal of fresh) {
        liveSignals.push(signal);
        const hotspot = toHotspot(signal, viewport);
        if (hotspot) hotspots.push(hotspot);
      }
    }

    return { hotspots, signals: liveSignals };
  }

  function notify(rejectedCount = 0) {
    const { hotspots, signals } = liveState(); // prunes, so per-adapter counts below are fresh

    const adapterStates = adapters.map((adapter) => {
      const state = health.get(adapter.id) ?? { status: "error", error: "never pulled" };
      return {
        id: adapter.id,
        name: adapter.name ?? adapter.id,
        status: state.status,
        error: state.error,
        signalCount: (snapshots.get(adapter.id) ?? []).length,
      };
    });

    const liveCount = adapterStates.filter((state) => state.status === "live").length;
    const status =
      liveCount === adapterStates.length ? "live" : liveCount > 0 ? "degraded" : "error";

    onUpdate({
      status,
      adapterStates,
      hotspots,
      signals, // raw CitySignals (WGS84) for renderers that don't need the plane
      signalCount: hotspots.length,
      rejectedCount,
      lastPullAt: now(),
    });
  }

  async function tick() {
    let rejectedCount = 0;

    for (const adapter of adapters) {
      try {
        const { valid, rejected } = validateBatch(await adapter.pull(ctx));
        snapshots.set(adapter.id, valid);
        health.set(adapter.id, { status: "live", error: null });
        rejectedCount += rejected.length;
        if (rejected.length > 0) {
          ctx.log(`${adapter.id}: rejected ${rejected.length} invalid signals`);
        }
      } catch (error) {
        // Keep the previous snapshot; expiry pruning still ages it out.
        health.set(adapter.id, { status: "error", error: error.message });
        ctx.log(`${adapter.id}: pull failed — ${error.message}`);
      }
    }

    notify(rejectedCount);
  }

  return {
    tick,

    start() {
      // One shared timer at the fastest declared cadence; per-adapter
      // scheduling can come back when cadences actually diverge.
      const intervalSec = Math.min(...adapters.map((a) => a.cadence.intervalSec));
      timers.push(setInterval(tick, intervalSec * 1000));
      return tick();
    },

    stop() {
      timers.splice(0).forEach(clearInterval);
    },
  };
}
