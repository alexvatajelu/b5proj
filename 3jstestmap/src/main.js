import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'


const ORIGIN    = { lat: 51.505, lon: -0.09 };
const TILE_DEG  = 0.005;
const LAT_M     = 110540;
const LON_M     = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const TILE_W    = TILE_DEG * LON_M;
const TILE_H    = TILE_DEG * LAT_M;

const AREA_INIT    = 2;
const AREA_RETILE  = 2;
const MAX_TILES    = 60;
const RETILE_MS    = 400;

const SERVER = 'http://localhost:3000';
let useServer = false;

async function detectServer() {
    try {
        const res = await fetch(`${SERVER}/health`, {
            signal: AbortSignal.timeout(1000)
        });
        useServer = res.ok;
    } catch {
        useServer = false;
    }
    console.log(useServer ? '[server] cache server detected' : '[server] not found — using Overpass directly');
}
 
await detectServer();


const CWIDTH  = window.innerWidth;
const CHEIGHT = window.innerHeight;

const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(50, CWIDTH / CHEIGHT, 1, 8000);
camera.position.set(0, 800, 0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
    canvas:    document.querySelector('#canvas'),
    antialias: true
});
renderer.setSize(CWIDTH, CHEIGHT);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.08;
controls.minDistance      = 80;
controls.maxDistance      = 3000;
controls.minPolarAngle    = 0;
controls.maxPolarAngle    = Math.PI/2;
controls.position0 = 0;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(300, 600, 200);
scene.add(sun);


const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20000, 20000),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1;
scene.add(ground);


function tileLatLon(tx, ty) {
    return {
        lat: ORIGIN.lat + ty * TILE_DEG,
        lon: ORIGIN.lon + tx * TILE_DEG
    };
}

function toWorld(lat, lon) {
    return {
        x:  (lon - ORIGIN.lon) * LON_M,
        z: -(lat - ORIGIN.lat) * LAT_M
    };
}

function camTile() {
    return {
        tx: Math.floor( camera.position.x / TILE_W),
        ty: Math.floor(-camera.position.z / TILE_H)
    };
}


async function fetchOSM(tx, ty) {
    if (useServer) {
        const res = await fetch(`${SERVER}/tile/${tx}/${ty}`);
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
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
    if (tags.height)                  h = parseFloat(tags.height) || h;
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


const _markerGeo = new THREE.SphereGeometry(6, 7, 7);
const _markerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x1133aa });

class Tile {
    constructor(tx, ty) {
        this.tx = tx;
        this.ty = ty;
        this.group = new THREE.Group();
        scene.add(this.group);
        this._load();
    }

    async _load() {
        const cx = (this.tx + 0.5) * TILE_W;
        const cz = -(this.ty + 0.5) * TILE_H;
        const placeholder = new THREE.Mesh(
            new THREE.PlaneGeometry(TILE_W - 2, TILE_H - 2),
            new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true })
        );
        placeholder.rotation.x = -Math.PI / 2;
        placeholder.position.set(cx, 0, cz);
        this.group.add(placeholder);

        try {
            const data    = await fetchOSM(this.tx, this.ty);
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
        } catch (e) {
            console.warn(`Tile (${this.tx},${this.ty}) failed:`, e.message);
        } finally {
            this.group.remove(placeholder);
            placeholder.geometry.dispose();
            placeholder.material.dispose();
        }
    }

    dispose() {
        scene.remove(this.group);
        this.group.traverse(obj => {
            if (!obj.isMesh) return;
            obj.geometry?.dispose();
            const m = obj.material;
            Array.isArray(m) ? m.forEach(x => x.dispose()) : m?.dispose();
        });
    }
}


class Tiles {
    constructor() {
        this.map = new Map();
        const { tx, ty } = camTile();
        for (let dx = -AREA_INIT; dx <= AREA_INIT; dx++) {
            for (let dy = -AREA_INIT; dy <= AREA_INIT; dy++) {
                this._add(tx + dx, ty + dy);
            }
        }
    }

    _key(tx, ty) { return `${tx},${ty}`; }

    _add(tx, ty) {
        const key = this._key(tx, ty);
        if (!this.map.has(key)) this.map.set(key, new Tile(tx, ty));
    }

    _remove(tx, ty) {
        const key  = this._key(tx, ty);
        const tile = this.map.get(key);
        if (!tile) return;
        tile.dispose();
        this.map.delete(key);
    }

    retile() {
        const { tx, ty } = camTile();

        for (let dx = -AREA_RETILE; dx <= AREA_RETILE; dx++) {
            for (let dy = -AREA_RETILE; dy <= AREA_RETILE; dy++) {
                this._add(tx + dx, ty + dy);
            }
        }

        if (this.map.size <= MAX_TILES) return;

        const sorted = [...this.map.values()]
            .sort((a, b) =>
                (Math.abs(b.tx - tx) + Math.abs(b.ty - ty)) -
                (Math.abs(a.tx - tx) + Math.abs(a.ty - ty))
            );

        const excess = this.map.size - MAX_TILES;
        for (let i = 0; i < excess; i++) this._remove(sorted[i].tx, sorted[i].ty);
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