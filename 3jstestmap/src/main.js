import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const ORIGIN   = { lat: 51.505, lon: -0.09 };
const TILE_DEG = 0.005;
const LAT_M    = 110540;
const LON_M    = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const TILE_W   = TILE_DEG * LON_M;
const TILE_H   = TILE_DEG * LAT_M;

const RADIUS_MIN  = 1;
const RADIUS_MAX  = 5;
const HEIGHT_MIN  = 100;
const HEIGHT_MAX  = 2500;
const VIEW_BIAS   = 0.55;

const VIEW_BUFFER_T   = 1.5;
const BOTTOM_BUFFER_T = 2.0;

const EVICT_BUFFER = 1;

const CACHE_CONCURRENCY = 8;
const API_CONCURRENCY   = 3;
const MAX_CACHE_QUEUE   = 48;
const MAX_API_QUEUE     = 16;

const MAX_TILES  = 5;
const RETILE_MS  = 350;
const SERVER     = 'http://localhost:3000';
let   useServer  = false;

async function detectServer() {
    try {
        const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(1000) });
        useServer = res.ok;
    } catch { useServer = false; }
    console.log(useServer
        ? '[server] cache server detected'
        : '[server] not found — using Overpass directly');
}
await detectServer();


const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 8000);
camera.position.set(0, 800, 0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#canvas'), antialias: true });
renderer.setSize(
  renderer.domElement.clientWidth,
  renderer.domElement.clientHeight,
  false
);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance   = 80;
controls.maxDistance   = 3000;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI / 2;

controls.mouseButtons = {
    LEFT:   THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.ROTATE,
};
controls.touches = {
    ONE: THREE.TOUCH.PAN,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
};

function lockCurrentTilt() {
    return;
    const offset = camera.position.clone().sub(controls.target);
    const phi = Math.atan2(
        Math.sqrt(offset.x * offset.x + offset.z * offset.z),
        offset.y
    );
    controls.minPolarAngle = phi;
    controls.maxPolarAngle = phi;
}
lockCurrentTilt();

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(300, 600, 200);
scene.add(sun);

const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20000, 20000),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1;
scene.add(ground);


function tileLatLon(tx, ty) {
    return { lat: ORIGIN.lat + ty * TILE_DEG, lon: ORIGIN.lon + tx * TILE_DEG };
}

function toWorld(lat, lon) {
    return { x: (lon - ORIGIN.lon) * LON_M, z: -(lat - ORIGIN.lat) * LAT_M };
}

function camTile() {
    return {
        tx: Math.floor( camera.position.x / TILE_W),
        ty: Math.floor(-camera.position.z / TILE_H),
    };
}

function getLoadRadius() {
    const h = camera.position.y;
    const t = Math.min(1, Math.max(0, (h - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)));
    return Math.round(RADIUS_MIN + t * (RADIUS_MAX - RADIUS_MIN));
}

function worldToFracTile(wx, wz) {
    return { ftx: wx / TILE_W, fty: -wz / TILE_H };
}


const _groundPlane3D = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function getGroundPoint(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(_groundPlane3D, pt) ? pt : null;
}

function pointInPolygon2D(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const hit =
            ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (hit) inside = !inside;
    }
    return inside;
}

function buildPriorityList() {
    const worldCorners = [
        getGroundPoint(-1,  1),
        getGroundPoint( 1,  1),
        getGroundPoint( 1, -1),
        getGroundPoint(-1, -1),
    ];

    if (worldCorners.some(p => !p)) return _priorityListFallback();

    const tc = worldCorners.map(p => worldToFracTile(p.x, p.z));

    const cx = tc.reduce((s, p) => s + p.ftx, 0) / 4;
    const cy = tc.reduce((s, p) => s + p.fty, 0) / 4;

    const farMidX  = (tc[0].ftx + tc[1].ftx) / 2;
    const farMidY  = (tc[0].fty + tc[1].fty) / 2;
    const nearMidX = (tc[2].ftx + tc[3].ftx) / 2;
    const nearMidY = (tc[2].fty + tc[3].fty) / 2;
    let ndx = nearMidX - farMidX;
    let ndy = nearMidY - farMidY;
    const nlen = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
    ndx /= nlen; ndy /= nlen;

    const buffered = tc.map((p, i) => {
        const dx  = p.ftx - cx;
        const dy  = p.fty - cy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const isNear = i === 2 || i === 3;
        return {
            x: p.ftx + (dx / len) * VIEW_BUFFER_T + (isNear ? ndx * BOTTOM_BUFFER_T : 0),
            y: p.fty + (dy / len) * VIEW_BUFFER_T + (isNear ? ndy * BOTTOM_BUFFER_T : 0),
        };
    });

    const vc = (() => {
        const p = getGroundPoint(0, 0);
        return p ? worldToFracTile(p.x, p.z) : { ftx: cx, fty: cy };
    })();

    const xs = buffered.map(p => p.x);
    const ys = buffered.map(p => p.y);
    const minTX = Math.floor(Math.min(...xs));
    const maxTX = Math.ceil(Math.max(...xs));
    const minTY = Math.floor(Math.min(...ys));
    const maxTY = Math.ceil(Math.max(...ys));

    const list = [];
    for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = minTY; ty <= maxTY; ty++) {
            if (pointInPolygon2D({ x: tx + 0.5, y: ty + 0.5 }, buffered)) {
                const dist = Math.hypot(tx + 0.5 - vc.ftx, ty + 0.5 - vc.fty);
                list.push({ tx, ty, dist });
            }
        }
    }

    list.sort((a, b) => a.dist - b.dist);
    return list;
}

const _lookDir = new THREE.Vector3();
function _priorityListFallback() {
    const { tx: ctx, ty: cty } = camTile();
    const radius = getLoadRadius();
    camera.getWorldDirection(_lookDir);
    _lookDir.y = 0;
    const len = _lookDir.length();
    const bias = radius * VIEW_BIAS;
    const cx = len > 0.001 ? ctx + (_lookDir.x / len) * bias : ctx;
    const cy = len > 0.001 ? cty - (_lookDir.z / len) * bias : cty;

    const list = [];
    for (let dx = -(radius + 1); dx <= radius + 1; dx++) {
        for (let dy = -(radius + 1); dy <= radius + 1; dy++) {
            const tx   = Math.round(cx) + dx;
            const ty   = Math.round(cy) + dy;
            const dist = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
            if (dist <= radius + 0.5) list.push({ tx, ty, dist });
        }
    }
    list.sort((a, b) => a.dist - b.dist);
    return list;
}


async function fetchOSM(tx, ty, priority = 5, signal = null) {
    if (useServer) {
        const res = await fetch(
            `${SERVER}/tile/${tx}/${ty}?priority=${priority}`,
            signal ? { signal } : {},
        );
        if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
        return res.json();
    }

    const sw   = tileLatLon(tx, ty);
    const ne   = tileLatLon(tx + 1, ty + 1);
    const bbox = `${sw.lat},${sw.lon},${ne.lat},${ne.lon}`;
    const q    = `[out:json][timeout:20];`
               + `(way["building"](${bbox});`
               + `node["amenity"](${bbox});`
               + `node["shop"](${bbox});`
               + `);out body;>;out skel qt;`;

    const res = await fetch('https://overpass-api.de/api/interpreter', {
        method:  'POST',
        body:    'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal:  signal ?? AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    return res.json();
}


function buildingMesh(way, nodeById) {
    const pts = (way.nodes || [])
        .map(id => nodeById.get(id))
        .filter(Boolean)
        .map(n => toWorld(n.lat, n.lon));
    if (pts.length < 3) return null;

    const tags = way.tags || {};
    let h = 10;
    if (tags.height)                  h = parseFloat(tags.height)            || h;
    else if (tags['building:levels']) h = parseInt(tags['building:levels']) * 3;

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    shape.closePath();

    try {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
        const mat  = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.85 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.tags = tags;
        return mesh;
    } catch { return null; }
}


class Tile {
    constructor(tx, ty) {
        this.tx             = tx;
        this.ty             = ty;
        this.loading        = false;
        this.loaded         = false;
        this.failed         = false;
        this.cacheAttempted = false;
        this.group          = new THREE.Group();
        this._abort         = new AbortController();
        this._placeholder   = null;
        scene.add(this.group);
    }

    get done() { return this.loaded || this.failed; }

    _ensurePlaceholder() {
        if (this._placeholder) return;
        const cx = (this.tx + 0.5) * TILE_W;
        const cz = -(this.ty + 0.5) * TILE_H;
        this._placeholder = new THREE.Mesh(
            new THREE.PlaneGeometry(TILE_W - 2, TILE_H - 2),
            new THREE.MeshBasicMaterial({ color: 0x2255cc, wireframe: true }),
        );
        this._placeholder.rotation.x = -Math.PI / 2;
        this._placeholder.position.set(cx, 0, cz);
        this.group.add(this._placeholder);
    }

    _removePlaceholder() {
        if (!this._placeholder) return;
        this.group.remove(this._placeholder);
        this._placeholder.geometry.dispose();
        this._placeholder.material.dispose();
        this._placeholder = null;
    }

    _processData(data) {
        const nodeMap = new Map();
        for (const el of data.elements) {
            if (el.type === 'node') nodeMap.set(el.id, el);
        }
        for (const el of data.elements) {
            if (el.type === 'way' && el.tags?.building) {
                const m = buildingMesh(el, nodeMap);
                if (m) this.group.add(m);
            }
        }
        this._removePlaceholder();
        this.loaded = true;
    }

    async tryLoadCache() {
        if (this.cacheAttempted || this.loading || this.done) return false;
        this.cacheAttempted = true;

        if (!useServer) return false;

        this.loading = true;
        this._ensurePlaceholder();
        try {
            const res = await fetch(
                `${SERVER}/tile/${this.tx}/${this.ty}?cacheOnly=false`,
                { signal: this._abort.signal },
            );
            if (res.status === 404) return false;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!this._abort.signal.aborted) this._processData(data);
            return true;
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.warn(`Cache check (${this.tx},${this.ty}): ${e.message}`);
            }
            return false;
        } finally {
            this.loading = false;
        }
    }

    startApiLoad(priority = 5) {
        if (this.loading || this.done) return Promise.resolve();
        this.cacheAttempted = true;
        this.loading = true;
        this._ensurePlaceholder();
        return this._doApiLoad(priority);
    }

    async _doApiLoad(priority) {
        try {
            const data = await fetchOSM(this.tx, this.ty, priority, this._abort.signal);
            if (!this._abort.signal.aborted) this._processData(data);
        } catch (e) {
            this._removePlaceholder();
            if (e.name !== 'AbortError') {
                console.warn(`Tile (${this.tx},${this.ty}) failed: ${e.message}`);
                this.failed = true;
            }
        } finally {
            this.loading = false;
        }
    }

    dispose() {
        this._abort.abort();
        scene.remove(this.group);
        this.group.traverse(obj => {
            if (!obj.isMesh) return;
            obj.geometry?.dispose();
            const m = obj.material;
            Array.isArray(m) ? m.forEach(x => x.dispose()) : m?.dispose();
        });
    }
}


class TileLoader {
    constructor() {
        this.cacheQueue  = [];
        this.apiQueue    = [];
        this.cacheActive = 0;
        this.apiActive   = 0;
    }

    update(priorityList, tileMap) {
        const wantedKeys = new Set(priorityList.map(p => `${p.tx},${p.ty}`));

        this.cacheQueue = this.cacheQueue.filter(i => wantedKeys.has(`${i.tx},${i.ty}`));
        this.apiQueue   = this.apiQueue.filter(i => wantedKeys.has(`${i.tx},${i.ty}`));

        for (const p of priorityList) {
            const key  = `${p.tx},${p.ty}`;
            const tile = tileMap.get(key);
            if (!tile || tile.done || tile.loading) continue;

            const inCacheQ = this.cacheQueue.some(q => q.tx === p.tx && q.ty === p.ty);
            const inApiQ   = this.apiQueue.some(q => q.tx === p.tx && q.ty === p.ty);

            if (tile.cacheAttempted) {
                if (!inApiQ) this.apiQueue.push({ ...p, tile });
            } else {
                if (!inCacheQ) this.cacheQueue.push({ ...p, tile });
            }
        }

        this.cacheQueue.sort((a, b) => a.dist - b.dist);
        this.apiQueue.sort((a, b) => a.dist - b.dist);

        if (this.cacheQueue.length > MAX_CACHE_QUEUE) this.cacheQueue.length = MAX_CACHE_QUEUE;
        if (this.apiQueue.length   > MAX_API_QUEUE)   this.apiQueue.length   = MAX_API_QUEUE;

        this._drainCache();
        this._drainApi();
    }

    _drainCache() {
        while (this.cacheActive < CACHE_CONCURRENCY && this.cacheQueue.length > 0) {
            const item = this.cacheQueue.shift();
            if (!item.tile || item.tile.loading || item.tile.done) { this._drainCache(); return; }

            this.cacheActive++;
            item.tile.tryLoadCache().then(hit => {
                this.cacheActive--;
                if (!hit && !item.tile.done) {
                    // Promote to API pool, preserving priority order
                    if (!this.apiQueue.some(q => q.tx === item.tx && q.ty === item.ty)) {
                        this.apiQueue.push(item);
                        this.apiQueue.sort((a, b) => a.dist - b.dist);
                    }
                    this._drainApi();
                }
                this._drainCache();
            }).catch(() => { this.cacheActive--; this._drainCache(); });
        }
    }

    _drainApi() {
        while (this.apiActive < API_CONCURRENCY && this.apiQueue.length > 0) {
            const item = this.apiQueue.shift();
            if (!item.tile || item.tile.loading || item.tile.done) { this._drainApi(); return; }

            this.apiActive++;
            item.tile.startApiLoad(Math.max(1, Math.round(item.dist))).finally(() => {
                this.apiActive--;
                this._drainApi();
            });
        }
    }
}

class Tiles {
    constructor() {
        this.map    = new Map();
        this.loader = new TileLoader();
        this.retile();
    }

    _key(tx, ty) { return `${tx},${ty}`; }

    retile() {
        const list = buildPriorityList();
        if (!list.length) return;

        const vc = (() => {
            const p = getGroundPoint(0, 0);
            if (p) return worldToFracTile(p.x, p.z);
            const { tx, ty } = camTile();
            return { ftx: tx + 0.5, fty: ty + 0.5 };
        })();

        const wantedKeys  = new Set(list.map(p => `${p.tx},${p.ty}`));
        const maxViewDist = list.length ? list[list.length - 1].dist : getLoadRadius();
        const evictDist   = maxViewDist + EVICT_BUFFER;

        for (const [key, tile] of this.map) {
            if (wantedKeys.has(key)) continue;
            const d = Math.hypot(tile.tx + 0.5 - vc.ftx, tile.ty + 0.5 - vc.fty);
            if (d > evictDist) {
                tile.dispose();
                this.map.delete(key);
            }
        }

        if (this.map.size > MAX_TILES) {
            const sorted = [...this.map.values()].sort((a, b) =>
                Math.hypot(b.tx + 0.5 - vc.ftx, b.ty + 0.5 - vc.fty) -
                Math.hypot(a.tx + 0.5 - vc.ftx, a.ty + 0.5 - vc.fty)
            );
            for (let i = 0; i < this.map.size - MAX_TILES; i++) {
                sorted[i].dispose();
                this.map.delete(this._key(sorted[i].tx, sorted[i].ty));
            }
        }

        for (const { tx, ty } of list) {
            const key = this._key(tx, ty);
            if (!this.map.has(key)) this.map.set(key, new Tile(tx, ty));
        }

        this.loader.update(list, this.map);
    }
}


const livePos = document.getElementById("livepos");
const lonInput = document.getElementById("lonin");
const latInput = document.getElementById("latin");
const goButton = document.getElementById("gotopos");

const dirText = document.getElementById("dir");
const northButton = document.getElementById("north");

const poiButton = document.getElementById("poi");
const wideButton = document.getElementById("wide");
const angleSlider = document.getElementById("angle");

let angleSliderVal;

function updateLivePos() {
    const lon = ORIGIN.lon + camera.position.x / LON_M;
    const lat = ORIGIN.lat - camera.position.z / LAT_M;
    if(livePos!=undefined){livePos.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;};
}

function updateDir() {
    camera.getWorldDirection(_lookDir);
    _lookDir.y = 0;
    const len = _lookDir.length();
    if (len < 0.001) { dirText.textContent = "—"; return; }
    _lookDir.divideScalar(len);
    const angle = Math.atan2(_lookDir.x, -_lookDir.z);
    const t = ((angle / (Math.PI * 2)) + 1) % 1;
    dirText.textContent = t.toFixed(2);
}

angleSlider.addEventListener("change", () => {
    angleSliderVal = angleSlider.value / 100;

    console.log(angleSliderVal);
});

goButton.addEventListener("click", () => {
    const lon = parseFloat(lonInput.value);
    const lat = parseFloat(latInput.value);
    if (isNaN(lon) || isNaN(lat)) return;

    const wx = (lon - ORIGIN.lon) * LON_M;
    const wz = -(lat - ORIGIN.lat) * LAT_M;

    const dx = wx - camera.position.x;
    const dz = wz - camera.position.z;
    camera.position.x    += dx;
    camera.position.z    += dz;
    controls.target.x    += dx;
    controls.target.z    += dz;
    controls.update();
});

northButton.addEventListener("click", () => {
    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const hDist = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
    camera.position.set(target.x, camera.position.y, target.z + hDist);
    controls.update();
});

poiButton.addEventListener("click", () => {
    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const azimuth = Math.atan2(offset.x, offset.z);

    const newY    = 300;
    const phi     = Math.PI / 4;
    const hDist   = newY * Math.tan(phi);

    camera.position.set(
        target.x + Math.sin(azimuth) * hDist,
        target.y + newY,
        target.z + Math.cos(azimuth) * hDist,
    );
    controls.update();
    lockCurrentTilt();
});

wideButton.addEventListener("click", () => {
    const target = controls.target;
    camera.position.set(target.x, target.y + 1000, target.z);
    controls.update();
    lockCurrentTilt();
});

function updateIO() {
    updateLivePos();
    updateDir();
}

function resizeRenderer() {
    const canvas = renderer.domElement;

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;

    renderer.setSize(width, height, false);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

resizeRenderer();

window.addEventListener('resize', resizeRenderer);

const tiles = new Tiles();
let lastRetile = 0;

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    if (now - lastRetile > RETILE_MS) {
        tiles.retile();
        lastRetile = now;
    }

    ground.position.x = camera.position.x;
    ground.position.z = camera.position.z;

    updateIO();
    controls.update();
    renderer.render(scene, camera);
}

animate();