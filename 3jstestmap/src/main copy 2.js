import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { color } from 'three/src/nodes/tsl/TSLCore.js';

console.log("tiles");

const CWIDTH = window.innerWidth;
const CHEIGHT = window.innerHeight;

const areaInit = 3;
const areaRetile = 2;
const maxTiles = 100;

const TILESIZE = {
    lat: 1,
    lon: 1
};

const ORIGIN = {
    lat: 0,
    lon: 0
};

const BUFFER = 3;
const BOTTOM_BUFFER = 8;



const scene = new THREE.Scene();


const camera = new THREE.PerspectiveCamera(
    10,
    CWIDTH / CHEIGHT,
    0.01,
    1000
);
camera.position.set(0, 6, 0);
const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#maincanvas'),
    antialias: true
});
renderer.setSize(CWIDTH, CHEIGHT);


const fixedCamera = new THREE.PerspectiveCamera(
    20,
    CWIDTH / CHEIGHT,
    0.01,
    1000
);
fixedCamera.position.set(0, 50, 0);
fixedCamera.lookAt(0, 0, 0);

const fixedRenderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#sidecanvas'),
    antialias: true
})
fixedRenderer.setSize(CWIDTH * 0.4, CHEIGHT * 0.4);


const controls = new OrbitControls(camera, renderer.domElement);
camera.position.set(0, 10, 0);
camera.lookAt(0, 0, 0);

controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI/2;

controls.enableRotate = true;

controls.enablePan = true;
controls.enableZoom = true;


const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(5, 10, 5);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));

const cameraHelper = new THREE.CameraHelper(camera);
scene.add(cameraHelper);

const floorPlaneGeo = new THREE.PlaneGeometry(100, 100);
const floorPlaneMat = new THREE.MeshBasicMaterial({
    color: 0x220000
});
const floorPlane = new THREE.Mesh( floorPlaneGeo, floorPlaneMat );
floorPlane.rotation.x = -Math.PI / 2;
floorPlane.position.y = -1;
scene.add( floorPlane );

const groundPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    0
);

function getCameraIntersection(ndcX, ndcY, camera, object) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
        new THREE.Vector2(ndcX, ndcY),
        camera
    );
    const point = new THREE.Vector3();
    raycaster.ray.intersectPlane(
        object,
        point
    );
    return point;
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (
        let i = 0, j = polygon.length - 1;
        i < polygon.length;
        j = i++
    ) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersect =
            ((yi > point.y) !== (yj > point.y)) &&
            (
                point.x <
                (xj - xi) *
                (point.y - yi) /
                (yj - yi) +
                xi
            );
        if (intersect) inside = !inside;
    }
    return inside;
}



class Tile {
    constructor(x, y) {
        this.x = x;
        this.y = y;

        this.lat = ORIGIN.lat + x * TILESIZE.lat;
        this.lon = ORIGIN.lon + y * TILESIZE.lon;

        const geo = new THREE.PlaneGeometry(
            TILESIZE.lat,
            TILESIZE.lon
        );

        const mat = new THREE.MeshStandardMaterial({
            color: 0xff0088,
            side: THREE.DoubleSide,
            wireframe: true
        });

        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.position.set(this.lat, 0, this.lon);
        scene.add(this.mesh);
    }
}


class Tiles {
    constructor() {
        this.tiles = [];
        this.tileMap = new Map();
        this.cornerMarkers = [];
        for (let x = -areaInit; x <= areaInit; x++) {
            for (let y = -areaInit; y <= areaInit; y++) {
                this.newTile(x, y);
            }
        }
    }
    
    tileKey(x, y) {
        return `${x},${y}`;
    }

    newTile(x, y) {
        const key = this.tileKey(x, y);

        if (this.tileMap.has(key)) {
            return;
        }

        const tile = new Tile(x, y);

        this.tiles.push(tile);
        this.tileMap.set(key, tile);
    }

    deleteTile(x, y) {
        const key = this.tileKey(x, y);

        if (!this.tileMap.has(key)) {
            return;
        }

        const tile = this.tileMap.get(key);

        scene.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
        this.tiles = this.tiles.filter(t => t !== tile);
        this.tileMap.delete(key);
    }

    xy2latlon(x, y) {
        return {
            lat: ORIGIN.lat + x * TILESIZE.lat,
            lon: ORIGIN.lon + y * TILESIZE.lon
        };
    }

    latlon2xy(lat, lon) {
        return {
            x: Math.floor((lat - ORIGIN.lat) / TILESIZE.lat),
            y: Math.floor((lon - ORIGIN.lon) / TILESIZE.lon)
        };
    }



    drawCorners() {
        for (const marker of this.cornerMarkers) {
            scene.remove(marker);
            marker.geometry.dispose();
            marker.material.dispose();
        }

        this.cornerMarkers = [];

        const corners = [
            getCameraIntersection(-1,  1, camera, groundPlane),
            getCameraIntersection( 1,  1, camera, groundPlane),
            getCameraIntersection( 1, -1, camera, groundPlane),
            getCameraIntersection(-1, -1, camera, groundPlane),
        ];

        const cornerMarkerMat = new THREE.MeshBasicMaterial({
            color: 0x00ff00
        });

        for (let i = 0; i < corners.length; i++) {
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(0.15, 16, 16),
                cornerMarkerMat
            );

            marker.position.copy(corners[i]);
            scene.add(marker);
            this.cornerMarkers.push(marker);
        }

        const poly = corners.map(p => ({
            x: p.x,
            y: p.z
        }));

        poly[2].y += BOTTOM_BUFFER;
        poly[3].y += BOTTOM_BUFFER;

        const minX = Math.floor(Math.min(...poly.map(p => p.x))) - BUFFER;
        const maxX = Math.ceil(Math.max(...poly.map(p => p.x))) + BUFFER;

        const minY = Math.floor(Math.min(...poly.map(p => p.y))) - BUFFER;
        const maxY = Math.ceil(Math.max(...poly.map(p => p.y))) + BUFFER;

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const center = {
                    x: x + 0.5,
                    y: y + 0.5
                };

                if (pointInPolygon(center, poly)) {
                    this.newTile(x, y);
                }
            }
        }
    }

    calculatePriority(x, y, centerPoint) {

        const tileCenterX = x + 0.5;
        const tileCenterY = y + 0.5;

        const dx = tileCenterX - centerPoint.x;
        const dy = tileCenterY - centerPoint.y;

        const centreDist = Math.sqrt(dx * dx + dy * dy);

        const camDx = tileCenterX - camera.position.x;
        const camDy = tileCenterY - camera.position.z;

        const cameraDist =
            Math.sqrt(camDx * camDx + camDy * camDy);

        return centreDist * 0.7 +
            cameraDist * 0.3;
    }   
}

/*

switch tile selection to based off view completely

include buffer tiles around view, extra buffer on bottom from bottom corners

give each tile (including previous) a priority based on distance (closest to centre and camera highest priority)
colour tiles based on priority

draw tiles and keep previous tiles until tile limit, then start replacing old tiles, then if still more new tiles then limit, stop drawing 

*/

const tiles = new Tiles();

let queuedRetile = false;
let lastRetileTime = 0;
const reloadTilesCooldown = 200;


controls.addEventListener('change', () => {
    queuedRetile = true;
});


function animate() {
    requestAnimationFrame(animate);
    const time = performance.now();

    if (time - lastRetileTime > reloadTilesCooldown && queuedRetile == true) {
        tiles.retile();
        tiles.drawCorners();
        lastRetileTime = time;
        queuedRetile = false;
    }

    controls.update();
    renderer.render(scene, camera);
    fixedRenderer.render(scene, fixedCamera);
}

animate();