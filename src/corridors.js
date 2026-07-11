// Real Seattle corridors for the MapLibre spike — three north–south commute
// spines through the SEATTLE_VIEWPORT, in WGS84. Geometry is deliberately
// coarse (a handful of vertices): these are corridors to read, not routes to
// follow. domain.js scores them after projection onto the 0–100 plane.

import { projectToPlane } from "./signals/contract.js";

export const CORRIDORS = [
  {
    id: "aurora",
    name: "Aurora / SR 99",
    label: "Calmer along Aurora",
    color: "#168c7f",
    coords: [
      [-122.339, 47.5],
      [-122.343, 47.545],
      [-122.349, 47.6],
      [-122.347, 47.635],
      [-122.345, 47.68],
      [-122.344, 47.73],
    ],
  },
  {
    id: "i5",
    name: "I-5 spine",
    label: "Direct but exposed on I-5",
    color: "#d84f2a",
    coords: [
      [-122.32, 47.49],
      [-122.318, 47.54],
      [-122.329, 47.6],
      [-122.324, 47.645],
      [-122.322, 47.69],
      [-122.325, 47.73],
    ],
  },
  {
    id: "eastside",
    name: "East surface streets",
    label: "Longer eastside weave",
    color: "#5967c9",
    coords: [
      [-122.27, 47.5],
      [-122.288, 47.55],
      [-122.302, 47.59],
      [-122.302, 47.63],
      [-122.31, 47.67],
      [-122.317, 47.71],
    ],
  },
];

// domain.js-ready shape: same corridors with plane-projected points.
export function corridorsForScoring(viewport) {
  return CORRIDORS.map((corridor) => ({
    ...corridor,
    points: corridor.coords.map((coord) => projectToPlane(coord, viewport)),
  }));
}
