import * as THREE from 'three';

const LAT_SCALE  = 110540;
const lonScale   = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

export function latLonToWorld(lat, lon, originLat, originLon) {
  const x = (lon - originLon) * lonScale(originLat);
  const z = (originLat - lat) * LAT_SCALE;
  return { x, z };
}

export function worldToLatLon(x, z, originLat, originLon) {
  const lat = originLat - z / LAT_SCALE;
  const lon = originLon + x / lonScale(originLat);
  return { lat, lon };
}


function buildOverpassQuery(south, west, north, east) {
  return `
[out:json][timeout:25];
(
  way["building"](${south},${west},${north},${east});
  node["shop"](${south},${west},${north},${east});
  node["amenity"](${south},${west},${north},${east});
  node["tourism"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`.trim();
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
let _endpointIdx = 0;

async function fetchOverpass(query) {
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const url = OVERPASS_ENDPOINTS[(_endpointIdx + attempt) % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`[TileManager] Overpass endpoint ${url} failed:`, e.message);
      _endpointIdx = (_endpointIdx + 1) % OVERPASS_ENDPOINTS.length;
    }
  }
  throw new Error('[TileManager] All Overpass endpoints failed');
}

function extrudeBuilding(points, height, material) {
  if (points.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, points[0].z);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i].x, points[i].z);
  }
  shape.closePath();

  const extrudeSettings = {
    depth: height,
    bevelEnabled: false,
  };

  try {
    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  } catch {
    return null;
  }
}

const _markerGeo = new THREE.SphereGeometry(8, 8, 8);

function createMarker(x, z, nodeData, material) {
  const mesh = new THREE.Mesh(_markerGeo, material.clone());
  mesh.position.set(x, 8, z);
  mesh.userData = nodeData;
  return mesh;
}

/**
 * @typedef {Object} TileManagerOptions
 * @property {number} [tileSizeDeg=0.01]    Tile size in degrees (lat & lon)
 * @property {number} [viewRadius=2]        Load tiles within this many tiles of camera
 * @property {number} [maxCacheSize=64]     Max tiles to keep in memory
 * @property {number} [defaultBuildingHeight=15]  Metres when height tag is absent
 * @property {number} [buildingFloorHeight=3]      Metres per floor (for levels tag)
 * @property {{ lat: number, lon: number }} origin  World (0,0,0) in lat/lon
 * @property {THREE.Material} [buildingMaterial]
 * @property {THREE.Material} [markerMaterial]
 * @property {(nodeData: object) => string} [tooltipFormatter]
 */

export class TileManager {
  /**
   * @param {THREE.Scene} scene
   * @param {TileManagerOptions} options
   */
  constructor(scene, options = {}) {
    this.scene    = scene;
    this.origin   = options.origin ?? { lat: 51.505, lon: -0.09 }; // origin
    this.tileSize = options.tileSizeDeg  ?? 0.01;
    this.radius   = options.viewRadius   ?? 2;
    this.maxCache = options.maxCacheSize ?? 64;
    this.defaultBuildingHeight = options.defaultBuildingHeight ?? 15;
    this.buildingFloorHeight   = options.buildingFloorHeight   ?? 3;

    this.buildingMaterial = options.buildingMaterial
      ?? new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.8 });

    this.markerMaterial = options.markerMaterial
      ?? new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 });

    this.tooltipFormatter = options.tooltipFormatter ?? defaultTooltipFormatter;

    this._cache   = new Map();
    this._loading = new Set(); // tile keys currently in-flight

    this._lastTileX = null;
    this._lastTileZ = null;
  }


  update(cameraWorldPos) {
    const tileX = Math.floor(cameraWorldPos.x / this._tileSizeMetresX());
    const tileZ = Math.floor(cameraWorldPos.z / this._tileSizeMetresZ());

    if (tileX === this._lastTileX && tileZ === this._lastTileZ) return;
    this._lastTileX = tileX;
    this._lastTileZ = tileZ;

    this._refreshTiles(tileX, tileZ);
  }

  preload(lat, lon) {
    const key = this._keyFromLatLon(lat, lon);
    this._loadTile(key);
  }

  dispose() {
    for (const [, entry] of this._cache) {
      this.scene.remove(entry.group);
      entry.group.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          obj.material?.dispose();
        }
      });
    }
    this._cache.clear();
    this._loading.clear();
  }


  _tileSizeMetresX() { return this.tileSize * lonScale(this.origin.lat); }
  _tileSizeMetresZ() { return this.tileSize * LAT_SCALE; }

  _keyFromTileIdx(tx, tz) { return `${tx}:${tz}`; }

  _keyFromLatLon(lat, lon) {
    const pos = latLonToWorld(lat, lon, this.origin.lat, this.origin.lon);
    const tx  = Math.floor(pos.x / this._tileSizeMetresX());
    const tz  = Math.floor(pos.z / this._tileSizeMetresZ());
    return this._keyFromTileIdx(tx, tz);
  }

  _tileBounds(tx, tz) {
    const mxSize = this._tileSizeMetresX();
    const mzSize = this._tileSizeMetresZ();

    const wx0 = tx * mxSize;
    const wz0 = tz * mzSize;
    const wx1 = wx0 + mxSize;
    const wz1 = wz0 + mzSize;

    const sw = worldToLatLon(wx0, wz1, this.origin.lat, this.origin.lon);
    const ne = worldToLatLon(wx1, wz0, this.origin.lat, this.origin.lon);

    return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
  }


  _refreshTiles(centerTX, centerTZ) {
    const needed = new Set();
    for (let dx = -this.radius; dx <= this.radius; dx++) {
      for (let dz = -this.radius; dz <= this.radius; dz++) {
        if (dx * dx + dz * dz > this.radius * this.radius) continue;
        const key = this._keyFromTileIdx(centerTX + dx, centerTZ + dz);
        needed.add(key);
        if (!this._cache.has(key) && !this._loading.has(key)) {
          this._loadTile(key, centerTX + dx, centerTZ + dz);
        }
      }
    }

    for (const key of needed) {
      if (this._cache.has(key)) this._cache.get(key).lastUsed = Date.now();
    }
    this._evict(needed);
  }

  async _loadTile(key, tx, tz) {
    if (this._loading.has(key) || this._cache.has(key)) return;
    this._loading.add(key);

    if (tx === undefined) {
      const [kx, kz] = key.split(':').map(Number);
      tx = kx; tz = kz;
    }

    const bounds = this._tileBounds(tx, tz);
    const query  = buildOverpassQuery(bounds.south, bounds.west, bounds.north, bounds.east);

    let data;
    try {
      data = await fetchOverpass(query);
    } catch (e) {
      console.error(`[TileManager] Failed to load tile ${key}:`, e);
      this._loading.delete(key);
      return;
    }

    const group = this._buildTileGroup(data, bounds);
    group.name = `tile_${key}`;
    this.scene.add(group);

    this._cache.set(key, { group, lastUsed: Date.now(), status: 'loaded' });
    this._loading.delete(key);
  }

  _buildTileGroup(osmData, bounds) {
    const group = new THREE.Group();

    const nodeById = new Map();
    for (const el of osmData.elements) {
      if (el.type === 'node') nodeById.set(el.id, el);
    }

    for (const el of osmData.elements) {
      if (el.type === 'way' && el.tags?.building) {
        const mesh = this._buildingFromWay(el, nodeById);
        if (mesh) group.add(mesh);
      }

      if (el.type === 'node' && (el.tags?.shop || el.tags?.amenity || el.tags?.tourism)) {
        const pos = latLonToWorld(el.lat, el.lon, this.origin.lat, this.origin.lon);
        const marker = createMarker(pos.x, pos.z, el, this.markerMaterial);
        group.add(marker);
      }
    }

    return group;
  }

  _buildingFromWay(way, nodeById) {
    const points = [];
    for (const nid of way.nodes ?? []) {
      const n = nodeById.get(nid);
      if (!n) continue;
      const pos = latLonToWorld(n.lat, n.lon, this.origin.lat, this.origin.lon);
      points.push(pos);
    }

    let height = this.defaultBuildingHeight;
    if (way.tags?.height)        height = parseFloat(way.tags.height) || height;
    else if (way.tags?.['building:levels'])
      height = parseInt(way.tags['building:levels'], 10) * this.buildingFloorHeight;

    const mat = this.buildingMaterial.clone();

    const hue = (way.id % 30) / 30;
    mat.color.setHSL(0.58 + hue * 0.04, 0.12, 0.55 + hue * 0.1);

    const mesh = extrudeBuilding(points, height, mat);
    if (mesh) {
      mesh.userData = { osmId: way.id, tags: way.tags };
    }
    return mesh;
  }

  _evict(neededKeys) {
    if (this._cache.size <= this.maxCache) return;

    const entries = [...this._cache.entries()]
      .filter(([k]) => !neededKeys.has(k))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    const toRemove = entries.slice(0, this._cache.size - this.maxCache);
    for (const [key, entry] of toRemove) {
      this.scene.remove(entry.group);
      entry.group.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          obj.material?.dispose();
        }
      });
      this._cache.delete(key);
    }
  }
}


function defaultTooltipFormatter(tags = {}) {
  const name    = tags.name || tags.brand || tags.amenity || tags.shop || 'Location';
  const address = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return `<strong>${name}</strong>${address ? `<br>${address}` : ''}`;
}
