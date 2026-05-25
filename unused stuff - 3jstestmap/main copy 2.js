import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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



const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
    40,
    CWIDTH / CHEIGHT,
    0.02,
    1000
);
camera.position.set(0, 6, 0);
const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#canvas'),
    antialias: true
});
renderer.setSize(CWIDTH, CHEIGHT);


const controls = new OrbitControls(camera, renderer.domElement);
camera.position.set(0, 5, 0);
camera.lookAt(0, 0, 0);

controls.minPolarAngle = 0;
controls.maxPolarAngle = 0;

controls.enableRotate = false;

controls.enablePan = true;
controls.enableZoom = true;


const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(5, 10, 5);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));




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

    retile() {
        const tx = Math.round(camera.position.x);
        const ty = Math.round(camera.position.z);

        for (let x = -areaRetile + tx; x <= areaRetile + tx; x++) {
            for (let y = -areaRetile + ty; y <= areaRetile + ty; y++) {
                this.newTile(x, y);
            }
        }

        if (this.tiles.length <= maxTiles) {
            return;
        }

        const sorted = [...this.tiles].sort((a, b) => {
            const da =
                Math.abs(a.x - tx) +
                Math.abs(a.y - ty);

            const db =
                Math.abs(b.x - tx) +
                Math.abs(b.y - ty);

            return db - da;
        });

        const excess = this.tiles.length - maxTiles;

        for (let i = 0; i < excess; i++) {
            const tile = sorted[i];
            this.deleteTile(tile.x, tile.y);
        }
    }
}

const tiles = new Tiles();


for (const tile of tiles.tiles) {
    console.log(tile.x, tile.y);
}


let lastRetileTime = 0;
const reloadTilesCooldown = 200;

function animate() {
    requestAnimationFrame(animate);
    const time = performance.now();


    if (time - lastRetileTime > reloadTilesCooldown) {
        tiles.retile();
        lastRetileTime = time;
    }

    controls.update();
    renderer.render(scene, camera);
}

animate();