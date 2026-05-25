import './style.css'

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const CWidth = window.innerWidth;
const CHeight = window.innerHeight;

const mapScale = 0.01;
const LatLonCen = [51.50, -0.12];
const LatLonGridSize = [0.02, 0.04];

const markerSize = 30;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, CWidth / CHeight, 0.1, 100000);
camera.position.z = 20;
camera.position.y = 10;
//camera.rotateX(-0.1);

const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector('#canvas'),
});
renderer.setSize(CWidth, CHeight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);
const overheadLight = new THREE.DirectionalLight(0xffffff, 10);
overheadLight.position.set(0, 40, 0);
scene.add(overheadLight);


const map1Loader = new FBXLoader();
//const map1Mesh = await map1Loader.loadAsync('src/assets/scaled2cubemap.fbx');
const map1Mesh = await map1Loader.loadAsync('src/assets/same unedit.fbx');
const map1WFMat = new THREE.MeshBasicMaterial({ color: 0x0000ff, wireframe: true });
const map1Mat = new THREE.MeshStandardMaterial({ color: 0x0000ff, wireframe: false });
map1Mesh.traverse((child) => {
  if (child.isMesh) {
    child.material = map1Mat;
  }
});
map1Mesh.scale.set(mapScale, mapScale, mapScale);
scene.add(map1Mesh);

//marker start

// marker space is LatLonCen to LatLonCen + LatLonGridSize, scale 1 unit is 1 metre

const markerBaseColHex = 0xffffff;
const markerSelectedColHex = 0xffff00;

const markerGroup = new THREE.Group();
scene.add(markerGroup);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMarker = null;
const tooltip = document.getElementById('tooltip');

const markerGeometry = new THREE.SphereGeometry(markerSize, markerSize, markerSize);
const markerMaterial = new THREE.MeshStandardMaterial({ color: markerBaseColHex, emissive: 0x000000 });

function formatTooltipData(info) {
  const title = info.tags?.name || info.tags?.brand || 'Location';
  const address = [info.tags?.['addr:housenumber'], info.tags?.['addr:street']].filter(Boolean).join(' ');
  const city = "";//info.tags?.['addr:city'];
  const open = "";//info.tags?.opening_hours ? `<div><strong>Hours:</strong> ${info.tags.opening_hours}</div>` : '';
  const shop = "";//info.tags?.shop ? `<div><strong>Type:</strong> ${info.tags.shop}</div>` : '';
  const website = "";//info.tags?.website ? `<div><a href="${info.tags.website}" target="_blank" rel="noreferrer" style="color:#a8d8ff;">Website</a></div>` : '';
  return `<div style="font-weight:700;margin-bottom:4px;">${title}</div>${address ? `<div>${address}${city ? ', ' + city : ''}</div>` : ''}${shop}${open}${website}`;
}

function updateTooltip(intersect, event) {
  if (intersect) {
    const info = intersect.object.userData;
    tooltip.style.display = 'block';
    tooltip.innerHTML = formatTooltipData(info);
    tooltip.style.left = `${event.clientX + 12}px`;
    tooltip.style.top = `${event.clientY + 12}px`;
  } else {
    tooltip.style.display = 'none';
  }
}

function setHoverState(object) {
  if (hoveredMarker && hoveredMarker !== object) {
    hoveredMarker.material.color.setHex(markerBaseColHex);
    hoveredMarker.material.emissive.setHex(0x000000);
  }
  hoveredMarker = object;
  if (hoveredMarker) {
    hoveredMarker.material.color.setHex(markerSelectedColHex);
    hoveredMarker.material.emissive.setHex(0x444444);
  }
}

window.addEventListener('pointermove', (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(markerGroup.children, false);
  const hit = intersects.length ? intersects[0] : null;
  setHoverState(hit?.object || null);
  updateTooltip(hit, event);
});

async function loadLocationMarkers() {
  const data = await fetch(new URL('./assets/5150,5152,-012,-008.json', import.meta.url)).then((res) => res.json());
  const nodes = data.elements.filter((element) => element.type === 'node');
  if (nodes.length === 0) return;

  // Use your defined map centre, NOT the average of nodes
  const centerLat = LatLonCen[0] + (LatLonGridSize[0] / 2);
  const centerLon = LatLonCen[1] + (LatLonGridSize[1] / 2);

  const latScale = 110540;                                          // metres per degree latitude
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180);  // metres per degree longitude (adjusted for latitude)

  for (const node of nodes) {
    const marker = new THREE.Mesh(markerGeometry, markerMaterial.clone());

    // Convert lat/lon offset to metres, then apply the same mapScale as the FBX
    marker.position.x = (node.lon - centerLon) * lonScale;
    marker.position.z = (centerLat - node.lat) * latScale;
    marker.position.y = 10;

    marker.userData = {
      id: node.id,
      type: node.type,
      lat: node.lat,
      lon: node.lon,
      tags: node.tags || {},
    };
    markerGroup.add(marker);
  }
}

await loadLocationMarkers();



//marker end

const floorGeo = new THREE.PlaneGeometry(10000, 10000);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x800000 });
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.position.y = -0.01;
scene.add(floorMesh);

const gridHelper = new THREE.GridHelper( 1000, 1000 );
gridHelper.position.y = 10;
scene.add( gridHelper );

const OrbitControl = new OrbitControls(camera, renderer.domElement);

function animate() {
    requestAnimationFrame(animate);

    floorMesh.position.x = camera.position.x;
    floorMesh.position.z = camera.position.z;

    OrbitControl.update();
    renderer.render(scene, camera);
}

animate();