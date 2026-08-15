import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

const TILE_SIZE = 256;

// ---------- logging ----------
const logEl = document.getElementById("log");
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- map + rectangle selection ----------
const DEFAULT_CENTER = [39.7555, -105.2211]; // Golden, CO
const map = L.map("map").setView(DEFAULT_CENTER, 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const generateBtn = document.getElementById("generateBtn");

// A "grid" is a rows x cols set of square tiles, each sizeKm on a side, extending
// south/east from a single click point (the NW corner of the top-left tile).
let clickTopLeft = null;
let currentGrid = null;

function kmToDegLat(km) {
  return km / 110.54;
}
function kmToDegLon(km, atLatDeg) {
  return km / (111.32 * Math.cos((atLatDeg * Math.PI) / 180));
}

function computeGrid(topLeft, rows, cols, sizeKm) {
  const dLat = kmToDegLat(sizeKm);
  const dLon = kmToDegLon(sizeKm, topLeft.lat);
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const n = topLeft.lat - row * dLat;
      const s = topLeft.lat - (row + 1) * dLat;
      const w = topLeft.lng + col * dLon;
      const e = topLeft.lng + (col + 1) * dLon;
      cells.push({ row, col, bounds: L.latLngBounds([s, w], [n, e]) });
    }
  }
  const overallBounds = L.latLngBounds(
    [topLeft.lat - rows * dLat, topLeft.lng],
    [topLeft.lat, topLeft.lng + cols * dLon]
  );
  return { cells, overallBounds, rows, cols, sizeKm, topLeft };
}

function renderGridPreview() {
  if (!clickTopLeft) return;
  const sizeKm = parseFloat(document.getElementById("squareSideKm").value) || 7;
  const rows = Math.max(1, parseInt(document.getElementById("gridRows").value, 10) || 1);
  const cols = Math.max(1, parseInt(document.getElementById("gridCols").value, 10) || 1);
  currentGrid = computeGrid(clickTopLeft, rows, cols, sizeKm);

  drawnItems.clearLayers();
  drawnItems.addLayer(L.rectangle(currentGrid.overallBounds, { color: "#4f8cff", weight: 2 }));
  for (let r = 1; r < rows; r++) {
    const lat = clickTopLeft.lat - r * kmToDegLat(sizeKm);
    drawnItems.addLayer(
      L.polyline(
        [[lat, currentGrid.overallBounds.getWest()], [lat, currentGrid.overallBounds.getEast()]],
        { color: "#4f8cff", weight: 1, opacity: 0.6 }
      )
    );
  }
  for (let c = 1; c < cols; c++) {
    const lng = clickTopLeft.lng + c * kmToDegLon(sizeKm, clickTopLeft.lat);
    drawnItems.addLayer(
      L.polyline(
        [[currentGrid.overallBounds.getNorth(), lng], [currentGrid.overallBounds.getSouth(), lng]],
        { color: "#4f8cff", weight: 1, opacity: 0.6 }
      )
    );
  }

  document.getElementById("bN").value = clickTopLeft.lat.toFixed(5);
  document.getElementById("bW").value = clickTopLeft.lng.toFixed(5);
  document.getElementById("bboxHint").textContent = "Area selected. Adjust settings and generate.";
  const n = rows * cols;
  document.getElementById("tileCountHint").textContent =
    n === 1 ? "1 tile will be generated." : `${n} tiles (${rows}×${cols}) will be generated and bundled into a ZIP.`;
  generateBtn.disabled = false;
}

map.on("click", (e) => {
  clickTopLeft = e.latlng;
  renderGridPreview();
});

for (const id of ["squareSideKm", "gridRows", "gridCols"]) {
  document.getElementById(id).addEventListener("change", renderGridPreview);
}

clickTopLeft = L.latLng(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
renderGridPreview();

// ---------- sidebar wiring ----------
const mapboxTokenRow = document.getElementById("mapboxTokenRow");
const flattenLakesCheckbox = document.getElementById("flattenLakes");
const waterSection = document.getElementById("waterSection");

function applyElevSourceUI(source) {
  mapboxTokenRow.style.display = source === "mapbox" ? "block" : "none";
  waterSection.style.display = source === "usgs3dep" ? "none" : "block";
  flattenLakesCheckbox.checked = source !== "usgs3dep";
}

for (const radio of document.querySelectorAll('input[name="elevSource"]')) {
  radio.addEventListener("change", () => {
    if (radio.checked) applyElevSourceUI(radio.value);
  });
}
applyElevSourceUI(document.querySelector('input[name="elevSource"]:checked').value);

const gridResInput = document.getElementById("gridRes");
const gridResVal = document.getElementById("gridResVal");
gridResInput.addEventListener("input", () => (gridResVal.textContent = gridResInput.value));

const exagInput = document.getElementById("exag");
const exagVal = document.getElementById("exagVal");
exagInput.addEventListener("input", () => (exagVal.textContent = `${exagInput.value}x`));

// ---------- three.js preview ----------
const previewEl = document.getElementById("preview");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const camera = new THREE.PerspectiveCamera(45, previewEl.clientWidth / previewEl.clientHeight, 0.1, 5000);
camera.position.set(120, -180, 140);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(previewEl.clientWidth, previewEl.clientHeight);
previewEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(100, -100, 200);
scene.add(sun);

let currentMeshGroup = null;

function fitCameraToMesh(mesh, topDown = false) {
  const box = new THREE.Box3().setFromObject(mesh);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const radius = sphere.radius || 1;

  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitFov = Math.min(vFov, hFov);
  const distance = (radius / Math.sin(fitFov / 2)) * 1.25;

  const dir = topDown
    ? new THREE.Vector3(0.3, -0.3, 1).normalize() // steep but stable (avoids OrbitControls gimbal lock at true vertical)
    : new THREE.Vector3(0.8, -1.2, 0.9).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  controls.target.copy(center);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 4 + radius * 4;
  camera.updateProjectionMatrix();
  controls.update();
}

document.getElementById("topDownView").addEventListener("change", (e) => {
  if (currentMeshGroup) fitCameraToMesh(currentMeshGroup, e.target.checked || document.getElementById("debugRaiseLakes").checked);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

new ResizeObserver(() => {
  camera.aspect = previewEl.clientWidth / previewEl.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(previewEl.clientWidth, previewEl.clientHeight);
}).observe(previewEl);

new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("map"));

// ---------- tile math ----------
function lon2worldX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * TILE_SIZE;
}
function lat2worldY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z) * TILE_SIZE;
}

function tileRangeForBounds(bounds, z) {
  const minWX = lon2worldX(bounds.getWest(), z);
  const maxWX = lon2worldX(bounds.getEast(), z);
  const minWY = lat2worldY(bounds.getNorth(), z);
  const maxWY = lat2worldY(bounds.getSouth(), z);
  return {
    minTileX: Math.floor(minWX / TILE_SIZE),
    maxTileX: Math.floor(maxWX / TILE_SIZE),
    minTileY: Math.floor(minWY / TILE_SIZE),
    maxTileY: Math.floor(maxWY / TILE_SIZE),
  };
}

function pickZoom(bounds, maxTiles) {
  for (let z = 14; z >= 6; z--) {
    const r = tileRangeForBounds(bounds, z);
    const nx = r.maxTileX - r.minTileX + 1;
    const ny = r.maxTileY - r.minTileY + 1;
    if (nx * ny <= maxTiles) return z;
  }
  return 6;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile: ${url}`));
    img.src = url;
  });
}

// AWS open terrain tiles use the "terrarium" RGB encoding; Mapbox uses its own.
function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}
function decodeMapboxTerrainRGB(r, g, b) {
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

// Shared across every cell in a grid generation run: neighboring tiles very often
// reuse the same underlying source tile (PNG tile or USGS GeoTIFF), so caching by
// key here avoids redundant re-fetches instead of every cell fetching from scratch.
const pngTileCache = new Map(); // key: "aws|mb_z_x_y" -> Promise<Float32Array>

function fetchTile(z, x, y, mapboxToken) {
  const cacheKey = `${mapboxToken ? "mb" : "aws"}_${z}_${x}_${y}`;
  if (pngTileCache.has(cacheKey)) return pngTileCache.get(cacheKey);
  const promise = (async () => {
    const url = mapboxToken
      ? `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${encodeURIComponent(mapboxToken)}`
      : `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
    const decode = mapboxToken ? decodeMapboxTerrainRGB : decodeTerrarium;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      elev[i] = decode(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    return elev;
  })();
  promise.catch(() => pngTileCache.delete(cacheKey)); // don't cache a failure
  pngTileCache.set(cacheKey, promise);
  return promise;
}

async function fetchElevationContext(bounds, mapboxToken) {
  const z = pickZoom(bounds, 64);
  const range = tileRangeForBounds(bounds, z);
  const tiles = new Map();
  const jobs = [];
  for (let tx = range.minTileX; tx <= range.maxTileX; tx++) {
    for (let ty = range.minTileY; ty <= range.maxTileY; ty++) {
      jobs.push(
        fetchTile(z, tx, ty, mapboxToken).then((elev) => tiles.set(`${tx}_${ty}`, elev))
      );
    }
  }
  await Promise.all(jobs);
  return { z, tiles };
}

function sampleElevation(lon, lat, ctx) {
  const wx = lon2worldX(lon, ctx.z);
  const wy = lat2worldY(lat, ctx.z);
  const tx = Math.floor(wx / TILE_SIZE);
  const ty = Math.floor(wy / TILE_SIZE);
  const tile = ctx.tiles.get(`${tx}_${ty}`);
  if (!tile) return 0;
  let px = wx - tx * TILE_SIZE;
  let py = wy - ty * TILE_SIZE;
  px = Math.min(Math.max(px, 0), TILE_SIZE - 1.001);
  py = Math.min(Math.max(py, 0), TILE_SIZE - 1.001);
  const x0 = Math.floor(px), y0 = Math.floor(py), x1 = x0 + 1, y1 = y0 + 1;
  const fx = px - x0, fy = py - y0;
  const at = (xx, yy) => tile[yy * TILE_SIZE + xx];
  const v00 = at(x0, y0), v10 = at(x1, y0), v01 = at(x0, y1), v11 = at(x1, y1);
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

// ---------- USGS 3DEP (1/3 arc-second, hydro-flattened, US only) ----------
// Tiles are named by their NW corner, e.g. 39-40N/105-106W -> "n40w106".
function usgs3depTileUrl(latBand, lonBand) {
  const n = latBand + 1;
  const w = -lonBand;
  const name = `n${n}w${String(w).padStart(3, "0")}`;
  return { name, url: `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/${name}/USGS_13_${name}.tif` };
}

// Each GeoTIFF handle is cheap (lazy remote source; readRasters only fetches the
// byte range it needs), but opening+parsing one still costs a round trip - worth
// sharing across every grid cell that happens to fall in the same 1-degree tile.
const usgsTiffCache = new Map(); // key: tile name -> Promise<GeoTIFF>

function getUsgsTiff(name, url) {
  if (!usgsTiffCache.has(name)) {
    const promise = window.GeoTIFF.fromUrl(url);
    promise.catch(() => usgsTiffCache.delete(name));
    usgsTiffCache.set(name, promise);
  }
  return usgsTiffCache.get(name);
}

async function buildUsgs3depSampler(bounds, gridRes) {
  const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
  const latBandMin = Math.floor(south), latBandMax = Math.floor(north - 1e-9);
  const lonBandMin = Math.floor(west), lonBandMax = Math.floor(east - 1e-9);

  const tileRasters = [];
  const jobs = [];
  for (let latBand = latBandMin; latBand <= latBandMax; latBand++) {
    for (let lonBand = lonBandMin; lonBand <= lonBandMax; lonBand++) {
      if (lonBand >= 0 || latBand < 15 || latBand > 71) {
        log(`Skipping ${latBand}/${lonBand}: outside USGS 3DEP coverage (western hemisphere, roughly 15-71N only).`);
        continue;
      }
      const { name, url } = usgs3depTileUrl(latBand, lonBand);
      const ovW = Math.max(west, lonBand), ovE = Math.min(east, lonBand + 1);
      const ovS = Math.max(south, latBand), ovN = Math.min(north, latBand + 1);
      if (ovW >= ovE || ovS >= ovN) continue;
      const outW = Math.max(2, Math.round(gridRes * ((ovE - ovW) / (east - west))));
      const outH = Math.max(2, Math.round(gridRes * ((ovN - ovS) / (north - south))));
      jobs.push(
        getUsgsTiff(name, url)
          .then((tiff) => tiff.readRasters({ bbox: [ovW, ovS, ovE, ovN], width: outW, height: outH, resampleMethod: "bilinear" }))
          .then((rasters) => {
            tileRasters.push({ data: rasters[0], width: rasters.width, height: rasters.height, west: ovW, east: ovE, south: ovS, north: ovN });
          })
          .catch(() => log(`No USGS 3DEP coverage for tile ${name} — skipping.`))
      );
    }
  }
  await Promise.all(jobs);

  if (tileRasters.length === 0) {
    throw new Error("No USGS 3DEP coverage in this area (likely outside the continental US). Switch elevation source to AWS Terrain Tiles or Mapbox.");
  }

  return (lon, lat) => {
    for (const t of tileRasters) {
      if (lon < t.west || lon > t.east || lat < t.south || lat > t.north) continue;
      const px = ((lon - t.west) / (t.east - t.west)) * (t.width - 1);
      const py = ((t.north - lat) / (t.north - t.south)) * (t.height - 1);
      const x0 = Math.floor(Math.min(Math.max(px, 0), t.width - 1.001));
      const y0 = Math.floor(Math.min(Math.max(py, 0), t.height - 1.001));
      const x1 = x0 + 1, y1 = y0 + 1;
      const fx = px - x0, fy = py - y0;
      const at = (xx, yy) => t.data[yy * t.width + xx];
      return at(x0, y0) * (1 - fx) * (1 - fy) + at(x1, y0) * fx * (1 - fy) + at(x0, y1) * (1 - fx) * fy + at(x1, y1) * fx * fy;
    }
    return 0;
  };
}

async function buildElevationSampler(bounds, source, mapboxToken, gridRes) {
  if (source === "usgs3dep") return buildUsgs3depSampler(bounds, gridRes);
  const ctx = await fetchElevationContext(bounds, source === "mapbox" ? mapboxToken : null);
  return (lon, lat) => sampleElevation(lon, lat, ctx);
}

// ---------- water bodies (OpenStreetMap Overpass) ----------
async function fetchWaterPolygons(bounds) {
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
  const query = `[out:json][timeout:120];(way["natural"="water"](${s},${w},${n},${e});relation["natural"="water"]["type"="multipolygon"](${s},${w},${n},${e}););out geom;`;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!resp.ok) throw new Error(`Overpass query failed: HTTP ${resp.status}`);
  const json = await resp.json();
  const isClosed = (geom) => {
    const first = geom[0], last = geom[geom.length - 1];
    return Math.abs(first.lon - last.lon) < 1e-9 && Math.abs(first.lat - last.lat) < 1e-9;
  };

  const rings = [];
  for (const el of json.elements) {
    if (el.type === "way" && el.geometry && el.geometry.length > 3 && isClosed(el.geometry)) {
      rings.push(el.geometry.map((pt) => [pt.lon, pt.lat]));
    } else if (el.type === "relation" && el.members) {
      // Multipolygon lakes (e.g. Bear Lake in RMNP) split their outer boundary across
      // several member ways; Overpass returns them in ring order, so concatenating works.
      const outerPts = el.members
        .filter((m) => m.role === "outer" && m.geometry)
        .flatMap((m) => m.geometry.map((pt) => [pt.lon, pt.lat]));
      if (outerPts.length > 3) rings.push(outerPts);
    }
  }

  return rings.map((ring) => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { ring, minLon, maxLon, minLat, maxLat };
  });
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findLakeIndex(lon, lat, polys) {
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    if (lon < p.minLon || lon > p.maxLon || lat < p.minLat || lat > p.maxLat) continue;
    if (pointInRing(lon, lat, p.ring)) return i;
  }
  return -1;
}

// Bands: array of { color: THREE.Color, max: number }, sorted ascending, last max=Infinity.
function colorForElevation(elev, bands) {
  for (const b of bands) if (elev <= b.max) return b.color;
  return bands[bands.length - 1].color;
}

// ---------- geometry: heightmap grid -> solid mesh ----------
// opts: tileSizeM (real-world meters per side, same for every tile in a grid),
// modelWidthMM (printed mm per side), exaggeration, baseThicknessMM (minimum, for
// whichever tile touches minElev), minElev (elevation reference - pass a grid-wide
// minimum so multiple tiles share one base plane and stay assemblable), colorBands
// (optional - when set, builds a per-vertex color attribute for the live preview;
// this has no effect on the exported STL, which has no standard color support).
function buildSolidGeometry(elevGrid, gridRes, opts) {
  const scaleXY = opts.modelWidthMM / opts.tileSizeM;
  const widthMM = opts.modelWidthMM;
  const heightMM = opts.modelWidthMM;
  const zScale = scaleXY * opts.exaggeration;
  const minElev = opts.minElev;
  const colorBands = opts.colorBands || null;

  const xAt = (gx) => (gx / (gridRes - 1)) * widthMM - widthMM / 2;
  const yAt = (gy) => ((gridRes - 1 - gy) / (gridRes - 1)) * heightMM - heightMM / 2;
  // Z=0 sits at the base's underside (the conventional origin for printable meshes) so
  // slicer features that key off raw mesh height - like Bambu Studio's height-range
  // filament changes - line up correctly regardless of whether they normalize Z or not.
  const zTopAt = (gx, gy) => opts.baseThicknessMM + (elevGrid[gy * gridRes + gx] - minElev) * zScale;
  const zBase = 0;

  const positions = [];
  const colors = colorBands ? [] : null;
  const indices = [];
  const idxTop = (gx, gy) => gy * gridRes + gx;

  for (let gy = 0; gy < gridRes; gy++) {
    for (let gx = 0; gx < gridRes; gx++) {
      positions.push(xAt(gx), yAt(gy), zTopAt(gx, gy));
      if (colors) {
        const c = colorForElevation(elevGrid[gy * gridRes + gx], colorBands);
        colors.push(c.r, c.g, c.b);
      }
    }
  }
  for (let gy = 0; gy < gridRes - 1; gy++) {
    for (let gx = 0; gx < gridRes - 1; gx++) {
      const a = idxTop(gx, gy), b = idxTop(gx + 1, gy), c = idxTop(gx, gy + 1), d = idxTop(gx + 1, gy + 1);
      indices.push(a, b, d, a, d, c);
    }
  }

  const baseIndex = (n, color) => {
    const i = positions.length / 3;
    positions.push(n.x, n.y, zBase);
    if (colors) colors.push(color.r, color.g, color.b);
    return i;
  };

  // Walk the grid's top perimeter exactly once (each corner visited only once) so the
  // wall ring and the bottom cap can share the same base vertices instead of each
  // creating their own coincident-but-distinct copies — that mismatch was the source
  // of non-manifold edges along the entire base perimeter.
  const perimeterTop = [];
  for (let gx = 0; gx < gridRes - 1; gx++) perimeterTop.push(idxTop(gx, 0)); // north: west->east
  for (let gy = 0; gy < gridRes - 1; gy++) perimeterTop.push(idxTop(gridRes - 1, gy)); // east: north->south
  for (let gx = gridRes - 1; gx > 0; gx--) perimeterTop.push(idxTop(gx, gridRes - 1)); // south: east->west
  for (let gy = gridRes - 1; gy > 0; gy--) perimeterTop.push(idxTop(0, gy)); // west: south->north

  // Base-ring vertices inherit their corresponding top vertex's color, so walls blend
  // smoothly down to the base instead of all being one flat color.
  const perimeterBase = perimeterTop.map((top) =>
    baseIndex(
      { x: positions[top * 3], y: positions[top * 3 + 1] },
      colors ? { r: colors[top * 3], g: colors[top * 3 + 1], b: colors[top * 3 + 2] } : null
    )
  );

  // side walls: one quad per perimeter edge, connecting top ring to base ring
  for (let i = 0; i < perimeterTop.length; i++) {
    const j = (i + 1) % perimeterTop.length;
    const topA = perimeterTop[i], topB = perimeterTop[j];
    const baseA = perimeterBase[i], baseB = perimeterBase[j];
    indices.push(topA, baseB, baseA, topA, topB, baseB);
  }

  // flat bottom cap: fan-triangulate the same base ring (footprint is convex, so this is exact)
  for (let i = 1; i < perimeterBase.length - 1; i++) {
    indices.push(perimeterBase[0], perimeterBase[i + 1], perimeterBase[i]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------- minimal ZIP writer (STORE method, no compression - STL data barely compresses anyway) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0x21, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);

  const allParts = [...localParts, ...centralParts, new Uint8Array(end.buffer)];
  const out = new Uint8Array(allParts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of allParts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportResults(cells) {
  const exporter = new STLExporter();
  const files = cells.map((cell) => {
    const result = exporter.parse(new THREE.Mesh(cell.geometry), { binary: true });
    const data = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    const name = cells.length === 1 ? "terrain.stl" : `tile_row${cell.row + 1}_col${cell.col + 1}.stl`;
    return { name, data };
  });

  if (files.length === 1) {
    downloadBlob(new Blob([files[0].data], { type: "application/octet-stream" }), files[0].name);
  } else {
    downloadBlob(new Blob([buildZip(files)], { type: "application/zip" }), "terrain_tiles.zip");
  }
}

// ---------- 3MF export (Bambu Studio project format: bakes elevation color bands in
// as height-range filament changes, so AMS multi-color printing needs no manual setup).
// Format reverse-engineered from BambuStudio's own open-source 3MF reader/writer
// (src/libslic3r/Format/bbs_3mf.cpp) rather than guessed, since it's undocumented.
function build3mfModelXml(geometry) {
  const pos = geometry.attributes.position.array;
  const idx = geometry.index.array;
  const vLines = [];
  for (let i = 0; i < pos.length; i += 3) {
    vLines.push(`     <vertex x="${pos[i]}" y="${pos[i + 1]}" z="${pos[i + 2]}"/>`);
  }
  const tLines = [];
  for (let i = 0; i < idx.length; i += 3) {
    tLines.push(`     <triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n` +
    ` <metadata name="Application">BambuStudio-01.09.00.50</metadata>\n` +
    ` <metadata name="BambuStudio:3mfVersion">1</metadata>\n` +
    ` <resources>\n` +
    `  <object id="1" type="model">\n` +
    `   <mesh>\n` +
    `    <vertices>\n${vLines.join("\n")}\n    </vertices>\n` +
    `    <triangles>\n${tLines.join("\n")}\n    </triangles>\n` +
    `   </mesh>\n` +
    `  </object>\n` +
    ` </resources>\n` +
    ` <build>\n` +
    `  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n` +
    ` </build>\n` +
    `</model>\n`
  );
}

// Minimal per-object metadata block matching what BambuStudio itself writes (object
// name + default extruder). Missing entirely is fine for geometry-only imports, but
// including it keeps the file structurally identical to a real BambuStudio project.
function buildModelSettingsXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    ` <object id="1">\n` +
    `  <metadata key="name" value="Terrain"/>\n` +
    `  <metadata key="extruder" value="1"/>\n` +
    ` </object>\n` +
    `</config>\n`
  );
}

// A minimal project (geometry + layer_config_ranges only, no project_settings.config)
// loads fine in BambuStudio for the 3D view, but the object-list sidebar tries to show
// a "settings" panel for each height range and crashes with a null-pointer dereference
// in their own GUI_ObjectList.cpp (dynamic_cast<TabPrintModel*> result used unchecked) -
// this only happens when the app's per-object settings tab never got initialized, which
// requires a full print/filament/printer config to be present, exactly like every real
// BambuStudio-saved project has. So we ship one: a real project_settings.config pulled
// from BambuStudio's own bundled sample project (resources/calib/.../pa_pattern.3mf),
// with filament count widened to 4 slots and our band colors substituted in - everything
// else is left exactly as their own file, rather than guessed key-by-key.
let projectSettingsTemplatePromise = null;
function fetchProjectSettingsTemplate() {
  if (!projectSettingsTemplatePromise) {
    projectSettingsTemplatePromise = fetch("bambu_project_settings_template.json").then((r) => {
      if (!r.ok) throw new Error(`Failed to load bambu_project_settings_template.json: HTTP ${r.status}`);
      return r.text();
    });
  }
  return projectSettingsTemplatePromise;
}

function fillProjectSettingsColors(templateText, colorBands) {
  let out = templateText;
  for (let i = 0; i < 4; i++) {
    const hex = "#" + colorBands[i].color.getHexString().toUpperCase();
    out = out.replace(`__COLOR${i + 1}__`, hex);
  }
  return out;
}

const MF_CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  ` <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  ` <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
  `</Types>`;

const MF_ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  ` <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>`;

// heightsMm: [z0,z1,z2,z3,zTop] boundaries -> 4 ranges, each assigned AMS/extruder slot 1-4.
function buildLayerConfigRangesXml(heightsMm) {
  let ranges = "";
  for (let i = 0; i < 4; i++) {
    ranges += `<range min_z="${heightsMm[i]}" max_z="${heightsMm[i + 1]}">\n<option opt_key="extruder">${i + 1}</option>\n</range>\n`;
  }
  return `<?xml version="1.0"?>\n<objects>\n<object id="1">\n${ranges}</object>\n</objects>\n`;
}

// Converts our elevation color-band cutoffs (meters) into printed-mm height boundaries,
// clamped to stay monotonically increasing regardless of input order.
function computeBandHeightsMm(colorBands, globalMin, baseThicknessMM, zScale) {
  const toMm = (elevM) => baseThicknessMM + (elevM - globalMin) * zScale;
  const z0 = 0;
  const z1 = Math.max(z0, toMm(colorBands[0].max));
  const z2 = Math.max(z1, toMm(colorBands[1].max));
  const z3 = Math.max(z2, toMm(colorBands[2].max));
  const zTop = z3 + 100000; // safely covers every point above the last threshold
  return [z0, z1, z2, z3, zTop];
}

async function build3mfBytes(geometry, heightsMm, colorBands) {
  const encoder = new TextEncoder();
  const projectSettingsJson = fillProjectSettingsColors(await fetchProjectSettingsTemplate(), colorBands);
  const files = [
    { name: "[Content_Types].xml", data: encoder.encode(MF_CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: encoder.encode(MF_ROOT_RELS_XML) },
    { name: "3D/3dmodel.model", data: encoder.encode(build3mfModelXml(geometry)) },
    { name: "Metadata/layer_config_ranges.xml", data: encoder.encode(buildLayerConfigRangesXml(heightsMm)) },
    { name: "Metadata/model_settings.config", data: encoder.encode(buildModelSettingsXml()) },
    { name: "Metadata/project_settings.config", data: encoder.encode(projectSettingsJson) },
  ];
  return buildZip(files);
}

async function export3MF(cells, genParams) {
  const heightsMm = computeBandHeightsMm(genParams.colorBands, genParams.globalMin, genParams.baseThicknessMM, genParams.zScale);
  const files = [];
  for (const cell of cells) {
    const data = await build3mfBytes(cell.geometry, heightsMm, genParams.colorBands);
    const name = cells.length === 1 ? "terrain.3mf" : `tile_row${cell.row + 1}_col${cell.col + 1}.3mf`;
    files.push({ name, data });
  }

  if (files.length === 1) {
    downloadBlob(new Blob([files[0].data], { type: "model/3mf" }), files[0].name);
  } else {
    downloadBlob(new Blob([buildZip(files)], { type: "application/zip" }), "terrain_tiles_3mf.zip");
  }
}

// ---------- main pipeline ----------
let lastGeneratedCells = null;
let lastGeneratedParams = null;

async function generateModel() {
  if (!currentGrid || currentGrid.cells.length === 0) return;
  generateBtn.disabled = true;
  document.getElementById("downloadBtn").disabled = true;
  logEl.textContent = "";

  const gridRes = parseInt(gridResInput.value, 10);
  const exaggeration = parseFloat(exagInput.value);
  const modelWidthMM = parseFloat(document.getElementById("modelSize").value);
  const baseThicknessMM = parseFloat(document.getElementById("baseThickness").value);
  const flattenLakes = document.getElementById("flattenLakes").checked;
  const debugRaiseLakes = document.getElementById("debugRaiseLakes").checked;
  const topDownView = document.getElementById("topDownView").checked;
  const mapboxToken = document.getElementById("mapboxToken").value.trim();
  const elevSource = document.querySelector('input[name="elevSource"]:checked').value;
  const colorByElevation = document.getElementById("colorByElevation").checked;
  const colorBands = colorByElevation
    ? [
        { color: new THREE.Color(document.getElementById("colorBand1").value), max: parseFloat(document.getElementById("colorBreak1").value) },
        { color: new THREE.Color(document.getElementById("colorBand2").value), max: parseFloat(document.getElementById("colorBreak2").value) },
        { color: new THREE.Color(document.getElementById("colorBand3").value), max: parseFloat(document.getElementById("colorBreak3").value) },
        { color: new THREE.Color(document.getElementById("colorBand4").value), max: Infinity },
      ]
    : null;

  const tileSizeM = currentGrid.sizeKm * 1000;
  const cells = currentGrid.cells;

  try {
    // Fetch water outlines ONCE for the whole grid instead of once per tile - at
    // up to 10,000 tiles, one-query-per-tile would get Overpass to rate-limit or
    // ban us. A single big query is slower per-call but astronomically fewer calls.
    let polys = [];
    if (flattenLakes) {
      log(cells.length > 1 ? "Fetching lake/water outlines for the whole grid area (one query covers every tile)..." : "Fetching lake/water outlines from OpenStreetMap...");
      try {
        polys = await fetchWaterPolygons(currentGrid.overallBounds);
        log(`Found ${polys.length} water polygon(s) covering the whole grid.`);
      } catch (err) {
        log(`Warning: could not fetch water outlines (${err.message}). Continuing without lake flattening.`);
      }
    }

    let globalMin = Infinity;
    let totalFlattenedCells = 0;
    const debugOffset = debugRaiseLakes ? 100 : 0;
    const CONCURRENCY = 5; // elevation sources handle this fine now that Overpass is no longer called per-tile
    let completed = 0;

    for (let batchStart = 0; batchStart < cells.length; batchStart += CONCURRENCY) {
      const batch = cells.slice(batchStart, batchStart + CONCURRENCY);
      await Promise.all(
        batch.map(async (cell) => {
          const bounds = cell.bounds;
          const west = bounds.getWest(), east = bounds.getEast(), north = bounds.getNorth(), south = bounds.getSouth();
          const sample = await buildElevationSampler(bounds, elevSource, mapboxToken || null, gridRes);

          const elevGrid = new Float32Array(gridRes * gridRes);
          for (let gy = 0; gy < gridRes; gy++) {
            const lat = north - ((north - south) * gy) / (gridRes - 1);
            for (let gx = 0; gx < gridRes; gx++) {
              const lon = west + ((east - west) * gx) / (gridRes - 1);
              elevGrid[gy * gridRes + gx] = sample(lon, lat);
            }
          }

          if (flattenLakes && polys.length > 0) {
            const lakeIdOfCell = new Int32Array(gridRes * gridRes).fill(-1);
            for (let gy = 0; gy < gridRes; gy++) {
              const lat = north - ((north - south) * gy) / (gridRes - 1);
              for (let gx = 0; gx < gridRes; gx++) {
                const lon = west + ((east - west) * gx) / (gridRes - 1);
                lakeIdOfCell[gy * gridRes + gx] = findLakeIndex(lon, lat, polys);
              }
            }
            const minPerLake = new Map();
            for (let i = 0; i < lakeIdOfCell.length; i++) {
              const id = lakeIdOfCell[i];
              if (id < 0) continue;
              const v = elevGrid[i];
              if (!minPerLake.has(id) || v < minPerLake.get(id)) minPerLake.set(id, v);
            }
            for (let i = 0; i < lakeIdOfCell.length; i++) {
              const id = lakeIdOfCell[i];
              if (id < 0) continue;
              elevGrid[i] = minPerLake.get(id) + debugOffset;
              totalFlattenedCells++;
            }
          }

          for (const v of elevGrid) if (v < globalMin) globalMin = v;
          cell.elevGrid = elevGrid;
          completed++;
        })
      );
      if (cells.length > 1) log(`Sampled ${completed}/${cells.length} tile(s)...`);
    }

    if (flattenLakes && polys.length > 0) {
      log(`Flattened ${totalFlattenedCells} grid cells across all tiles.`);
    }
    log(`Global minimum elevation across all tiles: ${globalMin.toFixed(1)}m. Building solid mesh(es)...`);

    if (currentMeshGroup) {
      scene.remove(currentMeshGroup);
      currentMeshGroup.traverse((obj) => obj.geometry && obj.geometry.dispose());
    }
    const material = new THREE.MeshStandardMaterial({
      color: colorByElevation ? 0xffffff : 0x4f8cff,
      vertexColors: colorByElevation,
      metalness: 0.1,
      roughness: 0.8,
      flatShading: false,
      side: THREE.DoubleSide,
    });
    const group = new THREE.Group();

    const MAX_PREVIEW_TILES = 36; // beyond this, live-rendering every tile would hang or crash the tab
    if (cells.length > MAX_PREVIEW_TILES) {
      log(`Preview limited to the first ${MAX_PREVIEW_TILES} tiles for performance — all ${cells.length} tiles are still built and included in the download.`);
    }

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      cell.geometry = buildSolidGeometry(cell.elevGrid, gridRes, {
        tileSizeM,
        modelWidthMM,
        exaggeration,
        baseThicknessMM,
        minElev: globalMin,
        colorBands,
      });
      if (i < MAX_PREVIEW_TILES) {
        const mesh = new THREE.Mesh(cell.geometry, material);
        mesh.position.set(cell.col * modelWidthMM, -cell.row * modelWidthMM, 0);
        group.add(mesh);
      }
    }

    scene.add(group);
    currentMeshGroup = group;
    fitCameraToMesh(group, debugRaiseLakes || topDownView);
    lastGeneratedCells = cells;
    lastGeneratedParams = {
      colorBands,
      globalMin,
      baseThicknessMM,
      zScale: (modelWidthMM / tileSizeM) * exaggeration,
    };

    let triCount = 0;
    for (const cell of cells) triCount += cell.geometry.index.count / 3;
    log(`Done. ${cells.length} tile(s), ${triCount.toLocaleString()} total triangles. Ready to download.`);

    document.getElementById("downloadBtn").disabled = false;
    updateDownloadButtonLabel();
  } catch (err) {
    console.error(err);
    log(`Error: ${err.message}`);
  } finally {
    generateBtn.disabled = false;
  }
}

function updateDownloadButtonLabel() {
  const downloadBtn = document.getElementById("downloadBtn");
  if (downloadBtn.disabled) return;
  const format = document.querySelector('input[name="exportFormat"]:checked').value;
  const n = lastGeneratedCells ? lastGeneratedCells.length : 1;
  const ext = format === "3mf" ? "3MF" : "STL";
  downloadBtn.textContent = n > 1 ? `Download ZIP (${n} ${ext} tiles)` : `Download ${ext}`;
}
for (const radio of document.querySelectorAll('input[name="exportFormat"]')) {
  radio.addEventListener("change", updateDownloadButtonLabel);
}

generateBtn.addEventListener("click", generateModel);
document.getElementById("downloadBtn").addEventListener("click", async () => {
  if (!lastGeneratedCells) return;
  const format = document.querySelector('input[name="exportFormat"]:checked').value;
  if (format === "3mf") {
    if (!lastGeneratedParams.colorBands) {
      log('3MF export needs "Color preview by elevation" turned on before generating — check that box and click Generate again.');
      return;
    }
    try {
      await export3MF(lastGeneratedCells, lastGeneratedParams);
    } catch (err) {
      console.error(err);
      log(`3MF export failed: ${err.message}`);
    }
  } else {
    exportResults(lastGeneratedCells);
  }
});

log("Ready. Click the map to set the top-left corner of your area.");
