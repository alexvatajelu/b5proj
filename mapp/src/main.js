import './style.css'
import p5 from 'p5'
import Papa from 'papaparse'

const minLat = 51.35;
const maxLat = 51.65;
const minLon = -0.47;
const maxLon = 0.23;

let ZOOM = 11;

let gMinX, gMaxX, gMinY, gMaxY;
let canvasW, canvasH;
let tileMinX, tileMaxX, tileMinY, tileMaxY;

function lonToPixelX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latToPixelY(lat, z) {
  const rad = lat * Math.PI / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

function tileize() {

   gMinX = lonToPixelX(minLon, ZOOM);
   gMaxX = lonToPixelX(maxLon, ZOOM);
   gMinY = latToPixelY(maxLat, ZOOM);
   gMaxY = latToPixelY(minLat, ZOOM);

   canvasW = Math.round(gMaxX - gMinX);
   canvasH = Math.round(gMaxY - gMinY);

   tileMinX = Math.floor(gMinX / 256);
   tileMaxX = Math.floor(gMaxX / 256);
   tileMinY = Math.floor(gMinY / 256);
   tileMaxY = Math.floor(gMaxY / 256);

}
tileize();

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

  
  p.keyPressed = () => {
    if (p.key === "]") {
      ZOOM = Math.min(ZOOM + 1, 14);
      
    } else if (p.key === "[") {
      ZOOM = Math.max(ZOOM - 1, 9);
    }
    if (p.key === "[" || p.key === "]") {
      tileize();
      p.setup();
      console.log("Zoom level:", ZOOM);
    }
  }
};

Promise.all([
  loadCSV('./assets/2025lfr.csv'),
  loadCSV('./assets/locations_lookup.csv')
]).then(([lfr, locations]) => {
  const mySketch = new p5(sketch, canvas);
  mySketch.setData(lfr, locations);
});


/*
canvas.onKeyPressed = (e) => {
  if (e.key === "]") {
    ZOOM = Math.min(ZOOM + 1, 19);
  } else if (e.key === "[") {
    ZOOM = Math.max(ZOOM - 1, 11);
  }
  console.log("Zoom level:", ZOOM);
}
*/