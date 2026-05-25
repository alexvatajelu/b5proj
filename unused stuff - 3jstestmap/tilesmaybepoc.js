import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TileManager, latLonToWorld } from './tilemanagerpoc.js';


const CWidth  = window.innerWidth;
const CHeight = window.innerHeight;

const ORIGIN = { lat: 51.505, lon: -0.09 };

const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c1e);
scene.fog        = new THREE.Fog(0x1a1c1e, 1500, 10000);

const camera = new THREE.PerspectiveCamera(60, CWidth / CHeight, 0.1, 10000);
camera.position.set(0, 200, 0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  canvas:    document.querySelector('#canvas'),
  antialias: true,
});
renderer.setSize(CWidth, CHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;


const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff5e0, 3);
sun.position.set(200, 400, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near   = 1;
sun.shadow.camera.far    = 3000;
sun.shadow.camera.left   = -1000;
sun.shadow.camera.right  = 1000;
sun.shadow.camera.top    = 1000;
sun.shadow.camera.bottom = -1000;
scene.add(sun);


const groundMat  = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 1 });
const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);


const buildingMaterial = new THREE.MeshStandardMaterial({
  color:    0x8899aa,
  roughness: 0.85,
  metalness: 0.05,
});

const markerMaterial = new THREE.MeshStandardMaterial({
  color:   0xffffff,
  emissive: 0x224466,
  emissiveIntensity: 0.5,
});

const tileManager = new TileManager(scene, {
  origin:    ORIGIN,
  tileSizeDeg:  0.008,
  viewRadius:   2,
  maxCacheSize: 36,
  buildingMaterial,
  markerMaterial,
  defaultBuildingHeight: 12,
  buildingFloorHeight:   3,
});

tileManager.preload(ORIGIN.lat, ORIGIN.lon);


const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();
const tooltip   = document.getElementById('tooltip');
let hoveredObj  = null;

window.addEventListener('pointermove', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  const hit  = hits.find((h) => h.object.userData?.tags);

  if (hit) {
    if (hoveredObj && hoveredObj !== hit.object) resetHover(hoveredObj);
    hoveredObj = hit.object;
    hoveredObj.material.emissive?.setHex(0x334455);

    const tags   = hit.object.userData.tags ?? {};
    const name   = tags.name || tags.brand || tags.amenity || tags.shop || 'Building';
    const addr   = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const levels = tags['building:levels'] ? `${tags['building:levels']} floors` : '';

    tooltip.innerHTML = `<strong>${name}</strong>${addr ? `<br>${addr}` : ''}${levels ? `<br>${levels}` : ''}`;
    tooltip.style.display = 'block';
    tooltip.style.left    = `${e.clientX + 14}px`;
    tooltip.style.top     = `${e.clientY + 14}px`;
  } else {
    if (hoveredObj) resetHover(hoveredObj);
    hoveredObj = null;
    tooltip.style.display = 'none';
  }
});

function resetHover(obj) {
  if (obj.material?.emissive) obj.material.emissive.setHex(0x000000);
}


const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.08;
controls.minDistance      = 50;
controls.maxDistance      = 4000;
controls.maxPolarAngle    = Math.PI / 2.1;

controls.addEventListener('change', () => {
  groundMesh.position.x = camera.position.x;
  groundMesh.position.z = camera.position.z;
});


let _lastTileCheck = 0;

function animate(now) {
  requestAnimationFrame(animate);
  controls.update();

  if (now - _lastTileCheck > 250) {
    tileManager.update(camera.position);
    _lastTileCheck = now;
  }

  renderer.render(scene, camera);
}

animate(0);


window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


window.addEventListener('beforeunload', () => tileManager.dispose());