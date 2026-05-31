import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const ORIGIN   = { lat: 51.505, lon: -0.09 };
const TILE_DEG = 0.005;
const LAT_M    = 110540;
const LON_M    = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const TILE_W   = TILE_DEG * LON_M;
const TILE_H   = TILE_DEG * LAT_M;

const RADIUS_MIN      = 1;
const RADIUS_MAX      = 5;
const HEIGHT_MIN      = 100;
const HEIGHT_MAX      = 2500;
const VIEW_BIAS       = 0.55;
const VIEW_CLOSE      = 300;
const VIEW_FAR        = 2000;
const VIEW_BUFFER_T   = 1.5;
const BOTTOM_BUFFER_T = 2.0;

const BUILDING_MAT = new THREE.MeshStandardMaterial({ color: 0xdd3322, roughness: 0.85 });
const FLOOR_MAT    = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 });

const EVICT_BUFFER     = 1;
const EVICT_GRACE_MS   = 3000;
const RETRY_AFTER_MS   = 1500;
const POLL_CONCURRENCY = 8;
const FETCH_CONCURRENCY = 3;
const MAX_TILES        = 100;
const RETILE_MS        = 350;

const SERVER    = 'http://localhost:3000';
let   useServer = false;

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
renderer.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight, false);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.08;
controls.minDistance    = VIEW_CLOSE;
controls.maxDistance    = VIEW_FAR;
controls.minPolarAngle  = 0;
controls.maxPolarAngle  = Math.PI / 2;

/*
TEMP
disabled rotation
maybe reenable later if compass and rotation is added
*/
controls.mouseButtons = {
    LEFT:   THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.PAN,
};
controls.touches = {
    ONE: THREE.TOUCH.PAN,
    TWO: THREE.TOUCH.PAN,
};

/*
TO BE FIXED
must be controllable, to move on animation
can be disabled when rotation is disabled
*/
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
    FLOOR_MAT,
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
        const geo  = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
        const mesh = new THREE.Mesh(geo, BUILDING_MAT);
        mesh.userData.tags = tags;
        return mesh;
    } catch { return null; }
}


class Tile {
    constructor(tx, ty) {
        this.tx          = tx;
        this.ty          = ty;
        this.state       = 'idle';
        this.lastWanted  = Date.now();
        this.lastChecked = 0;
        this.group       = new THREE.Group();
        this._abort      = new AbortController();
        this._placeholder = null;
        scene.add(this.group);
    }

    get loading() { return this.state === 'checking' || this.state === 'fetching'; }
    get loaded()  { return this.state === 'loaded'; }
    get failed()  { return this.state === 'failed'; }
    get done()    { return this.loaded || this.failed; }

    shouldRetry() {
        return this.state === 'waiting' && Date.now() - this.lastChecked > RETRY_AFTER_MS;
    }

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
        this.state = 'loaded';
    }

    async checkCache() {
        if (this.state !== 'idle' && !this.shouldRetry()) return;
        this.state = 'checking';
        this.lastChecked = Date.now();
        this._ensurePlaceholder();

        const { signal } = this._abort;
        try {
            const res = await fetch(
                `${SERVER}/tile/${this.tx}/${this.ty}?cacheOnly=true`,
                { signal },
            );
            if (res.status === 404) { this.state = 'waiting'; return; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!signal.aborted) this._processData(data);
        } catch (e) {
            this._removePlaceholder();
            if (e.name !== 'AbortError') {
                console.warn(`Tile (${this.tx},${this.ty}) check: ${e.message}`);
                this.state = 'idle'; // transient error — allow retry next cycle
            }
        }
    }

    async fetchDirect() {
        if (this.state !== 'idle') return;
        this.state = 'fetching';
        this.lastChecked = Date.now();
        this._ensurePlaceholder();

        const { signal } = this._abort;
        try {
            const data = await fetchOSM(this.tx, this.ty, 5, signal);
            if (!signal.aborted) this._processData(data);
        } catch (e) {
            this._removePlaceholder();
            if (e.name === 'AbortError') this.state = 'idle';
            else {
                console.warn(`Tile (${this.tx},${this.ty}) fetch: ${e.message}`);
                this.state = 'failed';
            }
        }
    }

    dispose() {
        this._abort.abort();
        this._removePlaceholder();
        scene.remove(this.group);
        this.group.traverse(obj => {
            if (!obj.isMesh) return;
            obj.geometry?.dispose();
        });
    }
}


class TileLoader {
    constructor() {
        this._active = 0;
        this._queue  = [];
    }

    update(priorityList, tileMap) {
        if (useServer) this._pushPriority(priorityList);

        this._queue = [];
        for (const { tx, ty, dist } of priorityList) {
            const tile = tileMap.get(`${tx},${ty}`);
            if (!tile || tile.done || tile.loading) continue;
            if (tile.state === 'idle' || tile.shouldRetry()) {
                this._queue.push({ tile, dist });
            }
        }

        this._drain();
    }

    _drain() {
        const limit = useServer ? POLL_CONCURRENCY : FETCH_CONCURRENCY;
        while (this._active < limit && this._queue.length > 0) {
            const { tile } = this._queue.shift();
            if (tile.done || tile.loading) continue;
            this._active++;
            (useServer ? tile.checkCache() : tile.fetchDirect())
                .finally(() => { this._active--; this._drain(); });
        }
    }

    _pushPriority(priorityList) {
        fetch(`${SERVER}/priority`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                tiles: priorityList.map(({ tx, ty, dist }) => ({ tx, ty, dist })),
            }),
            signal: AbortSignal.timeout(1500),
        }).catch(() => {}); // non-critical, ignore errors silently
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
        const rawList = buildPriorityList();
        if (!rawList.length) return;
        const list = rawList.slice(0, MAX_TILES);

        const wantedKeys = new Set(list.map(({ tx, ty }) => this._key(tx, ty)));
        const now        = Date.now();

        const vc = (() => {
            const p = getGroundPoint(0, 0);
            if (p) return worldToFracTile(p.x, p.z);
            const { tx, ty } = camTile();
            return { ftx: tx + 0.5, fty: ty + 0.5 };
        })();

        const maxViewDist = list[list.length - 1].dist;
        const evictDist   = maxViewDist + EVICT_BUFFER;

        for (const [key, tile] of this.map) {
            if (wantedKeys.has(key)) {
                tile.lastWanted = now;
                continue;
            }
            if (tile.loading) continue;

            const dist      = Math.hypot(tile.tx + 0.5 - vc.ftx, tile.ty + 0.5 - vc.fty);
            const graceOver = (now - tile.lastWanted) > EVICT_GRACE_MS;

            if (dist > evictDist && graceOver) {
                tile.dispose();
                this.map.delete(key);
            }
        }

        for (const { tx, ty } of list) {
            const key = this._key(tx, ty);
            if (!this.map.has(key)) this.map.set(key, new Tile(tx, ty));
        }

        this.loader.update(list, this.map);
    }
}


const livePos     = document.getElementById('livepos');
const lonInput    = document.getElementById('lonin');
const latInput    = document.getElementById('latin');
const goButton    = document.getElementById('gotopos');
const dirText     = document.getElementById('dir');
const northButton = document.getElementById('north');
const poiButton   = document.getElementById('poi');
const wideButton  = document.getElementById('wide');
const angleSlider = document.getElementById('angle');

let angleSliderVal;

function updateLivePos() {
    const lon = ORIGIN.lon + camera.position.x / LON_M;
    const lat = ORIGIN.lat - camera.position.z / LAT_M;
    if (livePos) livePos.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function updateDir() {
    camera.getWorldDirection(_lookDir);
    _lookDir.y = 0;
    const len = _lookDir.length();
    if (len < 0.001) { dirText.textContent = '—'; return; }
    _lookDir.divideScalar(len);
    const angle = Math.atan2(_lookDir.x, -_lookDir.z);
    const t = ((angle / (Math.PI * 2)) + 1) % 1;
    dirText.textContent = t.toFixed(2);
}

angleSlider.addEventListener('change', () => {
    angleSliderVal = angleSlider.value / 100;
    console.log(angleSliderVal);
});

goButton.addEventListener('click', () => {
    const lon = parseFloat(lonInput.value);
    const lat = parseFloat(latInput.value);
    if (isNaN(lon) || isNaN(lat)) return;

    const wx = (lon - ORIGIN.lon) * LON_M;
    const wz = -(lat - ORIGIN.lat) * LAT_M;
    const dx = wx - camera.position.x;
    const dz = wz - camera.position.z;

    camera.position.x += dx;
    camera.position.z += dz;
    controls.target.x += dx;
    controls.target.z += dz;
    controls.update();
});

northButton.addEventListener('click', () => {
    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const hDist  = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
    camera.position.set(target.x, camera.position.y, target.z + hDist);
    controls.update();
});

poiButton.addEventListener('click', () => {
    const target  = controls.target;
    const offset  = camera.position.clone().sub(target);
    const azimuth = Math.atan2(offset.x, offset.z);
    const newY    = 100;
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

wideButton.addEventListener('click', () => {
    const target = controls.target;
    camera.position.set(target.x, target.y + 1500, target.z);
    controls.update();
    lockCurrentTilt();
});

function updateIO() {
    updateLivePos();
    updateDir();
}

function resizeRenderer() {
    const canvas = renderer.domElement;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
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