// static/js/map.esm.js
import * as THREE from "three";
import { ThreeJSOverlayView } from "@googlemaps/three";
import buildGroupFromFloors from "/static/js/house-builder.module.js";

// Read JSONs saved by your main page (localStorage approach)
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

let map, overlay;

async function initMap() {
  const { Map } = await google.maps.importLibrary("maps");

  const floors = getStoredFloors();
  window.__FLOORS__ = floors;

  map = new Map(document.getElementById("map"), {
    center: { lat: 37.421955, lng: -122.084058 },
    zoom: 19,
    tilt: 67.5,
    heading: 0,
    mapId: "9848c7c8b0244b3df052d590" // must be a vector map id
  });

  // Quick check: must be VECTOR
  if (map.getRenderingType?.() !== "VECTOR") {
    console.warn("[map] Rendering type is not VECTOR; WebGL overlays will not render.");
  }

  document.getElementById("buildOnMap").addEventListener("click", () => {
    if (!window.__FLOORS__?.length) {
      alert("No floors found. Open the main page, run inference, then click 'Open on Map'.");
      return;
    }

    const lat = parseFloat(document.getElementById("lat").value);
    const lng = parseFloat(document.getElementById("lng").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) { alert("Enter valid lat/lng"); return; }

    map.moveCamera({ center: { lat, lng }, zoom: 19, tilt: 67.5, heading: 0 });

    // Build a fresh overlay each time
    if (overlay) overlay.setMap(null);

    const built = buildGroupFromFloors(window.__FLOORS__, {
        unitPerPx: 0.01,
        floorHeight: 3.0,
        slab: 0.30,
        sill: 1.0,
        windowHeight: 1.2,
        useRoomColors: true,
        addPerimeterIfSparse: true,
        perimeterThickness: 0.18,
        perimeterCoverage: 0.30,
        debug: true
      });
    

    // Scene for the house
    const scene = new THREE.Scene();
    const house = buildHouseGroup(window.__FLOORS__);
    scene.add(house);

    house.rotation.x = Math.PI / 2;   // try this first

    // Simple lights (shadows are not supported by map)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(10, 15, 10);
    scene.add(dir);

    // Overlay keeps Three camera in sync with the map
    overlay = new ThreeJSOverlayView({
      map,
      scene,
      anchor: { lat, lng, altitude: 0 }, // origin → lat/lng
      THREE
    });

    console.log("[map] Overlay added at", { lat, lng });
  });
}

initMap();
