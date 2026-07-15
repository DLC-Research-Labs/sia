// MapLibre spike: real Seattle streets under real signals. Rendering happens
// in WGS84 straight from CitySignals; domain.js scoring is untouched — real
// corridor/zone geometry projects onto the 0–100 plane, which survives here
// purely as a scoring space. No mock hotspots on this page: what you see is
// what the feeds said.

import { buildFocusedGuidance, buildRouteGuidance } from "./domain.js";
import { CORRIDORS, corridorsForScoring } from "./corridors.js";
import { KIND_TO_RENDER_TYPE, planeAspect, projectToPlane } from "./signals/contract.js";
import { signalListEntries, visibleTypesFromToggles } from "./layers.js";
import { createLiveSignalStore } from "./signals/liveSignals.js";
import { deriveCommotion } from "./signals/deriveCommotion.js";
import { describeLiveStatus } from "./statusPill.js";
import { SEATTLE_VIEWPORT, seaFire911Adapter } from "./signals/seaFire911Adapter.js";
import { createWsdotTrafficAdapter } from "./signals/wsdotTrafficAdapter.js";
import { createTmEventsAdapter } from "./signals/tmEventsAdapter.js";
import { jsonpFetch } from "./signals/jsonpFetch.js";

const STORAGE_KEY = "city-intuition-avoid-zones-geo";
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

const RENDER_COLORS = {
  traffic: "#d84f2a",
  event: "#5967c9",
  safety: "#c68424",
  closure: "#7d4ea8",
  crowding: "#6b7f88",
};

const scoringCorridors = corridorsForScoring(SEATTLE_VIEWPORT);
const SCORING_ASPECT = planeAspect(SEATTLE_VIEWPORT);

const state = {
  hotspots: [], // plane-projected, for scoring
  signals: [], // raw WGS84, for rendering
  liveStatus: "connecting",
  liveSignalCount: 0,
  adapterStates: [],
  avoidZones: loadAvoidZones(), // [{ id, label, lng, lat }]
  addMode: false,
  visibleTypes: visibleTypesFromToggles(),
  companionOpen: sessionStorage.getItem("city-intuition-companion") !== "dismissed",
  destinationRouteId: null,
};

const elements = Object.fromEntries(
  [
    "statusPill", "statusDot", "statusText", "guidanceTitle", "guidanceSummary",
    "routeCards", "addAvoidButton", "clearAvoidButton", "avoidLabel", "avoidList",
    "mapHint", "sourceList", "companion", "companionChips", "companionDismiss",
    "companionReopen", "trafficToggle", "eventsToggle", "safetyToggle",
    "refreshButton", "signalList", "signalListCount",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

const wsdotAccessCode =
  localStorage.getItem("wsdot-access-code") ?? window.WSDOT_ACCESS_CODE ?? "";
const tmApiKey = localStorage.getItem("tm-api-key") ?? window.TM_API_KEY ?? "";
const adapters = [seaFire911Adapter];
if (wsdotAccessCode) {
  adapters.push(createWsdotTrafficAdapter({ accessCode: wsdotAccessCode, fetchImpl: jsonpFetch }));
}
if (tmApiKey) {
  adapters.push(createTmEventsAdapter({ apiKey: tmApiKey }));
}

const map = new maplibregl.Map({
  container: "realMap",
  style: STYLE_URL,
  bounds: [
    [SEATTLE_VIEWPORT.west, SEATTLE_VIEWPORT.south],
    [SEATTLE_VIEWPORT.east, SEATTLE_VIEWPORT.north],
  ],
  fitBoundsOptions: { padding: 12 },
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

// px = radiusM · 2^zoom / (156543·cos(47.6°)); anchored at zooms 8 and 16.
const radiusExpr = (min) => [
  "interpolate", ["exponential", 2], ["zoom"],
  8, ["max", min, ["*", ["get", "radiusM"], 0.0024253]],
  16, ["max", min * 3, ["*", ["get", "radiusM"], 0.62088]],
];

map.on("load", () => {
  map.addSource("signals", { type: "geojson", data: signalFeatures() });
  map.addSource("corridors", { type: "geojson", data: corridorFeatures() });
  map.addSource("avoid", { type: "geojson", data: avoidFeatures() });

  map.addLayer({
    id: "corridor-lines",
    type: "line",
    source: "corridors",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: corridorPaint(null),
  });

  map.addLayer({
    id: "signal-glow",
    type: "circle",
    source: "signals",
    paint: {
      "circle-radius": radiusExpr(6),
      "circle-color": ["match", ["get", "type"], ...Object.entries(RENDER_COLORS).flat(), "#d84f2a"],
      "circle-opacity": ["+", 0.12, ["*", 0.38, ["get", "intensity"]]],
      "circle-blur": 0.8,
    },
  });

  map.addLayer({
    id: "signal-cores",
    type: "circle",
    source: "signals",
    paint: {
      "circle-radius": 4,
      "circle-color": ["match", ["get", "type"], ...Object.entries(RENDER_COLORS).flat(), "#d84f2a"],
      "circle-opacity": ["+", 0.45, ["*", 0.5, ["get", "intensity"]]],
      "circle-stroke-width": 1,
      "circle-stroke-color": "rgba(255,255,255,0.85)",
    },
  });

  map.addLayer({
    id: "avoid-zones",
    type: "circle",
    source: "avoid",
    paint: {
      "circle-radius": radiusExpr(10),
      "circle-color": "rgba(216, 79, 42, 0.14)",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "rgba(216, 79, 42, 0.75)",
    },
  });

  map.on("click", (event) => {
    if (!state.addMode) return;
    const label = elements.avoidLabel.value.trim() || "Personal avoid";
    state.avoidZones.push({
      id: `avoid-${Date.now()}`,
      label,
      lng: event.lngLat.lng,
      lat: event.lngLat.lat,
    });
    state.addMode = false;
    saveAvoidZones();
    render();
  });

  map.on("click", "signal-cores", (event) => {
    if (state.addMode) return;
    const { label, detail } = event.features[0].properties;
    openSignalPopup(event.lngLat, label, detail);
  });
  map.on("mouseenter", "signal-cores", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "signal-cores", () => (map.getCanvas().style.cursor = ""));

  startPulse();
  render();
});

const liveStore = createLiveSignalStore({
  adapters,
  derivers: [deriveCommotion],
  viewport: SEATTLE_VIEWPORT,
  onUpdate: ({ status, hotspots, signals, signalCount, adapterStates }) => {
    state.liveStatus = status;
    state.hotspots = hotspots;
    state.signals = signals;
    state.liveSignalCount = signalCount;
    state.adapterStates = adapterStates;
    render();
  },
});

elements.companionDismiss.addEventListener("click", () => {
  state.companionOpen = false;
  state.destinationRouteId = null;
  sessionStorage.setItem("city-intuition-companion", "dismissed");
  render();
});
elements.companionReopen.addEventListener("click", () => {
  state.companionOpen = true;
  sessionStorage.removeItem("city-intuition-companion");
  render();
});
elements.addAvoidButton.addEventListener("click", () => {
  state.addMode = !state.addMode;
  render();
});
elements.refreshButton.addEventListener("click", () => {
  state.liveStatus = "connecting";
  render();
  liveStore.tick();
});
for (const toggle of [elements.trafficToggle, elements.eventsToggle, elements.safetyToggle]) {
  toggle.addEventListener("change", () => {
    state.visibleTypes = visibleTypesFromToggles({
      traffic: elements.trafficToggle.checked,
      events: elements.eventsToggle.checked,
      safety: elements.safetyToggle.checked,
    });
    render();
  });
}
elements.clearAvoidButton.addEventListener("click", () => {
  state.avoidZones = [];
  saveAvoidZones();
  render();
});

renderSources();
render();
liveStore.start();

// ---------- rendering ----------

function render() {
  // Hidden layers leave the route read too — the score must match the view.
  const visibleHotspots = state.hotspots.filter((hotspot) =>
    state.visibleTypes.has(hotspot.type),
  );
  const guidance = buildRouteGuidance(scoringCorridors, visibleHotspots, scoringAvoidZones(), {
    aspect: SCORING_ASPECT,
  });

  if (map.loaded() || map.getSource("signals")) {
    map.getSource("signals")?.setData(signalFeatures());
    map.getSource("avoid")?.setData(avoidFeatures());
    const typeFilter = ["in", ["get", "type"], ["literal", [...state.visibleTypes]]];
    for (const layer of ["signal-glow", "signal-cores"]) {
      if (map.getLayer(layer)) map.setFilter(layer, typeFilter);
    }
    const focusId = state.destinationRouteId ?? guidance.bestRoute.id;
    if (map.getLayer("corridor-lines")) {
      for (const [prop, value] of Object.entries(corridorPaint(focusId))) {
        map.setPaintProperty("corridor-lines", prop, value);
      }
    }
  }

  renderGuidance(guidance);
  renderSignalList();
  renderAvoidList();
  renderLiveStatus();
  renderCompanion(guidance);

  elements.addAvoidButton.setAttribute("aria-pressed", String(state.addMode));
  elements.mapHint.classList.toggle("hidden", !state.addMode);
  document.querySelector("#realMap").classList.toggle("placing", state.addMode);

  window.__cityMapDebug = {
    signalCount: state.signals.length,
    status: state.liveStatus,
    corridors: scoringCorridors.map((c) => c.id),
    visibleTypes: [...state.visibleTypes],
    guidanceTotals: guidance.scoredRoutes.map(({ route, score }) => [route.id, score.total]),
  };
}

function signalFeatures() {
  return {
    type: "FeatureCollection",
    features: state.signals.map((signal) => {
      const geometry = signal.geometry;
      const center =
        geometry.type === "point"
          ? geometry.coordinates
          : (geometry.type === "polygon" ? geometry.coordinates[0] : geometry.coordinates)[0];
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: center },
        properties: {
          type: KIND_TO_RENDER_TYPE[signal.kind],
          intensity: signal.intensity,
          radiusM: geometry.radiusM ?? 400,
          label: signal.label,
          detail: signal.detail ?? "",
        },
      };
    }),
  };
}

function corridorFeatures() {
  return {
    type: "FeatureCollection",
    features: CORRIDORS.map((corridor) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: corridor.coords },
      properties: { id: corridor.id, color: corridor.color },
    })),
  };
}

function corridorPaint(focusId) {
  const isFocus = ["==", ["get", "id"], focusId ?? ""];
  return {
    "line-color": ["get", "color"],
    "line-width": ["case", isFocus, 5, 2.5],
    "line-opacity": ["case", isFocus, 0.9, 0.45],
  };
}

function avoidFeatures() {
  return {
    type: "FeatureCollection",
    features: state.avoidZones.map((zone) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [zone.lng, zone.lat] },
      properties: { radiusM: 1500, label: zone.label },
    })),
  };
}

// Same avoid zones, projected for domain.js (plane radius 10 ≈ 1.8 km here).
function scoringAvoidZones() {
  return state.avoidZones.map((zone) => ({
    id: zone.id,
    label: zone.label,
    type: "personal",
    ...projectToPlane([zone.lng, zone.lat], SEATTLE_VIEWPORT),
    radius: 10,
    intensity: 1,
  }));
}

function renderGuidance(guidance) {
  const focused = state.destinationRouteId
    ? buildFocusedGuidance(state.destinationRouteId, guidance)
    : null;

  elements.guidanceTitle.textContent = focused?.title ?? guidance.bestRoute.label;
  elements.guidanceSummary.textContent = focused?.summary ?? guidance.summary;

  const highlightId = focused?.routeId ?? guidance.bestRoute.id;
  elements.routeCards.replaceChildren(
    ...guidance.scoredRoutes.map(({ route, score }) => {
      const card = document.createElement("article");
      card.className = `route-card ${route.id === highlightId ? "selected" : ""}`;

      const title = document.createElement("div");
      title.className = "route-card-title";
      title.innerHTML = `<span>${route.name}</span><strong>${score.total}</strong>`;

      const meta = document.createElement("p");
      meta.textContent = `${score.level.toUpperCase()} - ${score.incidentCount} city signals, ${score.avoidCount} personal zones`;

      const reason = document.createElement("p");
      reason.className = "route-reason";
      reason.textContent = score.impacts[0]?.label ?? "No major pressure on this corridor";

      card.append(title, meta, reason);
      return card;
    }),
  );
}

function renderCompanion(guidance) {
  elements.companion.classList.toggle("hidden", !state.companionOpen);
  elements.companionReopen.classList.toggle("hidden", state.companionOpen);
  if (!state.companionOpen) return;

  elements.companionChips.replaceChildren(
    ...scoringCorridors.map((corridor) => {
      const chip = document.createElement("button");
      chip.type = "button";
      const selected = corridor.id === state.destinationRouteId;
      chip.className = `companion-chip ${selected ? "selected" : ""}`;
      const score = guidance.scoredRoutes.find((entry) => entry.route.id === corridor.id)?.score;
      chip.textContent = `${corridor.name} · ${score?.level ?? ""}`;
      chip.addEventListener("click", () => {
        state.destinationRouteId = selected ? null : corridor.id;
        render();
      });
      return chip;
    }),
  );
}

function renderLiveStatus() {
  const { text, dotClass, title } = describeLiveStatus(state);
  elements.statusText.textContent = text;
  elements.statusDot.className = dotClass;
  elements.statusPill.setAttribute("title", title);
}

function renderSources() {
  const entries = adapters.map((adapter) => `${adapter.name} — live`);
  const covered = new Set(adapters.flatMap((adapter) => adapter.kinds));
  if (!covered.has("traffic")) entries.push("Traffic and closures — off until a WSDOT key is set");
  if (!covered.has("event")) entries.push("Venue events — off until a Ticketmaster key is set");
  entries.push("User reports and preferences — local");

  elements.sourceList.replaceChildren(
    ...entries.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

function openSignalPopup(lngLat, label, detail) {
  new maplibregl.Popup({ closeButton: false })
    .setLngLat(lngLat)
    .setHTML(`<strong>${label}</strong>${detail ? `<br>${detail}` : ""}`)
    .addTo(map);
}

// Keyboard/screen-reader access to what is otherwise pointer-only canvas:
// every visible signal as a real button, hottest first. Activating one flies
// the map there and opens its popup. Rebuild only when content changes so a
// poll mid-keyboard-navigation doesn't yank focus; when it does change while
// focus is inside, focus returns to the same position in the new list.
function renderSignalList() {
  const entries = signalListEntries(state.signals, state.visibleTypes);
  elements.signalListCount.textContent = String(entries.length);

  const signature = entries.map((entry) => `${entry.type}|${entry.label}|${entry.detail}`).join("\n");
  if (elements.signalList.dataset.signature === signature) return;
  elements.signalList.dataset.signature = signature;

  const buttons = [...elements.signalList.querySelectorAll("button")];
  const focusIndex = buttons.indexOf(document.activeElement);

  elements.signalList.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "signal-list-item";

      const swatch = document.createElement("span");
      swatch.className = "signal-swatch";
      swatch.style.background = RENDER_COLORS[entry.type];
      swatch.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.textContent = entry.detail ? `${entry.label} — ${entry.detail}` : entry.label;

      button.append(swatch, text);
      button.addEventListener("click", () => {
        map.flyTo({ center: entry.coordinates, zoom: Math.max(map.getZoom(), 13) });
        openSignalPopup(entry.coordinates, entry.label, entry.detail);
      });
      item.append(button);
      return item;
    }),
  );

  if (focusIndex >= 0) {
    const fresh = elements.signalList.querySelectorAll("button");
    fresh[Math.min(focusIndex, fresh.length - 1)]?.focus();
  }
}

function renderAvoidList() {
  if (state.avoidZones.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No personal avoid zones yet.";
    elements.avoidList.replaceChildren(empty);
    return;
  }

  elements.avoidList.replaceChildren(
    ...state.avoidZones.map((zone) => {
      const row = document.createElement("div");
      row.className = "avoid-row";
      row.innerHTML = `<span>${zone.label}</span><small>${zone.lat.toFixed(3)}, ${zone.lng.toFixed(3)}</small>`;
      return row;
    }),
  );
}

// Living things pulse: a slow breath on the glow layer, skipped for
// prefers-reduced-motion. 8 fps is plenty for a breath.
function startPulse() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let t = 0;
  setInterval(() => {
    if (!map.getLayer("signal-glow")) return;
    t += 0.125;
    const factor = 1 + 0.18 * Math.sin((t * 2 * Math.PI) / 2.8);
    map.setPaintProperty("signal-glow", "circle-opacity", [
      "*", factor, ["+", 0.12, ["*", 0.38, ["get", "intensity"]]],
    ]);
  }, 125);
}

function loadAvoidZones() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveAvoidZones() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.avoidZones));
}
