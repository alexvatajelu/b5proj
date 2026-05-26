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
const VIEW_BIAS     = 0.55;

const EVICT_BUFFER  = 1;

const CONCURRENCY    = 3;
const MAX_QUEUE      = 24;
const MAX_TILES      = 80;

const RETILE_MS   = 350;

const SERVER = 'http://localhost:3000';
let useServer = false;

async function detectServer() {
    try {
        const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(1000) });
        useServer = res.ok;
    } catch {
        useServer = false;
    }
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

const renderer = new THREE.WebGLRenderer({
    canvas:    document.querySelector('#canvas'),
    antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance   = 80;
controls.maxDistance   = 3000;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI / 2;

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

const _lookDir = new THREE.Vector3();

function getViewBiasedCenter() {
    const { tx, ty } = camTile();
    camera.getWorldDirection(_lookDir);
    _lookDir.y = 0;

    const len = _lookDir.length();
    if (len < 0.001) return { cx: tx, cy: ty };
    _lookDir.divideScalar(len);

    const bias = getLoadRadius() * VIEW_BIAS;
    return {
        cx: tx + _lookDir.x * bias,
        cy: ty - _lookDir.z * bias,
    };
}

function buildPriorityList() {
    const radius    = getLoadRadius();
    const { cx, cy } = getViewBiasedCenter();

    const list = [];
    const span = radius + 1;

    for (let dx = -span; dx <= span; dx++) {
        for (let dy = -span; dy <= span; dy++) {
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
    if (tags.height)                  h = parseFloat(tags.height)       || h;
    else if (tags['building:levels']) h = parseInt(tags['building:levels']) * 3;

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    shape.closePath();

    try {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
        const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.85 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.tags = tags;
        return mesh;
    } catch { return null; }
}

class Tile {
    constructor(tx, ty) {
        this.tx      = tx;
        this.ty      = ty;
        this.loading = false;
        this.loaded  = false;
        this.failed  = false;
        this.group   = new THREE.Group();
        this._abort  = new AbortController();
        scene.add(this.group);
    }

    get done() { return this.loaded || this.failed; }

    startLoad(priority = 5) {
        if (this.loading || this.done) return Promise.resolve();
        this.loading = true;
        return this._load(priority);
    }

    async _load(priority) {
        const cx = (this.tx + 0.5) * TILE_W;
        const cz = -(this.ty + 0.5) * TILE_H;

        const placeholder = new THREE.Mesh(
            new THREE.PlaneGeometry(TILE_W - 2, TILE_H - 2),
            new THREE.MeshBasicMaterial({ color: 0x334466, wireframe: true }),
        );
        placeholder.rotation.x = -Math.PI / 2;
        placeholder.position.set(cx, 0, cz);
        this.group.add(placeholder);

        try {
            const data = await fetchOSM(this.tx, this.ty, priority, this._abort.signal);

            if (this._abort.signal.aborted) return;

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
            this.loaded = true;
        } catch (e) {
            if (e.name === 'AbortError') {
            } else {
                console.warn(`Tile (${this.tx},${this.ty}) failed:`, e.message);
                this.failed = true;
            }
        } finally {
            this.loading = false;
            this.group.remove(placeholder);
            placeholder.geometry.dispose();
            placeholder.material.dispose();
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
        this.queue  = [];
        this.active = 0;
    }

    /**
     * @param {Array<{tx,ty,dist}>} priorityList
     * @param {Map<string, Tile>}   tileMap
     */
    update(priorityList, tileMap) {
        const wantedKeys = new Set(priorityList.map(p => `${p.tx},${p.ty}`));

        this.queue = this.queue.filter(item => wantedKeys.has(`${item.tx},${item.ty}`));

        for (const p of priorityList) {
            const key  = `${p.tx},${p.ty}`;
            const tile = tileMap.get(key);
            if (!tile || tile.loading || tile.done)                         continue;
            if (this.queue.some(q => q.tx === p.tx && q.ty === p.ty))      continue;
            this.queue.push({ tx: p.tx, ty: p.ty, dist: p.dist, tile });
        }

        this.queue.sort((a, b) => a.dist - b.dist);

        if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE;

        this._drain();
    }

    _drain() {
        while (this.active < CONCURRENCY && this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item.tile || item.tile.loading || item.tile.done) continue;

            this.active++;
            const serverPriority = Math.max(1, Math.round(item.dist));
            item.tile.startLoad(serverPriority).finally(() => {
                this.active--;
                this._drain();
            });
        }
    }
}


class Tiles {
    constructor() {
        this.map    = new Map();   // key → Tile
        this.loader = new TileLoader();
        this.retile();
    }

    _key(tx, ty) { return `${tx},${ty}`; }

    retile() {
        const list        = buildPriorityList();
        const loadRadius  = getLoadRadius();
        const evictRadius = loadRadius + EVICT_BUFFER;

        const { tx: ctx, ty: cty } = camTile();
        const evictKeys = new Set();
        const span = evictRadius + 1;
        for (let dx = -span; dx <= span; dx++) {
            for (let dy = -span; dy <= span; dy++) {
                const tx = ctx + dx, ty = cty + dy;
                if (Math.hypot(tx + 0.5 - ctx - 0.5, ty + 0.5 - cty - 0.5) <= evictRadius + 0.5) {
                    evictKeys.add(this._key(tx, ty));
                }
            }
        }

        for (const [key, tile] of this.map) {
            if (!evictKeys.has(key)) {
                tile.dispose();
                this.map.delete(key);
            }
        }

        if (this.map.size > MAX_TILES) {
            const sorted = [...this.map.values()].sort((a, b) =>
                Math.hypot(b.tx - ctx, b.ty - cty) -
                Math.hypot(a.tx - ctx, a.ty - cty),
            );
            const excess = this.map.size - MAX_TILES;
            for (let i = 0; i < excess; i++) {
                const tile = sorted[i];
                tile.dispose();
                this.map.delete(this._key(tile.tx, tile.ty));
            }
        }

        for (const { tx, ty } of list) {
            const key = this._key(tx, ty);
            if (!this.map.has(key)) this.map.set(key, new Tile(tx, ty));
        }

        this.loader.update(list, this.map);
    }
}

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

    controls.update();
    renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});