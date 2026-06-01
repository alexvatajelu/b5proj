/**
 * MapCanvas.jsx
 *
 * Wraps the entire Three.js scene. All mutable Three.js state lives inside
 * the useEffect closure. Imperative methods are exposed via forwardRef so
 * the parent can drive the camera without re-rendering the canvas.
 *
 * Props
 *   onLivePosChange(string)  – called every ~200 ms with "lat, lon"
 *   onDirChange(string)      – called every ~200 ms with heading 0–1
 *   onPOIChange(html|'')     – called when hovered / selected POI changes
 *   style                    – optional style overrides for the wrapper div
 *
 * Ref methods
 *   gotoLocation(query) → Promise<{displayName}>
 *   resetDirection()
 *   setPOIView()
 *   setWideView()
 *   setShowSuspected(bool)
 */

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ─── constants ────────────────────────────────────────────────────────────────
const ORIGIN            = { lat: 51.505, lon: -0.09 };
const TILE_DEG          = 0.005;
const LAT_M             = 110540;
const LON_M             = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const TILE_W            = TILE_DEG * LON_M;
const TILE_H            = TILE_DEG * LAT_M;

const RADIUS_MIN        = 1;
const RADIUS_MAX        = 5;
const HEIGHT_MIN        = 100;
const HEIGHT_MAX        = 2000;
const CAM_FOV           = 30;
const VIEW_BIAS         = 0.55;
const VIEW_CLOSE        = 500;
const VIEW_FAR          = 2600;
const VIEW_BUFFER_T     = 1.5;
const BOTTOM_BUFFER_T   = 1.0;
const EVICT_BUFFER      = 1;
const EVICT_GRACE_MS    = 300;
const RETRY_AFTER_MS    = 1500;
const POLL_CONCURRENCY  = 8;
const FETCH_CONCURRENCY = 3;
const MAX_TILES         = 85;
const RETILE_MS         = 350;

const DATA_TILE_FACTOR  = 10;
const DATA_TILE_W       = TILE_W * DATA_TILE_FACTOR;
const DATA_TILE_H       = TILE_H * DATA_TILE_FACTOR;

const MATCH_M           = 20;

const COL_MAIN  = 0xff3322;
const COL_SUSP  = 0xffaaaa;
const COL_CONF  = 0xffffff;

const SERVER    = 'http://localhost:3000';

// ─── shared geometries / materials (created once, never disposed) ─────────────
const POI_GEO                    = new THREE.BoxGeometry(24, 20.1, 24);
const POI_SUSPECTED_MAT          = new THREE.MeshStandardMaterial({ color: COL_SUSP, roughness: 1 });
const POI_CONFIRMED_MAT          = new THREE.MeshStandardMaterial({ color: COL_CONF, roughness: 1 });
const POI_SUSPECTED_HOVER_MAT    = new THREE.MeshStandardMaterial({ color: COL_SUSP, roughness: 0.6 });
const POI_CONFIRMED_HOVER_MAT    = new THREE.MeshStandardMaterial({ color: COL_CONF, roughness: 0.6 });
const POI_SUSPECTED_SELECTED_MAT = new THREE.MeshStandardMaterial({ color: COL_SUSP, roughness: 0.4, emissive: new THREE.Color(COL_SUSP) });
const POI_CONFIRMED_SELECTED_MAT = new THREE.MeshStandardMaterial({ color: COL_CONF, roughness: 0.4, emissive: new THREE.Color(COL_CONF) });
const BUILDING_MAT               = new THREE.MeshStandardMaterial({ color: COL_MAIN, roughness: 1 });
const EMPTY_GRID_MAT             = new THREE.MeshBasicMaterial({ color: 0xbb3333, wireframe: true });
const PRE_LOAD_MAT               = new THREE.MeshBasicMaterial({ color: 0x222222, wireframe: true });

const POI_HEIGHT           = 2;
const POI_INFLUENCE_RADIUS = 16;

// ─── component ────────────────────────────────────────────────────────────────
const MapCanvas = forwardRef(function MapCanvas(
  { onLivePosChange, onDirChange, onPOIChange, style },
  ref,
) {
  const canvasRef     = useRef(null);
  const imperativeRef = useRef({});

  // keep callback refs stable so the main effect doesn't need to re-run
  const cbLivePos = useRef(onLivePosChange);
  const cbDir     = useRef(onDirChange);
  const cbPOI     = useRef(onPOIChange);
  useEffect(() => { cbLivePos.current = onLivePosChange; }, [onLivePosChange]);
  useEffect(() => { cbDir.current     = onDirChange;     }, [onDirChange]);
  useEffect(() => { cbPOI.current     = onPOIChange;     }, [onPOIChange]);

  useImperativeHandle(ref, () => ({
    gotoLocation:    (q) => imperativeRef.current.gotoLocation?.(q),
    resetDirection:  ()  => imperativeRef.current.resetDirection?.(),
    setPOIView:      ()  => imperativeRef.current.setPOIView?.(),
    setWideView:     ()  => imperativeRef.current.setWideView?.(),
    setShowSuspected:(v) => imperativeRef.current.setShowSuspected?.(v),
  }));

  // ── main Three.js effect (runs once) ────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let active    = true;   // becomes false on cleanup
    let animFrameId = null;
    let lastUIUpdate = 0;

    // ── mutable session state ────────────────────────────────────────────────
    let useServer     = false;
    let ignoredList   = [];
    let confirmedList = [];
    let showSuspected = true;

    // ── helper: CSV parsing ──────────────────────────────────────────────────
    function parseCSV(text) {
      const lines = text.trim().split('\n')
        .map(l => l.replace(/\r$/, '').trim())
        .filter(l => l && !l.startsWith('#'));
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map(h => h.trim());
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim());
        const obj = {};
        headers.forEach((h, i) => { if (vals[i] !== undefined) obj[h] = vals[i]; });
        return obj;
      });
    }
    function loadIgnoredCSV(text) {
      return parseCSV(text)
        .map(r => ({ lat: parseFloat(r.lat), lon: parseFloat(r.lon) }))
        .filter(r => !isNaN(r.lat) && !isNaN(r.lon));
    }
    function loadConfirmedCSV(text) {
      return parseCSV(text).map(r => {
        const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
        if (isNaN(lat) || isNaN(lon)) return null;
        const { lat: _a, lon: _b, ...rest } = r;
        return { lat, lon, tags: rest };
      }).filter(Boolean);
    }

    async function detectServer() {
      try {
        const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(1000) });
        useServer = res.ok;
      } catch { useServer = false; }
    }

    async function loadPOILists() {
      const tryLoad = async (url, parser) => {
        try {
          const res = await fetch(url);
          return res.ok ? parser(await res.text()) : [];
        } catch { return []; }
      };
      [ignoredList, confirmedList] = await Promise.all([
        tryLoad('/ignored.csv',   loadIgnoredCSV),
        tryLoad('/confirmed.csv', loadConfirmedCSV),
      ]);
    }

    // ── coordinate helpers ───────────────────────────────────────────────────
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
    function worldToFracTile(wx, wz) {
      return { ftx: wx / TILE_W, fty: -wz / TILE_H };
    }
    function matchCoord(lat, lon, list) {
      return list.find(e => {
        const dx = (lon - e.lon) * LON_M;
        const dz = (lat - e.lat) * LAT_M;
        return Math.hypot(dx, dz) < MATCH_M;
      }) ?? null;
    }
    function getLoadRadius() {
      const h = camera.position.y;
      const t = Math.min(1, Math.max(0, (h - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)));
      return Math.round(RADIUS_MIN + t * (RADIUS_MAX - RADIUS_MIN));
    }

    // ── scene setup ──────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);

    const camera = new THREE.PerspectiveCamera(CAM_FOV, canvas.clientWidth / canvas.clientHeight, 1, 8000);
    camera.position.set(0, 800, 0);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping      = true;
    controls.dampingFactor      = 0.08;
    controls.minDistance        = VIEW_CLOSE;
    controls.maxDistance        = VIEW_FAR;
    controls.minPolarAngle      = 0.01;
    controls.maxPolarAngle      = (Math.PI / 2) * 0.7;
    controls.screenSpacePanning = false;
    controls.rotateSpeed        = 0.2;
    controls.mouseButtons = {
      LEFT:   THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT:  THREE.MOUSE.ROTATE,
    };
    controls.touches = {
      ONE: THREE.TOUCH.PAN,
      TWO: THREE.TOUCH.ROTATE,
    };

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const mainSun = new THREE.DirectionalLight(0xffeeee, 2.0);
    const altSun  = new THREE.DirectionalLight(0xeeffff, 0.5);
    mainSun.position.set(30000, 60000, 20000);
    altSun.position.set(-300000, 0, 0);
    scene.add(mainSun);
    scene.add(altSun);

    // ── resize handler ───────────────────────────────────────────────────────
    function handleResize() {
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', handleResize);

    // ── raycasting / POI interaction ─────────────────────────────────────────
    const _poiMeshSet  = new Set();
    const raycaster    = new THREE.Raycaster();
    const _mouseNDC    = new THREE.Vector2();
    let hoveredPOI     = null;
    let selectedPOI    = null;
    let _savedCamState = null;
    let _animId        = null;
    let _ptrDown       = null;

    function getBaseMat(m)     { return m.userData.poiType === 'confirmed' ? POI_CONFIRMED_MAT          : POI_SUSPECTED_MAT; }
    function getHoverMat(m)    { return m.userData.poiType === 'confirmed' ? POI_CONFIRMED_HOVER_MAT     : POI_SUSPECTED_HOVER_MAT; }
    function getSelectedMat(m) { return m.userData.poiType === 'confirmed' ? POI_CONFIRMED_SELECTED_MAT  : POI_SUSPECTED_SELECTED_MAT; }

    function fmtHover(tags = {}) {
      const name   = tags.name || (tags.amenity || tags.shop || '').replace(/_/g, ' ') || 'Point of interest';
      const coords = tags._lat !== undefined ? ` · ${(+tags._lat).toFixed(5)}, ${(+tags._lon).toFixed(5)}` : '';
      return name + coords;
    }
    function fmtFull(tags = {}) {
      const rows = [];
      rows.push('SUSPECTED LOCATION');
      if (tags.name)    rows.push(tags.name);
      if (tags.amenity) rows.push(tags.amenity.replace(/_/g, ' '));
      if (tags.shop)    rows.push(`Shop · ${tags.shop.replace(/_/g, ' ')}`);
      const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      if (addr)         rows.push(addr);
      if (tags._lat !== undefined)
        rows.push(`<small>${(+tags._lat).toFixed(5)}, ${(+tags._lon).toFixed(5)}</small>`);
      return rows.join('<br>') || 'No details';
    }

    function refreshPOIOut() {
      if (selectedPOI)     cbPOI.current?.(fmtFull(selectedPOI.userData.tags));
      else if (hoveredPOI) cbPOI.current?.(fmtHover(hoveredPOI.userData.tags));
      else                 cbPOI.current?.('');
    }

    function hitPOI(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      _mouseNDC.set(
        ((clientX - r.left) / r.width)  *  2 - 1,
        ((clientY - r.top)  / r.height) * -2 + 1,
      );
      raycaster.setFromCamera(_mouseNDC, camera);
      const hits = raycaster.intersectObjects([..._poiMeshSet]);
      return hits.length ? hits[0].object : null;
    }

    // ── camera animation ─────────────────────────────────────────────────────
    function animateTo(newTarget, newCam, duration = 650) {
      if (_animId !== null) cancelAnimationFrame(_animId);
      const t0 = controls.target.clone();
      const c0 = camera.position.clone();
      const t  = performance.now();
      controls.enabled = false;
      (function tick(now) {
        const raw  = Math.min((now - t) / duration, 1);
        const ease = raw < 0.5 ? 2*raw*raw : -1 + (4 - 2*raw)*raw;
        controls.target.lerpVectors(t0, newTarget, ease);
        camera.position.lerpVectors(c0, newCam, ease);
        controls.update();
        if (raw < 1) _animId = requestAnimationFrame(tick);
        else { _animId = null; controls.enabled = true; }
      })(t);
    }

    function zoomToPOI(mesh) {
      const tgt = new THREE.Vector3(mesh.position.x, 0, mesh.position.z);
      const az  = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      const h   = VIEW_CLOSE;
      animateTo(tgt, new THREE.Vector3(tgt.x + Math.sin(az) * h, h, tgt.z + Math.cos(az) * h));
    }

    function zoomOut() {
      if (_savedCamState) {
        animateTo(_savedCamState.target, _savedCamState.cam);
        _savedCamState = null;
      } else {
        const tgt = new THREE.Vector3(controls.target.x, 0, controls.target.z);
        animateTo(tgt, new THREE.Vector3(tgt.x, 1200, tgt.z));
      }
    }

    // ── pointer events ───────────────────────────────────────────────────────
    function onPointerMove(e) {
      const hit = hitPOI(e.clientX, e.clientY);
      if (hit === hoveredPOI) return;
      if (hoveredPOI && hoveredPOI !== selectedPOI) hoveredPOI.material = getBaseMat(hoveredPOI);
      hoveredPOI = hit;
      if (hoveredPOI && hoveredPOI !== selectedPOI) hoveredPOI.material = getHoverMat(hoveredPOI);
      renderer.domElement.style.cursor = hoveredPOI ? 'pointer' : '';
      refreshPOIOut();
    }
    function onPointerDown(e) { _ptrDown = { x: e.clientX, y: e.clientY }; }
    function onPointerUp(e) {
      if (!_ptrDown) return;
      const wasDrag = Math.hypot(e.clientX - _ptrDown.x, e.clientY - _ptrDown.y) > 6;
      _ptrDown = null;
      if (wasDrag) return;
      const hit = hitPOI(e.clientX, e.clientY);
      if (hit) {
        if (hit === selectedPOI) return;
        if (!selectedPOI) _savedCamState = { target: controls.target.clone(), cam: camera.position.clone() };
        if (selectedPOI)  selectedPOI.material = selectedPOI === hoveredPOI ? getHoverMat(selectedPOI) : getBaseMat(selectedPOI);
        selectedPOI          = hit;
        selectedPOI.material = getSelectedMat(selectedPOI);
        refreshPOIOut();
        zoomToPOI(selectedPOI);
      } else if (selectedPOI) {
        selectedPOI.material = selectedPOI === hoveredPOI ? getHoverMat(selectedPOI) : getBaseMat(selectedPOI);
        selectedPOI = null;
        refreshPOIOut();
        zoomOut();
      }
    }
    function onKeyDown(e) {
      if (e.key !== 'Escape' || !selectedPOI) return;
      selectedPOI.material = selectedPOI === hoveredPOI ? getHoverMat(selectedPOI) : getBaseMat(selectedPOI);
      selectedPOI = null;
      refreshPOIOut();
      zoomOut();
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup',   onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    // ── ground plane (raycasting) ─────────────────────────────────────────────
    const _groundPlane3D = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    function getGroundPoint(ndcX, ndcY) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const pt = new THREE.Vector3();
      return ray.ray.intersectPlane(_groundPlane3D, pt) ? pt : null;
    }

    // ── tile priority / geometry helpers ─────────────────────────────────────
    function pointInPolygon2D(point, polygon) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const hit = ((yi > point.y) !== (yj > point.y)) &&
                    (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (hit) inside = !inside;
      }
      return inside;
    }
    const _lookDir = new THREE.Vector3();
    function buildPriorityList() {
      const worldCorners = [
        getGroundPoint(-1,  1), getGroundPoint( 1,  1),
        getGroundPoint( 1, -1), getGroundPoint(-1, -1),
      ];
      if (worldCorners.some(p => !p)) return _priorityListFallback();
      const tc = worldCorners.map(p => worldToFracTile(p.x, p.z));
      const cx = tc.reduce((s, p) => s + p.ftx, 0) / 4;
      const cy = tc.reduce((s, p) => s + p.fty, 0) / 4;
      const farMidX  = (tc[0].ftx + tc[1].ftx) / 2;
      const farMidY  = (tc[0].fty + tc[1].fty) / 2;
      const nearMidX = (tc[2].ftx + tc[3].ftx) / 2;
      const nearMidY = (tc[2].fty + tc[3].fty) / 2;
      let ndx = nearMidX - farMidX, ndy = nearMidY - farMidY;
      const nlen = Math.sqrt(ndx*ndx + ndy*ndy) || 1;
      ndx /= nlen; ndy /= nlen;
      const buffered = tc.map((p, i) => {
        const dx = p.ftx - cx, dy = p.fty - cy;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        const isNear = i === 2 || i === 3;
        return {
          x: p.ftx + (dx/len)*VIEW_BUFFER_T + (isNear ? ndx*BOTTOM_BUFFER_T : 0),
          y: p.fty + (dy/len)*VIEW_BUFFER_T + (isNear ? ndy*BOTTOM_BUFFER_T : 0),
        };
      });
      const vc = (() => {
        const p = getGroundPoint(0, 0);
        return p ? worldToFracTile(p.x, p.z) : { ftx: cx, fty: cy };
      })();
      const xs = buffered.map(p => p.x), ys = buffered.map(p => p.y);
      const minTX = Math.floor(Math.min(...xs)), maxTX = Math.ceil(Math.max(...xs));
      const minTY = Math.floor(Math.min(...ys)), maxTY = Math.ceil(Math.max(...ys));
      const list = [];
      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = minTY; ty <= maxTY; ty++) {
          if (pointInPolygon2D({ x: tx+0.5, y: ty+0.5 }, buffered)) {
            const dist = Math.hypot(tx+0.5 - vc.ftx, ty+0.5 - vc.fty);
            list.push({ tx, ty, dist });
          }
        }
      }
      list.sort((a, b) => a.dist - b.dist);
      return list;
    }
    function _priorityListFallback() {
      const { tx: ctx, ty: cty } = camTile();
      const radius = getLoadRadius();
      camera.getWorldDirection(_lookDir);
      _lookDir.y = 0;
      const len = _lookDir.length();
      const bias = radius * VIEW_BIAS;
      const cx = len > 0.001 ? ctx + (_lookDir.x/len)*bias : ctx;
      const cy = len > 0.001 ? cty - (_lookDir.z/len)*bias : cty;
      const list = [];
      for (let dx = -(radius+1); dx <= radius+1; dx++) {
        for (let dy = -(radius+1); dy <= radius+1; dy++) {
          const tx   = Math.round(cx) + dx;
          const ty   = Math.round(cy) + dy;
          const dist = Math.hypot(tx+0.5 - cx, ty+0.5 - cy);
          if (dist <= radius+0.5) list.push({ tx, ty, dist });
        }
      }
      list.sort((a, b) => a.dist - b.dist);
      return list;
    }

    // ── Overpass fetch ────────────────────────────────────────────────────────
    async function fetchOSM(tx, ty, priority = 5, signal = null) {
      if (useServer) {
        const res = await fetch(`${SERVER}/tile/${tx}/${ty}?priority=${priority}`, signal ? { signal } : {});
        if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
        return res.json();
      }
      const sw   = tileLatLon(tx, ty), ne = tileLatLon(tx+1, ty+1);
      const bbox = `${sw.lat},${sw.lon},${ne.lat},${ne.lon}`;
      const q    = `[out:json][timeout:20];`
                 + `(way["building"](${bbox});node["amenity"](${bbox});node["shop"](${bbox}););out body;>;out skel qt;`;
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method:  'POST',
        body:    'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal:  signal ?? AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return res.json();
    }

    // ── geometry helpers ──────────────────────────────────────────────────────
    function pointInPolygon(point, polygon) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi=polygon[i].x, zi=polygon[i].z, xj=polygon[j].x, zj=polygon[j].z;
        const intersect = ((zi>point.z) !== (zj>point.z)) &&
                          (point.x < ((xj-xi)*(point.z-zi)/(zj-zi)+xi));
        if (intersect) inside = !inside;
      }
      return inside;
    }
    function pointToSegmentDistance(point, a, b) {
      const dx=b.x-a.x, dz=b.z-a.z;
      const lSq = dx*dx + dz*dz;
      if (lSq===0) return Math.hypot(point.x-a.x, point.z-a.z);
      const t = Math.max(0, Math.min(1, ((point.x-a.x)*dx + (point.z-a.z)*dz) / lSq));
      return Math.hypot(point.x - (a.x+t*dx), point.z - (a.z+t*dz));
    }
    function isPOINearBuilding(point, polygon, radius) {
      if (pointInPolygon(point, polygon)) return true;
      for (let i=0; i<polygon.length; i++) {
        if (pointToSegmentDistance(point, polygon[i], polygon[(i+1)%polygon.length]) <= radius) return true;
      }
      return false;
    }

    function buildingMesh(way, nodeById, pois = []) {
      let buildingType = null;
      const pts = (way.nodes || []).map(id => nodeById.get(id)).filter(Boolean).map(n => toWorld(n.lat, n.lon));
      if (pts.length < 3) return null;
      for (const poi of pois) {
        if (!isPOINearBuilding(poi, pts, POI_INFLUENCE_RADIUS)) continue;
        if (poi.type === 'confirmed') { buildingType = 'confirmed'; break; }
        if (!buildingType) buildingType = 'suspected';
      }
      let material = BUILDING_MAT;
      if (buildingType === 'confirmed') material = POI_CONFIRMED_MAT;
      else if (buildingType === 'suspected') material = POI_SUSPECTED_MAT;
      const tags = way.tags || {};
      let h = 10;
      if (tags.height) h = parseFloat(tags.height) || h;
      else if (tags['building:levels']) h = parseInt(tags['building:levels']) * 3;
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      for (let i=1; i<pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      shape.closePath();
      try {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
        const mesh = new THREE.Mesh(geo, material);
        if (buildingType==='confirmed'||buildingType==='suspected') mesh.position.y += 1;
        mesh.userData.tags = tags;
        return mesh;
      } catch { return null; }
    }

    // ── Tile class ────────────────────────────────────────────────────────────
    class Tile {
      constructor(tx, ty, dataTiles) {
        this.tx          = tx;
        this.ty          = ty;
        this.state       = 'idle';
        this.lastWanted  = Date.now();
        this.lastChecked = 0;
        this.group       = new THREE.Group();
        this._abort      = new AbortController();
        this._placeholder = null;
        this._cachedData  = null;
        this._cachedPois  = null;
        const dtx = Math.floor(tx / DATA_TILE_FACTOR);
        const dty = Math.floor(ty / DATA_TILE_FACTOR);
        this.dataTile = dataTiles.getOrCreate(dtx, dty);
        scene.add(this.group);
        this._buildPlaceholder();
      }
      get loading() { return this.state==='checking'||this.state==='fetching'; }
      get loaded()  { return this.state==='loaded'; }
      get failed()  { return this.state==='failed'; }
      get done()    { return this.loaded||this.failed; }
      shouldRetry() { return this.state==='waiting' && Date.now()-this.lastChecked > RETRY_AFTER_MS; }

      _buildPlaceholder() {
        if (this._placeholder) return;
        const cx = (this.tx+0.5)*TILE_W, cz = -(this.ty+0.5)*TILE_H;
        this._placeholder = new THREE.Mesh(new THREE.PlaneGeometry(TILE_W-2, TILE_H-2), PRE_LOAD_MAT);
        this._placeholder.rotation.x = -Math.PI/2;
        this._placeholder.position.set(cx, 0, cz);
        this.group.add(this._placeholder);
      }
      _ensurePlaceholder() {
        this._buildPlaceholder();
        this._placeholder.material = EMPTY_GRID_MAT;
      }
      _removePlaceholder() {
        if (!this._placeholder) return;
        this.group.remove(this._placeholder);
        this._placeholder.geometry.dispose();
        this._placeholder = null;
      }
      _clearMeshes() {
        const toRemove = [];
        this.group.traverse(obj => { if (obj.isMesh && obj !== this._placeholder) toRemove.push(obj); });
        for (const obj of toRemove) {
          this.group.remove(obj);
          if (!obj.userData?.isPOI) obj.geometry?.dispose();
          if (obj.userData?.isPOI) {
            _poiMeshSet.delete(obj);
            if (obj === selectedPOI) selectedPOI = null;
            if (obj === hoveredPOI)  hoveredPOI  = null;
          }
        }
      }
      _buildMeshes(data, pois) {
        this._clearMeshes();
        const minX = this.tx * TILE_W, maxX = (this.tx+1) * TILE_W;
        const minZ = -(this.ty+1)*TILE_H, maxZ = -this.ty*TILE_H;
        const nodeMap = new Map();
        for (const el of data.elements) {
          if (el.type==='node') nodeMap.set(el.id, el);
        }
        const activeSuspected = [], confirmedFromSuspected = [];
        for (const poi of pois) {
          if (matchCoord(poi.lat, poi.lon, ignoredList)) continue;
          const conf = matchCoord(poi.lat, poi.lon, confirmedList);
          if (conf) {
            confirmedFromSuspected.push({ lat: conf.lat, lon: conf.lon, tags: { ...poi.tags, ...conf.tags } });
          } else if (showSuspected) {
            activeSuspected.push(poi);
          }
        }
        const confirmedOnly = confirmedList.filter(conf => {
          const pw = toWorld(conf.lat, conf.lon);
          if (pw.x<minX||pw.x>=maxX||pw.z<=minZ||pw.z>maxZ) return false;
          return !pois.some(p => {
            const dx=(p.lon-conf.lon)*LON_M, dz=(p.lat-conf.lat)*LAT_M;
            return Math.hypot(dx,dz)<MATCH_M;
          });
        });
        const allConfirmed = [...confirmedFromSuspected, ...confirmedOnly];
        const poiInfo = [
          ...activeSuspected.map(p => ({ ...toWorld(p.lat, p.lon), type: 'suspected' })),
          ...allConfirmed.map(p    => ({ ...toWorld(p.lat, p.lon), type: 'confirmed' })),
        ];
        for (const el of data.elements) {
          if (el.type==='way' && el.tags?.building) {
            const m = buildingMesh(el, nodeMap, poiInfo);
            if (m) this.group.add(m);
          }
        }
        const addPOI = (poi, mat) => {
          const pw = toWorld(poi.lat, poi.lon);
          if (pw.x<minX||pw.x>=maxX||pw.z<=minZ||pw.z>maxZ) return;
          const mesh = new THREE.Mesh(POI_GEO, mat);
          mesh.position.set(pw.x, POI_HEIGHT, pw.z);
          mesh.userData.tags    = { ...poi.tags, _lat: poi.lat, _lon: poi.lon };
          mesh.userData.isPOI   = true;
          mesh.userData.poiType = (mat===POI_SUSPECTED_MAT) ? 'suspected' : 'confirmed';
          _poiMeshSet.add(mesh);
          this.group.add(mesh);
        };
        for (const poi of activeSuspected) addPOI(poi, POI_SUSPECTED_MAT);
        for (const poi of allConfirmed)    addPOI(poi, POI_CONFIRMED_MAT);
      }
      _processData(data, pois=[]) {
        this._cachedData = data;
        this._cachedPois = pois;
        this._buildMeshes(data, pois);
        this._removePlaceholder();
        this.state = 'loaded';
      }
      redraw() {
        if (this.state!=='loaded') return;
        this._buildMeshes(this._cachedData, this._cachedPois??[]);
        refreshPOIOut();
      }
      async checkCache() {
        if (this.state!=='idle' && !this.shouldRetry()) return;
        this.state='checking'; this.lastChecked=Date.now();
        this._ensurePlaceholder();
        const { signal } = this._abort;
        try {
          const [res, pois] = await Promise.all([
            fetch(`${SERVER}/tile/${this.tx}/${this.ty}?cacheOnly=true`, { signal }),
            this.dataTile.ready,
          ]);
          if (res.status===404) { this.state='waiting'; return; }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!signal.aborted) this._processData(data, pois);
        } catch(e) {
          this._removePlaceholder();
          if (e.name!=='AbortError') { console.warn(`Tile (${this.tx},${this.ty}) check: ${e.message}`); this.state='idle'; }
        }
      }
      async fetchDirect() {
        if (this.state!=='idle') return;
        this.state='fetching'; this.lastChecked=Date.now();
        this._ensurePlaceholder();
        const { signal } = this._abort;
        try {
          const [data, pois] = await Promise.all([
            fetchOSM(this.tx, this.ty, 5, signal),
            this.dataTile.ready,
          ]);
          if (!signal.aborted) this._processData(data, pois);
        } catch(e) {
          this._removePlaceholder();
          if (e.name==='AbortError') this.state='idle';
          else { console.warn(`Tile (${this.tx},${this.ty}) fetch: ${e.message}`); this.state='failed'; }
        }
      }
      dispose() {
        this._abort.abort();
        this._clearMeshes();
        refreshPOIOut();
        this._removePlaceholder();
        scene.remove(this.group);
      }
    }

    // ── DataTile class ────────────────────────────────────────────────────────
    class DataTile {
      constructor(dtx, dty) {
        this.dtx=dtx; this.dty=dty; this.state='idle'; this.pois=[];
        this._abort = new AbortController();
        this.ready  = new Promise(res => { this._resolveReady = res; });
      }
      async fetch() {
        if (this.state!=='idle') return;
        this.state='loading';
        const { signal } = this._abort;
        try {
          const res = await fetch(`${SERVER}/poi/${this.dtx}/${this.dty}`, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const pois = await res.json();
          if (!signal.aborted) { this.pois=pois; this.state='loaded'; this._resolveReady(pois); }
        } catch(e) {
          if (e.name==='AbortError') { this.state='idle'; return; }
          this.state='failed'; this._resolveReady([]);
        }
      }
      dispose() { this._abort.abort(); this._resolveReady([]); }
    }

    class DataTiles {
      constructor() { this.map = new Map(); }
      _key(dtx,dty) { return `${dtx},${dty}`; }
      getOrCreate(dtx,dty) {
        if (!useServer) return { ready: Promise.resolve([]), dispose(){} };
        const key=this._key(dtx,dty);
        if (!this.map.has(key)) { const dt=new DataTile(dtx,dty); this.map.set(key,dt); dt.fetch(); }
        return this.map.get(key);
      }
      update(tileMap) {
        const needed=new Set();
        for (const [,tile] of tileMap) needed.add(this._key(Math.floor(tile.tx/DATA_TILE_FACTOR),Math.floor(tile.ty/DATA_TILE_FACTOR)));
        for (const [key,dtile] of this.map) { if (!needed.has(key)) { dtile.dispose(); this.map.delete(key); } }
      }
    }

    // ── TileLoader ────────────────────────────────────────────────────────────
    class TileLoader {
      constructor() { this._active=0; this._queue=[]; }
      update(priorityList, tileMap) {
        if (useServer) this._pushPriority(priorityList);
        this._queue=[];
        for (const { tx,ty,dist } of priorityList) {
          const tile=tileMap.get(`${tx},${ty}`);
          if (!tile||tile.done||tile.loading) continue;
          if (tile.state==='idle'||tile.shouldRetry()) this._queue.push({ tile,dist });
        }
        this._drain();
      }
      _drain() {
        const limit = useServer ? POLL_CONCURRENCY : FETCH_CONCURRENCY;
        while (this._active<limit && this._queue.length>0) {
          const { tile } = this._queue.shift();
          if (tile.done||tile.loading) continue;
          this._active++;
          (useServer ? tile.checkCache() : tile.fetchDirect())
            .finally(() => { this._active--; this._drain(); });
        }
      }
      _pushPriority(priorityList) {
        fetch(`${SERVER}/priority`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ tiles: priorityList.map(({tx,ty,dist})=>({tx,ty,dist})) }),
          signal:AbortSignal.timeout(1500),
        }).catch(()=>{});
      }
    }

    // ── Tiles ────────────────────────────────────────────────────────────────
    function redrawAllTiles() {
      for (const [,tile] of tilesManager.map) tile.redraw();
      refreshPOIOut();
    }

    class Tiles {
      constructor(dataTiles) {
        this.dataTiles=dataTiles; this.map=new Map(); this.loader=new TileLoader();
        this.retile();
      }
      _key(tx,ty) { return `${tx},${ty}`; }
      retile() {
        const rawList=buildPriorityList();
        if (!rawList.length) return;
        const list=rawList.slice(0,MAX_TILES);
        const wantedKeys=new Set(list.map(({tx,ty})=>this._key(tx,ty)));
        const now=Date.now();
        const vc=(()=>{
          const p=getGroundPoint(0,0);
          if (p) return worldToFracTile(p.x,p.z);
          const {tx,ty}=camTile();
          return { ftx:tx+0.5, fty:ty+0.5 };
        })();
        const maxViewDist=list[list.length-1].dist;
        const evictDist=maxViewDist+EVICT_BUFFER;
        for (const [key,tile] of this.map) {
          if (wantedKeys.has(key)) { tile.lastWanted=now; continue; }
          const dist=Math.hypot(tile.tx+0.5-vc.ftx, tile.ty+0.5-vc.fty);
          const graceOver=(now-tile.lastWanted)>EVICT_GRACE_MS;
          if (dist>evictDist&&graceOver) { tile.dispose(); this.map.delete(key); }
        }
        for (const {tx,ty} of list) {
          const key=this._key(tx,ty);
          if (!this.map.has(key)) this.map.set(key, new Tile(tx,ty,this.dataTiles));
        }
        this.dataTiles.update(this.map);
        this.loader.update(list, this.map);
      }
    }

    // ── camera UI actions (exposed imperatively) ──────────────────────────────
    function resetDirection() {
      const target=controls.target;
      const offset=camera.position.clone().sub(target);
      const hDist=Math.sqrt(offset.x*offset.x+offset.z*offset.z);
      camera.position.set(target.x, camera.position.y, target.z+hDist);
      controls.update();
    }
    function setPOIView() {
      const target=controls.target;
      const offset=camera.position.clone().sub(target);
      const azimuth=Math.atan2(offset.x, offset.z);
      const newY=100, phi=Math.PI/4, hDist=newY*Math.tan(phi);
      camera.position.set(target.x+Math.sin(azimuth)*hDist, target.y+newY, target.z+Math.cos(azimuth)*hDist);
      controls.update();
    }
    function setWideView() {
      const target=controls.target;
      camera.position.set(target.x, target.y+1500, target.z);
      controls.update();
    }

    async function gotoLocation(query) {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=gb&addressdetails=1`,
        {
          headers: { 'Accept-Language':'en', 'User-Agent':'TileMapApp/1.0' },
          signal: AbortSignal.timeout(8000),
        }
      );
      const results = await res.json();
      if (!results.length || results[0].address?.country_code !== 'gb') {
        throw new Error('Location not found in GB');
      }
      const lat=parseFloat(results[0].lat), lon=parseFloat(results[0].lon);
      const wx=(lon-ORIGIN.lon)*LON_M, wz=-(lat-ORIGIN.lat)*LAT_M;
      const dx=wx-camera.position.x, dz=wz-camera.position.z;
      camera.position.x+=dx; camera.position.z+=dz;
      controls.target.x+=dx; controls.target.z+=dz;
      controls.update();
      resetDirection();
      return { displayName: results[0].display_name };
    }

    // ── UI update (throttled, called from animation loop) ────────────────────
    function updateUI(now) {
      if (now - lastUIUpdate < 200) return;
      lastUIUpdate = now;
      const lon = ORIGIN.lon + camera.position.x / LON_M;
      const lat = ORIGIN.lat - camera.position.z / LAT_M;
      cbLivePos.current?.(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      camera.getWorldDirection(_lookDir);
      _lookDir.y = 0;
      const len = _lookDir.length();
      if (len < 0.001) { cbDir.current?.('—'); return; }
      _lookDir.divideScalar(len);
      const angle = Math.atan2(_lookDir.x, -_lookDir.z);
      const t = ((angle / (Math.PI * 2)) + 1) % 1;
      cbDir.current?.(t.toFixed(2));
    }

    // ── async init ────────────────────────────────────────────────────────────
    let tilesManager = null;
    let lastRetile   = 0;

    const init = async () => {
      await detectServer();
      if (!active) return;
      await loadPOILists();
      if (!active) return;

      const dataTiles = new DataTiles();
      tilesManager = new Tiles(dataTiles);

      function animate() {
        if (!active) return;
        animFrameId = requestAnimationFrame(animate);
        const now = performance.now();
        if (now - lastRetile > RETILE_MS) { tilesManager.retile(); lastRetile = now; }
        updateUI(now);
        controls.update();
        renderer.render(scene, camera);
      }
      animate();
    };
    init().catch(console.error);

    // ── expose imperative methods ─────────────────────────────────────────────
    imperativeRef.current = {
      gotoLocation,
      resetDirection,
      setPOIView,
      setWideView,
      setShowSuspected: (val) => { showSuspected = val; if (tilesManager) redrawAllTiles(); },
    };

    // ── cleanup ───────────────────────────────────────────────────────────────
    return () => {
      active = false;
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
      window.removeEventListener('resize',  handleResize);
      window.removeEventListener('keydown', onKeyDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup',   onPointerUp);
      controls.dispose();
      renderer.dispose();
      imperativeRef.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ ...styles.wrapper, ...style }}>
      <canvas ref={canvasRef} style={styles.canvas} />
    </div>
  );
});

export default MapCanvas;

const styles = {
  wrapper: {
    position:   'relative',
    width:      '100%',
    height:     '100%',
    overflow:   'hidden',
  },
  canvas: {
    display: 'block',
    width:   '100%',
    height:  '100%',
  },
};
