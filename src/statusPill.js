// Status-pill copy for both pages (mock plane + real map). Pure: takes the
// live-store state, returns text/class/tooltip. Worst-of-feeds coloring with
// a "degraded" middle tier so one dead feed doesn't paint the pill red while
// another is still reporting; the tooltip carries the per-feed breakdown.

export function describeLiveStatus({ liveStatus, liveSignalCount, adapterStates = [] }) {
  const liveFeeds = adapterStates.filter((adapter) => adapter.status === "live").length;
  const plural = liveSignalCount === 1 ? "" : "s";

  const text =
    liveStatus === "live"
      ? `Seattle live — ${liveSignalCount} signal${plural}`
      : liveStatus === "degraded"
        ? `Seattle live — ${liveSignalCount} signal${plural} · ${liveFeeds}/${adapterStates.length} feeds`
        : liveStatus === "error"
          ? "Live feeds unreachable — showing last known"
          : "Connecting to Seattle feeds…";

  const title =
    adapterStates.length === 0
      ? "Connecting to Seattle feeds…"
      : adapterStates
          .map((adapter) =>
            adapter.status === "live"
              ? `${adapter.name} — live · ${adapter.signalCount} signal${adapter.signalCount === 1 ? "" : "s"}`
              : `${adapter.name} — unreachable${adapter.error ? ` (${adapter.error})` : ""}`,
          )
          .join("\n");

  return { text, dotClass: `live-dot ${liveStatus}`, title };
}
