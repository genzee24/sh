// static/js/map.js
import * as THREE from "three";
import buildGroupFromFloors from "/static/js/house-builder.module.js";

// Use Google's official wrapper for WebGLOverlayView + three.js
// (ES module served by unpkg)
import { ThreeJSOverlayView } from "@googlemaps/three";

let map, overlay;

function getStoredFloors() {
  try {
    const stored = localStorage.getItem("floors_payload");
    const arr = stored ? JSON.parse(stored) : [];
    console.log("[map] floors_payload:", Array.isArray(arr) ? arr.length : 0);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn("[map] failed to parse floors_payload", e);
    return [];
  }
}

function buildHouseGroup(floors) {
  // Build your THREE.Group from the floor JSONs
  const { group } = buildGroupFromFloors(floors || [], {
    unitPerPx: 0.01,
    floorHeight: 3.0,
    slab: 0.30,
    sill: 1.0,
    windowHeight: 1.2,
    useRoomColors: true,
    addPerimeterIfSparse: true,
    perimeterThickness: 0.18,
    perimeterCoverage: 0.30
  });
  return group;
}

async function initMap() {
  // Load the Maps library (async best-practice)
  const { Map } = await google.maps.importLibrary("maps");

  // Read floor JSONs saved by your main page
  const floors = getStoredFloors();
  window.__FLOORS__ = floors;

  // Create a VECTOR map (must use your vector Map ID here)
  map = new Map(document.getElementById("map"), {
    center: { lat: 37.421955, lng: -122.084058 },
    zoom: 19,
    tilt: 67.5,
    heading: 0,
    mapId: "9848c7c8b0244b3df052d590" // <-- make sure this is a vector style
  });

  // Helpful runtime check
  if (map.getRenderingType && map.getRenderingType() !== "VECTOR") {
    console.warn(
      "[map] Rendering type is not VECTOR; WebGL overlays will not render."
    );
  }

  // Button wiring
  document.getElementById("buildOnMap").addEventListener("click", () => {
    if (!window.__FLOORS__ || !window.__FLOORS__.length) {
      alert("No floors found. Open the main page, run inference, then click 'Open on Map'.");
      return;
    }

    const lat = parseFloat(document.getElementById("lat").value);
    const lng = parseFloat(document.getElementById("lng").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      alert("Enter valid lat/lng");
      return;
    }

    // Smoothly fly the camera there
    map.moveCamera({ center: { lat, lng }, zoom: 19, tilt: 67.5, heading: 0 });

    // (Re)build overlay
    if (overlay) overlay.setMap(null);

    // Create a scene and add your house group at the origin.
    // The overlay’s 'anchor' will georeference the origin to the given lat/lng.
    const scene = new THREE.Scene();

    const house = buildHouseGroup(window.__FLOORS__);
    // Keep group centered at (0,0,0); wrapper anchors the origin to lat/lng.
    scene.add(house);

    // Lights (simple, cheap)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(10, 15, 10);
    scene.add(dir);

    // Create ThreeJSOverlayView that handles camera/projection for you
    overlay = new ThreeJSOverlayView({
      map,
      scene,
      anchor: { lat, lng, altitude: 0 }, // place origin at lat/lng
      THREE
    });

    console.log("[map] Overlay added at", { lat, lng });
  });
}

// Kick off initialization
initMap();
