import './style.css'
import p5 from 'p5'
import Papa from 'papaparse'

const minLat = 51.35;
const maxLat = 51.65;
const minLon = -0.47;
const maxLon = 0.23;

const ZOOM = 11;

function lonToPixelX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latToPixelY(lat, z) {
  const rad = lat * Math.PI / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

const gMinX = lonToPixelX(minLon, ZOOM);
const gMaxX = lonToPixelX(maxLon, ZOOM);
const gMinY = latToPixelY(maxLat, ZOOM);
const gMaxY = latToPixelY(minLat, ZOOM);

const canvasW = Math.round(gMaxX - gMinX);
const canvasH = Math.round(gMaxY - gMinY);

const tileMinX = Math.floor(gMinX / 256);
const tileMaxX = Math.floor(gMaxX / 256);
const tileMinY = Math.floor(gMinY / 256);
const tileMaxY = Math.floor(gMaxY / 256);

const canvas = document.getElementById('canvas');

const loadCSV = (path) =>
  fetch(path)
    .then(r => r.text())
    .then(text => Papa.parse(text, { header: true, skipEmptyLines: true }).data);

const sketch = (p) => {
  let lfrData, locationsLookup;
  const tileImages = {};
  let tilesReady = false;

  p.setup = async () => {
    p.createCanvas(canvasW, canvasH);
    p.noLoop();

    const tileEntries = [];
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        const url = `https://tile.openstreetmap.org/${ZOOM}/${tx}/${ty}.png`;
        tileEntries.push(
          p.loadImage(url).then(img => [`${tx}_${ty}`, img])
        );
      }
    }

    const loaded = await Promise.all(tileEntries);
    loaded.forEach(([key, img]) => { tileImages[key] = img; });
    tilesReady = true;

    if (lfrData && locationsLookup) p.redraw();
  };

  p.draw = () => {
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        const img = tileImages[`${tx}_${ty}`];
        if (img) {
          p.image(img, tx * 256 - gMinX, ty * 256 - gMinY, 256, 256);
        }
      }
    }

    p.fill(255,255,255,140);
    p.rect(0,0,canvasW,canvasH);

    if (lfrData && locationsLookup) {
      drawLocations(lfrData, locationsLookup);
    }

    p.fill(255, 255, 255, 100);
    p.noStroke();
    p.rect(0, canvasH - 18, 185, 18);
    p.fill(0);
    p.textSize(10);
    p.textAlign(p.LEFT, p.BOTTOM);
    p.text('© OpenStreetMap contributors', 4, canvasH - 3);
  };

  const drawLocations = (lfr, lookup) => {
    lfr.forEach(row => {
      const locationInfo = lookup.find(loc => loc['location_raw'] === row['Location']);
      if (!locationInfo) return;

      const lat = parseFloat(locationInfo['latitude']);
      const lng = parseFloat(locationInfo['longitude']);

      const canvasX = lonToPixelX(lng, ZOOM) - gMinX;
      const canvasY = latToPixelY(lat, ZOOM) - gMinY;

      p.fill(255, 0, 0, 50);
      p.noStroke();
      p.ellipse(canvasX, canvasY, 10, 10);
    });
  };

  p.setData = (lfr, locations) => {
    lfrData = lfr;
    locationsLookup = locations;
    p.redraw();
  };
};

Promise.all([
  loadCSV('./assets/2025lfr.csv'),
  loadCSV('./assets/locations_lookup.csv')
]).then(([lfr, locations]) => {
  const mySketch = new p5(sketch, canvas);
  mySketch.setData(lfr, locations);
});