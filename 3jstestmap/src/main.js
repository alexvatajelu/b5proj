import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const CWIDTH = window.innerWidth;
const CHEIGHT = window.innerHeight;

const maxTiles      = 150;

const VIEW_BUFFER   = 4;
const BOTTOM_BUFFER = 2;

const TILESIZE = { lat: 1, lon: 1 };
const ORIGIN   = { lat: 0, lon: 0 };


const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(10, CWIDTH / CHEIGHT, 0.01, 1000);
camera.position.set(0, 10, 0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#maincanvas'),
    antialias: true
});
renderer.setSize(CWIDTH, CHEIGHT);

const fixedCamera = new THREE.PerspectiveCamera(20, CWIDTH / CHEIGHT, 0.01, 1000);
fixedCamera.position.set(0, 50, 0);
fixedCamera.lookAt(0, 0, 0);

const fixedRenderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#sidecanvas'),
    antialias: true
});
fixedRenderer.setSize(CWIDTH * 0.4, CHEIGHT * 0.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI / 2;
controls.enableRotate = true;
controls.enablePan    = true;
controls.enableZoom   = true;

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(5, 10, 5);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));

const cameraHelper = new THREE.CameraHelper(camera);
scene.add(cameraHelper);

const floorPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshBasicMaterial({ color: 0x220000 })
);
floorPlane.rotation.x = -Math.PI / 2;
floorPlane.position.y = -1;
scene.add(floorPlane);

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function getCameraIntersection(ndcX, ndcY, camera, plane) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const point = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, point);
    return point;
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect =
            ((yi > point.y - 0.5) !== (yj > point.y - 0.5)) &&
            (point.x - 0.5 < (xj - xi) * (point.y - 0.5 - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}



class Tile {
    constructor(x, y) {
        this.x = x;
        this.y = y;

        const geo = new THREE.PlaneGeometry(TILESIZE.lat, TILESIZE.lon);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xff0088,
            side: THREE.DoubleSide,
            wireframe: true
        });

        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.position.set(
            ORIGIN.lat + x * TILESIZE.lat,
            0,
            ORIGIN.lon + y * TILESIZE.lon
        );
        scene.add(this.mesh);
    }

    setColor(hex) {
        this.mesh.material.color.setHex(hex);
    }
}


class Tiles {
    constructor() {
        this.tiles   = [];
        this.tileMap = new Map();
        this.debugMarkers = [];

        camera.updateMatrixWorld();
        this.retile();
    }

    tileKey(x, y) { return `${x},${y}`; }

    addTile(x, y) {
        const key = this.tileKey(x, y);
        if (this.tileMap.has(key)) return;
        const tile = new Tile(x, y);
        this.tiles.push(tile);
        this.tileMap.set(key, tile);
    }

    removeTile(x, y) {
        const key = this.tileKey(x, y);
        if (!this.tileMap.has(key)) return;
        const tile = this.tileMap.get(key);
        scene.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
        this.tiles = this.tiles.filter(t => t !== tile);
        this.tileMap.delete(key);
    }

    getFrustumCorners() {
        return [
            getCameraIntersection(-1,  1, camera, groundPlane),
            getCameraIntersection( 1,  1, camera, groundPlane),
            getCameraIntersection( 1, -1, camera, groundPlane),
            getCameraIntersection(-1, -1, camera, groundPlane),
        ];
    }

    getBufferedCorners(corners) {
        const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
        const cz = corners.reduce((s, p) => s + p.z, 0) / 4;

        const farMidX  = (corners[0].x + corners[1].x) / 2;
        const farMidZ  = (corners[0].z + corners[1].z) / 2;
        const nearMidX = (corners[2].x + corners[3].x) / 2;
        const nearMidZ = (corners[2].z + corners[3].z) / 2;
        let ndx = nearMidX - farMidX;
        let ndz = nearMidZ - farMidZ;
        const nlen = Math.sqrt(ndx * ndx + ndz * ndz) || 1;
        ndx /= nlen;
        ndz /= nlen;

        return corners.map((p, i) => {
            const dx  = p.x - cx;
            const dz  = p.z - cz;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;

            const isNear = (i === 2 || i === 3);
            return {
                x: p.x + (dx / len) * VIEW_BUFFER + (isNear ? ndx * BOTTOM_BUFFER : 0),
                z: p.z + (dz / len) * VIEW_BUFFER + (isNear ? ndz * BOTTOM_BUFFER : 0),
            };
        });
    }

    tilesInPolygon(poly2d) {
        const xs = poly2d.map(p => p.x);
        const ys = poly2d.map(p => p.y);
        const minX = Math.floor(Math.min(...xs));
        const maxX = Math.ceil(Math.max(...xs));
        const minY = Math.floor(Math.min(...ys));
        const maxY = Math.ceil(Math.max(...ys));

        const result = [];
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, poly2d)) {
                    result.push({ x, y });
                }
            }
        }
        return result;
    }

    priority(x, y, cameraCentre) {
        const dx = x + 0.5 - cameraCentre.x;
        const dz = y + 0.5 - cameraCentre.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    priorityColor(p, maxP) {
        const t = maxP > 0 ? Math.min(p / maxP, 1) : 0;
        const r = Math.round(255 * Math.pow(1 - t, 0.7));
        const g = Math.round(120 * Math.sin(Math.PI * (1 - t)));
        const b = Math.round(255 * Math.pow(t, 0.7));
        return (r << 16) | (g << 8) | b;
    }

    updateColors() {
        if (!this.tiles.length) return;
        const cameraCentre = getCameraIntersection(0, 0, camera, groundPlane);
        const pvals = this.tiles.map(t => this.priority(t.x, t.y, cameraCentre));
        const maxP  = Math.max(...pvals);
        this.tiles.forEach((tile, i) => tile.setColor(this.priorityColor(pvals[i], maxP)));
    }


    retile() {
        const corners  = this.getFrustumCorners();
        const buffered = this.getBufferedCorners(corners);
        const poly2d   = buffered.map(p => ({ x: p.x, y: p.z }));

        const cameraCentre = getCameraIntersection(0, 0, camera, groundPlane);

        const desired = this.tilesInPolygon(poly2d)
            .sort((a, b) => this.priority(a.x, a.y, cameraCentre) - this.priority(b.x, b.y, cameraCentre));

        const desiredSet = new Set(desired.map(d => this.tileKey(d.x, d.y)));

        const existingDesired  = this.tiles.filter(t =>  desiredSet.has(this.tileKey(t.x, t.y)));
        const existingUnwanted = this.tiles
            .filter(t => !desiredSet.has(this.tileKey(t.x, t.y)))
            .sort((a, b) => this.priority(b.x, b.y, cameraCentre) - this.priority(a.x, a.y, cameraCentre));

        const toAdd = desired.filter(d => !this.tileMap.has(this.tileKey(d.x, d.y)));

        const budget = maxTiles - existingDesired.length;

        const evictCount = Math.max(0, existingUnwanted.length + toAdd.length - budget);
        for (let i = 0; i < Math.min(evictCount, existingUnwanted.length); i++) {
            this.removeTile(existingUnwanted[i].x, existingUnwanted[i].y);
        }

        const canAdd = maxTiles - this.tiles.length;
        for (let i = 0; i < Math.min(toAdd.length, canAdd); i++) {
            this.addTile(toAdd[i].x, toAdd[i].y);
        }

        this.updateColors();

        this.updateDebugMarkers(corners, buffered);
    }


    updateDebugMarkers(corners, buffered) {
        for (const { mesh, geo, mat } of this.debugMarkers) {
            scene.remove(mesh);
            geo.dispose();
            mat.dispose();
        }
        this.debugMarkers = [];

        const addMarker = (x, z, color, size = 0.1) => {
            const geo  = new THREE.SphereGeometry(size, 8, 8);
            const mat  = new THREE.MeshBasicMaterial({ color });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, 0, z);
            scene.add(mesh);
            this.debugMarkers.push({ mesh, geo, mat });
        };

        for (const c of corners)  addMarker(c.x, c.z, 0x00ff00);         // raw frustum: green
        for (const c of buffered) addMarker(c.x, c.z, 0xffff00, 0.14);   // buffered:    yellow
    }
}



const tiles = new Tiles();

let queuedRetile   = false;
let lastRetileTime = 0;
const RETILE_COOLDOWN = 200; // ms

controls.addEventListener('change', () => { queuedRetile = true; });

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();

    if (queuedRetile && now - lastRetileTime > RETILE_COOLDOWN) {
        tiles.retile();
        lastRetileTime = now;
        queuedRetile   = false;
    }

    controls.update();
    renderer.render(scene, camera);
    fixedRenderer.render(scene, fixedCamera);
}

animate();