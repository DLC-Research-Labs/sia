const TYPE_WEIGHTS = {
  traffic: 1.1,
  event: 0.95,
  safety: 1.05,
  crowding: 0.9,
  closure: 1.2,
  personal: 1.25,
};

export function createAvoidZone(center, label = "Personal avoid", radius = 10) {
  return {
    id: `avoid-${Date.now()}-${Math.round(center.x)}-${Math.round(center.y)}`,
    label,
    type: "personal",
    x: clamp(center.x, 2, 98),
    y: clamp(center.y, 2, 98),
    radius,
    intensity: 1,
  };
}

// The scoring plane is anisotropic (a y-unit spans ~1.6x the meters of an
// x-unit for Seattle). Callers scoring real geography pass the viewport's
// planeAspect so distance is metric-honest; the abstract mock plane uses 1.
export function scoreRoute(route, hotspots = [], avoidZones = [], { aspect = 1 } = {}) {
  const hotspotImpacts = hotspots
    .map((hotspot) => scoreZoneImpact(route, hotspot, false, aspect))
    .filter(Boolean);

  const avoidImpacts = avoidZones
    .map((zone) => scoreZoneImpact(route, zone, true, aspect))
    .filter(Boolean);

  // Union accumulation, not a linear sum: each impact removes a share of the
  // corridor's remaining calm. Twelve minor dispatches must not saturate to
  // the same 100 as one hard blocker — real cities carry constant low noise.
  const remainingCalm = [...hotspotImpacts, ...avoidImpacts].reduce(
    (calm, impact) => calm * (1 - Math.min(impact.penalty, 95) / 100),
    1,
  );
  const total = Math.min(100, Math.round(100 * (1 - remainingCalm)));

  return {
    routeId: route.id,
    routeName: route.name,
    total,
    level: scoreLevel(total),
    incidentCount: hotspotImpacts.length,
    avoidCount: avoidImpacts.length,
    impacts: [...hotspotImpacts, ...avoidImpacts].sort((a, b) => b.penalty - a.penalty),
  };
}

export function buildRouteGuidance(routes, hotspots = [], avoidZones = [], opts = {}) {
  const scoredRoutes = routes
    .map((route) => ({
      route,
      score: scoreRoute(route, hotspots, avoidZones, opts),
    }))
    .sort((a, b) => a.score.total - b.score.total);

  const best = scoredRoutes[0];
  const worst = scoredRoutes[scoredRoutes.length - 1];

  return {
    bestRoute: best.route,
    worstRoute: worst.route,
    scoredRoutes,
    summary: `${best.route.name} looks calmer right now (${best.score.total}/100 city heat). ${summarizeReason(best.score)}`,
    alternatives: scoredRoutes.slice(1).map(({ route, score }) => ({
      routeId: route.id,
      summary: `${route.name} is ${score.level} (${score.total}/100) because ${summarizeReason(score).toLowerCase()}`,
    })),
  };
}

// Companion answer for "where are we going?" — the user names a corridor and
// gets a focused read on it, always with the calmer alternative if one exists.
export function buildFocusedGuidance(routeId, guidance) {
  const entry = guidance.scoredRoutes.find(({ route }) => route.id === routeId);
  if (!entry) return null;

  const best = guidance.scoredRoutes[0];
  const { route, score } = entry;

  if (route.id === best.route.id) {
    return {
      routeId: route.id,
      title: route.label,
      summary: `Good call — ${route.name} is the calm way in right now (${score.total}/100 city heat). ${summarizeReason(score)}`,
    };
  }

  return {
    routeId: route.id,
    title: `${route.name} is ${score.level}`,
    summary: `${route.name} is running ${score.level} (${score.total}/100 city heat). ${summarizeReason(score)} ${best.route.name} is calmer if you have the option.`,
  };
}

function scoreZoneImpact(route, zone, isAvoidZone, aspect = 1) {
  // Line/polygon signals carry a projected path: measure the corridor's nearest
  // approach to that path, not to a single collapsed center (else a long
  // closure blankets corridors it never touches).
  const distance = zone.path
    ? polylinesMinDistance(route.points, zone.path, aspect)
    : distanceToRoute(route.points, zone, aspect);
  const influenceRadius = zone.radius * 1.35;

  if (distance > influenceRadius) {
    return null;
  }

  // Rubric anchor (contract §5): 0.25 means "noticeable; wouldn't change your
  // route" — routing pressure ramps from there, not from zero. Personal avoid
  // zones are exempt: the user already decided they matter.
  const effectiveIntensity = isAvoidZone
    ? zone.intensity
    : Math.max(0, (zone.intensity - 0.25) / 0.75);

  // A zero-effect signal is not a "main pressure" — drop it so it neither
  // counts nor gets named as the reason on an otherwise-calm corridor.
  if (effectiveIntensity === 0) {
    return null;
  }

  const proximity = 1 - distance / influenceRadius;
  // Personal avoid zones match auto signals' base + reach and carry the highest
  // type weight, so the user's own call out-muscles an automatic dispatch.
  const base = 65;
  const typeWeight = TYPE_WEIGHTS[zone.type] ?? 1;
  const penalty = effectiveIntensity * base * typeWeight * (0.15 + proximity);

  return {
    id: zone.id,
    label: zone.label,
    type: zone.type,
    penalty,
    distance,
  };
}

function summarizeReason(score) {
  if (score.impacts.length === 0) {
    return "No major hotspots touch this corridor.";
  }

  const topImpact = score.impacts[0];
  const signalText = score.incidentCount === 1 ? "1 signal" : `${score.incidentCount} signals`;
  const zoneWord = score.avoidCount === 1 ? "zone" : "zones";
  const avoidText = score.avoidCount > 0 ? ` and ${score.avoidCount} personal avoid ${zoneWord}` : "";

  return `Main pressure is ${topImpact.label}, with ${signalText}${avoidText} on this corridor.`;
}

function scoreLevel(score) {
  if (score >= 72) return "hot";
  if (score >= 44) return "busy";
  if (score >= 20) return "watchful";
  return "calm";
}

// All distance math runs in "scaled space": y is multiplied by aspect so both
// axes carry equal real meters, making plain Euclidean distance metric-honest.
function scaled(point, aspect) {
  return { x: point.x, y: point.y * aspect };
}

function distanceToRoute(points, target, aspect = 1) {
  const t = scaled(target, aspect);
  if (points.length === 1) {
    return distance(scaled(points[0], aspect), t);
  }

  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i += 1) {
    shortest = Math.min(shortest, pointToSegment(t, scaled(points[i], aspect), scaled(points[i + 1], aspect)));
  }
  return shortest;
}

// Nearest approach between two polylines (corridor and a line signal), in
// scaled space: min over every segment pair, 0 if any pair crosses.
function polylinesMinDistance(pointsA, pointsB, aspect = 1) {
  const a = pointsA.map((p) => scaled(p, aspect));
  const b = pointsB.map((p) => scaled(p, aspect));
  let shortest = Number.POSITIVE_INFINITY;

  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < b.length - 1; j += 1) {
      shortest = Math.min(shortest, segmentToSegment(a[i], a[i + 1], b[j], b[j + 1]));
      if (shortest === 0) return 0;
    }
  }
  return shortest;
}

function pointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return distance(point, start);
  }

  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function segmentToSegment(p1, p2, p3, p4) {
  if (segmentsIntersect(p1, p2, p3, p4)) return 0;
  return Math.min(
    pointToSegment(p1, p3, p4),
    pointToSegment(p2, p3, p4),
    pointToSegment(p3, p1, p2),
    pointToSegment(p4, p1, p2),
  );
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
