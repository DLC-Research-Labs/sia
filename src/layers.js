// Layer visibility + signal-list helpers shared by both pages. The three
// user-facing toggles are coarser than the eight signal kinds on purpose —
// people think "traffic", not "traffic vs closure".

import { KIND_TO_RENDER_TYPE } from "./signals/contract.js";

export const TOGGLE_GROUPS = {
  traffic: ["traffic", "closure"],
  events: ["event", "crowding"],
  safety: ["safety"],
};

export function visibleTypesFromToggles({ traffic = true, events = true, safety = true } = {}) {
  const visible = new Set();
  if (traffic) TOGGLE_GROUPS.traffic.forEach((type) => visible.add(type));
  if (events) TOGGLE_GROUPS.events.forEach((type) => visible.add(type));
  if (safety) TOGGLE_GROUPS.safety.forEach((type) => visible.add(type));
  return visible;
}

export function signalCenter(geometry) {
  if (geometry.type === "point") return geometry.coordinates;
  const ring = geometry.type === "polygon" ? geometry.coordinates[0] : geometry.coordinates;
  return ring[0];
}

// Flat, hottest-first entries for the accessible signal list: what a screen
// reader (or keyboard user) gets instead of pointer-only canvas circles.
export function signalListEntries(signals, visibleTypes) {
  return signals
    .map((signal) => ({
      type: KIND_TO_RENDER_TYPE[signal.kind],
      label: signal.label,
      detail: signal.detail ?? "",
      intensity: signal.intensity,
      coordinates: signalCenter(signal.geometry),
    }))
    .filter((entry) => visibleTypes.has(entry.type))
    .sort((a, b) => b.intensity - a.intensity);
}
