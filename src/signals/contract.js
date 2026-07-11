// City Signal adapter contract v0.1 — machine-readable companion to
// docs/city-signal-adapter-contract.md. Dependency-free by design.

export const SIGNAL_KINDS = [
  "traffic",
  "closure",
  "event",
  "crowding",
  "commotion",
  "safety",
  "civic",
  "report",
];

export const GEOMETRY_TYPES = ["point", "polyline", "polygon"];

// Default TTLs in minutes, applied when a source gives no endsAt (§5 of the doc).
export const DEFAULT_TTL_MINUTES = {
  traffic: 15,
  crowding: 30,
  commotion: 45,
  safety: 120,
  event: 30, // added after endsAt
  closure: 24 * 60, // when unbounded
  civic: 7 * 24 * 60,
  report: 60,
};

// Render-plane mapping for kinds the stylesheet doesn't know yet (§6).
export const KIND_TO_RENDER_TYPE = {
  traffic: "traffic",
  closure: "closure",
  event: "event",
  crowding: "crowding",
  commotion: "safety",
  safety: "safety",
  civic: "crowding",
  report: "crowding",
};

const MAX_RAW_BYTES = 8 * 1024;
const MAX_LABEL_LENGTH = 60;

/**
 * @typedef {Object} SignalGeometry
 * @property {"point"|"polyline"|"polygon"} type
 * @property {Array} coordinates GeoJSON order: [lng, lat]; nested for line/polygon.
 * @property {number} [radiusM] Required for point geometry; influence radius in meters.
 */

/**
 * @typedef {Object} CitySignal
 * @property {string} id Always `${source}:${sourceId}`.
 * @property {string} source Adapter id.
 * @property {string} sourceId Stable id within the source; upsert key with source.
 * @property {string} kind One of SIGNAL_KINDS.
 * @property {string} [subkind] Source-specific refinement, lowercase snake_case.
 * @property {string} label Human map-pin text, present tense, ≤ 60 chars.
 * @property {string} [detail] One human sentence.
 * @property {SignalGeometry} geometry WGS84 only — never render-plane x/y.
 * @property {number} intensity 0..1 per the shared rubric.
 * @property {number} confidence 0..1 source believability.
 * @property {string} observedAt ISO 8601 UTC.
 * @property {string} [startsAt]
 * @property {string} [endsAt]
 * @property {string} expiresAt Required — every signal decays off the map.
 * @property {number} [reportCount]
 * @property {string} [url]
 * @property {Object} [raw] Debug payload, ≤ 8 KB serialized.
 */

/**
 * Validate one candidate signal. Never throws; returns { ok, errors }.
 * Batch callers drop invalid records and report counts (§1 rule 5).
 *
 * @param {*} signal
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSignal(signal) {
  const errors = [];

  if (!signal || typeof signal !== "object") {
    return { ok: false, errors: ["signal is not an object"] };
  }

  for (const field of ["source", "sourceId", "kind", "label"]) {
    if (typeof signal[field] !== "string" || signal[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (typeof signal.source === "string" && typeof signal.sourceId === "string") {
    const expectedId = `${signal.source}:${signal.sourceId}`;
    if (signal.id !== expectedId) {
      errors.push(`id must be "${expectedId}"`);
    }
  }

  if (!SIGNAL_KINDS.includes(signal.kind)) {
    errors.push(`kind must be one of ${SIGNAL_KINDS.join(", ")}`);
  }

  if (typeof signal.label === "string" && signal.label.length > MAX_LABEL_LENGTH) {
    errors.push(`label exceeds ${MAX_LABEL_LENGTH} chars`);
  }

  errors.push(...validateGeometry(signal.geometry));

  for (const field of ["intensity", "confidence"]) {
    const value = signal[field];
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      errors.push(`${field} must be a number in 0..1`);
    }
  }

  for (const field of ["observedAt", "expiresAt"]) {
    if (!isIsoTimestamp(signal[field])) {
      errors.push(`${field} must be an ISO 8601 timestamp`);
    }
  }

  for (const field of ["startsAt", "endsAt"]) {
    if (signal[field] !== undefined && !isIsoTimestamp(signal[field])) {
      errors.push(`${field} must be an ISO 8601 timestamp when present`);
    }
  }

  if (signal.raw !== undefined) {
    try {
      if (JSON.stringify(signal.raw).length > MAX_RAW_BYTES) {
        errors.push(`raw exceeds ${MAX_RAW_BYTES} bytes serialized`);
      }
    } catch {
      errors.push("raw is not serializable");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a batch, splitting valid from rejected (§1 rule 5).
 *
 * @param {Array} signals
 * @returns {{ valid: CitySignal[], rejected: Array<{ signal: *, errors: string[] }> }}
 */
export function validateBatch(signals) {
  const valid = [];
  const rejected = [];

  for (const signal of signals) {
    const result = validateSignal(signal);
    if (result.ok) {
      valid.push(signal);
    } else {
      rejected.push({ signal, errors: result.errors });
    }
  }

  return { valid, rejected };
}

/**
 * Project a CitySignal onto the prototype's 0–100 render plane (§6).
 * Returns null when the signal's center falls outside the viewport.
 *
 * @param {CitySignal} signal
 * @param {{ west: number, south: number, east: number, north: number }} viewport WGS84 bbox.
 * @returns {{ id, label, type, x, y, radius, intensity, detail }|null}
 */
// A closure/event line matters within this band of its actual segment (the
// feed gives no width). Point signals keep their own radiusM.
const LINE_INFLUENCE_BAND_M = 400;

export function toHotspot(signal, viewport) {
  const center = geometryCenter(signal.geometry);
  const { x, y } = projectToPlane([center.lng, center.lat], viewport);

  if (x < 0 || x > 100 || y < 0 || y > 100) {
    return null;
  }

  const metersPerUnit = ewMetersPerPlaneUnit(viewport);
  const isLine = signal.geometry.type !== "point";
  const radiusM = isLine ? LINE_INFLUENCE_BAND_M : signal.geometry.radiusM;
  // Tiny floor only to avoid a zero-radius disc; the mock renderer applies its
  // own visual minimum so scoring keeps the adapter's real severity tiers.
  const radius = Math.max(0.5, radiusM / metersPerUnit);

  const hotspot = {
    id: signal.id,
    label: signal.label,
    type: KIND_TO_RENDER_TYPE[signal.kind],
    x,
    y,
    radius,
    intensity: signal.intensity,
    detail: signal.detail ?? "",
  };

  // Line/polygon signals carry their projected path so the scorer measures
  // segment-to-corridor distance instead of collapsing to a bounding disc.
  if (isLine) {
    const ring =
      signal.geometry.type === "polygon"
        ? signal.geometry.coordinates[0]
        : signal.geometry.coordinates;
    hotspot.path = ring.map((coord) => projectToPlane(coord, viewport));
  }

  return hotspot;
}

/**
 * Project a WGS84 [lng, lat] onto the 0–100 scoring plane for a viewport.
 * Shared by toHotspot and anything (corridors, avoid zones) that needs to
 * feed domain.js while rendering real geography elsewhere.
 */
export function projectToPlane([lng, lat], viewport) {
  return {
    x: ((lng - viewport.west) / (viewport.east - viewport.west)) * 100,
    y: ((viewport.north - lat) / (viewport.north - viewport.south)) * 100,
  };
}

function ewMetersPerPlaneUnit(viewport) {
  const midLat = (viewport.north + viewport.south) / 2;
  return ((viewport.east - viewport.west) * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 100;
}

/**
 * The plane squashes a non-square bbox, so a north-south unit spans more real
 * meters than an east-west one. This ratio (~1.6 for Seattle) lets the scorer
 * treat the plane isotropically: scale y by it before any distance math.
 */
export function planeAspect(viewport) {
  const nsMetersPerUnit = ((viewport.north - viewport.south) * 111_320) / 100;
  return nsMetersPerUnit / ewMetersPerPlaneUnit(viewport);
}

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return ["geometry is required"];
  }

  if (!GEOMETRY_TYPES.includes(geometry.type)) {
    return [`geometry.type must be one of ${GEOMETRY_TYPES.join(", ")}`];
  }

  const errors = [];

  if (geometry.type === "point") {
    if (!isLngLat(geometry.coordinates)) {
      errors.push("point coordinates must be [lng, lat]");
    }
    if (typeof geometry.radiusM !== "number" || geometry.radiusM <= 0) {
      errors.push("point geometry requires radiusM > 0");
    }
  } else {
    const ring = geometry.type === "polygon" ? geometry.coordinates?.[0] : geometry.coordinates;
    if (!Array.isArray(ring) || ring.length < 2 || !ring.every(isLngLat)) {
      errors.push(`${geometry.type} coordinates must be an array of [lng, lat] pairs`);
    }
  }

  return errors;
}

function geometryCenter(geometry) {
  if (geometry.type === "point") {
    return { lng: geometry.coordinates[0], lat: geometry.coordinates[1] };
  }

  const raw = geometry.type === "polygon" ? geometry.coordinates[0] : geometry.coordinates;
  // A closed GeoJSON ring repeats its first vertex last; averaging both would
  // pull the centroid toward it. Drop the duplicate closing vertex.
  const [firstLng, firstLat] = raw[0];
  const last = raw[raw.length - 1];
  const ring = raw.length > 1 && last[0] === firstLng && last[1] === firstLat ? raw.slice(0, -1) : raw;
  const sum = ring.reduce((acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }), {
    lng: 0,
    lat: 0,
  });

  return { lng: sum.lng / ring.length, lat: sum.lat / ring.length };
}

function geometryRadiusM(geometry, center) {
  if (geometry.type === "point") {
    return geometry.radiusM;
  }

  const ring = geometry.type === "polygon" ? geometry.coordinates[0] : geometry.coordinates;
  const metersPerDegLng = 111_320 * Math.cos((center.lat * Math.PI) / 180);

  return ring.reduce((max, [lng, lat]) => {
    const dx = (lng - center.lng) * metersPerDegLng;
    const dy = (lat - center.lat) * 111_320;
    return Math.max(max, Math.hypot(dx, dy));
  }, 0);
}

function isLngLat(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number" && !Number.isNaN(n)) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
