import { buildFocusedGuidance, buildRouteGuidance, createAvoidZone } from "./domain.js";
import { KIND_TO_RENDER_TYPE } from "./signals/contract.js";
import { visibleTypesFromToggles } from "./layers.js";
import { hotspots as baseHotspots, routes } from "./mockData.js";
import { createLiveSignalStore } from "./signals/liveSignals.js";
import { deriveCommotion } from "./signals/deriveCommotion.js";
import { describeLiveStatus } from "./statusPill.js";
import { SEATTLE_VIEWPORT, seaFire911Adapter } from "./signals/seaFire911Adapter.js";
import { createWsdotTrafficAdapter } from "./signals/wsdotTrafficAdapter.js";
import { createTmEventsAdapter } from "./signals/tmEventsAdapter.js";
import { jsonpFetch } from "./signals/jsonpFetch.js";

const STORAGE_KEY = "city-intuition-avoid-zones";

const state = {
  hotspots: structuredClone(baseHotspots),
  liveHotspots: [],
  liveStatus: "connecting",
  liveSignalCount: 0,
  adapterStates: [],
  connectedAdapterIds: new Set(), // adapters that have succeeded at least once
  avoidZones: loadAvoidZones(),
  addMode: false,
  visibleTypes: visibleTypesFromToggles(),
  // Companion: one question, easy dismiss. null = ambient read, id = focused.
  companionOpen: sessionStorage.getItem("city-intuition-companion") !== "dismissed",
  destinationRouteId: null,
};

const elements = {
  cityMap: document.querySelector("#cityMap"),
  heatLayer: document.querySelector("#heatLayer"),
  avoidLayer: document.querySelector("#avoidLayer"),
  routeLayer: document.querySelector("#routeLayer"),
  routeCards: document.querySelector("#routeCards"),
  guidanceTitle: document.querySelector("#guidanceTitle"),
  guidanceSummary: document.querySelector("#guidanceSummary"),
  addAvoidButton: document.querySelector("#addAvoidButton"),
  clearAvoidButton: document.querySelector("#clearAvoidButton"),
  avoidLabel: document.querySelector("#avoidLabel"),
  avoidList: document.querySelector("#avoidList"),
  mapHint: document.querySelector("#mapHint"),
  refreshButton: document.querySelector("#refreshButton"),
  trafficToggle: document.querySelector("#trafficToggle"),
  eventsToggle: document.querySelector("#eventsToggle"),
  safetyToggle: document.querySelector("#safetyToggle"),
  statusPill: document.querySelector("#statusPill"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  sourceList: document.querySelector("#sourceList"),
  companion: document.querySelector("#companion"),
  companionChips: document.querySelector("#companionChips"),
  companionDismiss: document.querySelector("#companionDismiss"),
  companionReopen: document.querySelector("#companionReopen"),
};

// WSDOT needs a free access code (wsdot.wa.gov/traffic/api). Set it once via
// localStorage.setItem("wsdot-access-code", "…"); the demo build may bake one
// in as window.WSDOT_ACCESS_CODE. Without it, traffic/closure stay mock.
const wsdotAccessCode =
  localStorage.getItem("wsdot-access-code") ?? window.WSDOT_ACCESS_CODE ?? "";

const tmApiKey = localStorage.getItem("tm-api-key") ?? window.TM_API_KEY ?? "";

const adapters = [seaFire911Adapter];
if (wsdotAccessCode) {
  // WSDOT sends no CORS headers; JSONP is its supported browser transport.
  adapters.push(
    createWsdotTrafficAdapter({ accessCode: wsdotAccessCode, fetchImpl: jsonpFetch }),
  );
}
if (tmApiKey) {
  // Ticketmaster's docs advertise CORS; native fetch is the browser transport.
  adapters.push(createTmEventsAdapter({ apiKey: tmApiKey }));
}

const liveStore = createLiveSignalStore({
  adapters,
  derivers: [deriveCommotion],
  viewport: SEATTLE_VIEWPORT,
  onUpdate: ({ status, hotspots, signalCount, adapterStates }) => {
    state.liveStatus = status;
    state.liveHotspots = hotspots;
    state.liveSignalCount = signalCount;
    state.adapterStates = adapterStates;
    for (const adapter of adapterStates) {
      if (adapter.status === "live") state.connectedAdapterIds.add(adapter.id);
    }
    render();
  },
});

elements.addAvoidButton.addEventListener("click", () => {
  state.addMode = !state.addMode;
  elements.addAvoidButton.setAttribute("aria-pressed", String(state.addMode));
  elements.mapHint.classList.toggle("hidden", !state.addMode);
  elements.cityMap.classList.toggle("placing", state.addMode);
});

elements.cityMap.addEventListener("click", (event) => {
  if (!state.addMode) return;

  const rect = elements.cityMap.getBoundingClientRect();
  const center = {
    x: ((event.clientX - rect.left) / rect.width) * 100,
    y: ((event.clientY - rect.top) / rect.height) * 100,
  };
  const label = elements.avoidLabel.value.trim() || "Personal avoid";

  state.avoidZones.push(createAvoidZone(center, label));
  state.addMode = false;
  saveAvoidZones();
  render();
});

elements.clearAvoidButton.addEventListener("click", () => {
  state.avoidZones = [];
  saveAvoidZones();
  render();
});

elements.refreshButton.addEventListener("click", () => {
  nudgeMockSignal();
  state.liveStatus = "connecting";
  render();
  liveStore.tick();
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

elements.trafficToggle.addEventListener("change", syncVisibleTypes);
elements.eventsToggle.addEventListener("change", syncVisibleTypes);
elements.safetyToggle.addEventListener("change", syncVisibleTypes);

setInterval(() => {
  nudgeMockSignal(0.03);
  render();
}, 4500);

renderSources();
render();
liveStore.start();

// Honest-by-construction: the panel reflects what is actually registered.
function renderSources() {
  const covered = new Set(adapters.flatMap((adapter) => adapter.kinds));
  const entries = adapters.map((adapter) => `${adapter.name} — live`);

  if (!covered.has("traffic")) entries.push("Traffic and closures — mock until a WSDOT key is set");
  if (!covered.has("event")) entries.push("Venue event windows — mock until a Ticketmaster key is set");
  entries.push("User reports and preferences — local");

  elements.sourceList.replaceChildren(
    ...entries.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

// Mock hotspots stand in only for render types no live adapter covers.
// Coverage is declared by the adapters, not inferred from whatever happens
// to be on the map — a live traffic feed reporting "no congestion" must
// still retire the fake gridlock. Retirement is per adapter, keyed on that
// adapter having connected at least once: a WSDOT key that never worked
// keeps the mock gridlock, even while the fire feed is live.
function mergedHotspots() {
  const coveredRenderTypes = new Set(
    adapters
      .filter((adapter) => state.connectedAdapterIds.has(adapter.id))
      .flatMap((adapter) => adapter.kinds.map((kind) => KIND_TO_RENDER_TYPE[kind])),
  );
  const demo = state.hotspots.filter((hotspot) => !coveredRenderTypes.has(hotspot.type));
  return [...demo, ...state.liveHotspots];
}

function render() {
  const visibleHotspots = mergedHotspots().filter((hotspot) =>
    state.visibleTypes.has(hotspot.type),
  );
  const guidance = buildRouteGuidance(routes, visibleHotspots, state.avoidZones);

  renderHeatLayer(visibleHotspots);
  renderAvoidLayer();
  renderRoutes(guidance);
  renderGuidance(guidance);
  renderAvoidList();
  renderLiveStatus();
  renderCompanion(guidance);

  elements.addAvoidButton.setAttribute("aria-pressed", String(state.addMode));
  elements.mapHint.classList.toggle("hidden", !state.addMode);
  elements.cityMap.classList.toggle("placing", state.addMode);
}

function renderCompanion(guidance) {
  elements.companion.classList.toggle("hidden", !state.companionOpen);
  elements.companionReopen.classList.toggle("hidden", state.companionOpen);

  if (!state.companionOpen) return;

  elements.companionChips.replaceChildren(
    ...routes.map((route) => {
      const chip = document.createElement("button");
      chip.type = "button";
      const selected = route.id === state.destinationRouteId;
      chip.className = `companion-chip ${selected ? "selected" : ""}`;
      const score = guidance.scoredRoutes.find((entry) => entry.route.id === route.id)?.score;
      chip.textContent = `${route.name} · ${score?.level ?? ""}`;
      chip.addEventListener("click", () => {
        // Tapping the same corridor again returns to the ambient read.
        state.destinationRouteId = selected ? null : route.id;
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

function renderHeatLayer(visibleHotspots) {
  elements.heatLayer.replaceChildren(
    ...visibleHotspots.map((hotspot) => {
      const zone = document.createElement("button");
      zone.type = "button";
      // Small live signals keep their label for hover/focus only — three dozen
      // dispatch pins with permanent labels would bury the map.
      const compact = hotspot.radius < 4 ? " compact" : "";
      zone.className = `heat-zone ${hotspot.type}${compact}`;
      zone.style.left = `${hotspot.x}%`;
      zone.style.top = `${hotspot.y}%`;
      // Scoring radius can be small; keep a visual minimum so pins stay tappable.
      const renderSize = Math.max(4, hotspot.radius * 2);
      zone.style.width = `${renderSize}%`;
      zone.style.height = `${renderSize}%`;
      zone.style.setProperty("--intensity", hotspot.intensity.toFixed(2));
      zone.setAttribute("aria-label", `${hotspot.label}. ${hotspot.detail}`);

      const label = document.createElement("span");
      label.className = "zone-label";
      label.textContent = hotspot.label;
      zone.append(label);

      return zone;
    }),
  );
}

function renderAvoidLayer() {
  elements.avoidLayer.replaceChildren(
    ...state.avoidZones.map((zone) => {
      const marker = document.createElement("div");
      marker.className = "avoid-zone";
      marker.style.left = `${zone.x}%`;
      marker.style.top = `${zone.y}%`;
      marker.style.width = `${zone.radius * 2}%`;
      marker.style.height = `${zone.radius * 2}%`;

      const label = document.createElement("span");
      label.textContent = zone.label;
      marker.append(label);

      return marker;
    }),
  );
}

function renderRoutes(guidance) {
  // The user's stated destination outranks the computed best for emphasis.
  const focusId = state.destinationRouteId ?? guidance.bestRoute.id;
  const routeLines = routes.map((route) => {
    const points = route.points.map((point) => `${point.x},${point.y}`).join(" ");
    const heat = guidance.scoredRoutes.find((entry) => entry.route.id === route.id)?.score.total ?? 0;
    const width = route.id === focusId ? 1.8 : 1.15;
    const opacity = route.id === focusId ? 0.95 : 0.6;

    return `<polyline class="route-line" data-route="${route.id}" points="${points}" stroke="${route.color}" stroke-width="${width}" opacity="${opacity}" style="--route-heat: ${heat};" />`;
  });

  elements.routeLayer.innerHTML = routeLines.join("");
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
      row.innerHTML = `<span>${zone.label}</span><small>${Math.round(zone.x)}, ${Math.round(zone.y)}</small>`;
      return row;
    }),
  );
}

function syncVisibleTypes() {
  state.visibleTypes = visibleTypesFromToggles({
    traffic: elements.trafficToggle.checked,
    events: elements.eventsToggle.checked,
    safety: elements.safetyToggle.checked,
  });

  render();
}

function nudgeMockSignal(amount = 0.08) {
  state.hotspots = state.hotspots.map((hotspot) => ({
    ...hotspot,
    intensity: clamp(hotspot.intensity + (Math.random() - 0.5) * amount, 0.35, 1),
  }));
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
