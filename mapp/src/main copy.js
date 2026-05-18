import './style.css'
import p5 from 'p5'
import Papa from 'papaparse'

const minLat = 51.35;
const maxLat = 51.65;
const minLon = -0.47;
const maxLon = 0.23;

const canvas = document.getElementById('canvas');

/*
`https://staticmap.openstreetmap.de/staticmap.php?bbox=-0.47,51.45,-0.23,51.65&size=1200x800`
*/

/*
const bbox = "-0.15,51.49,-0.10,51.52";

const url =
`https://staticmap.openstreetmap.de/staticmap.php?bbox=${bbox}&size=1200x800`;

console.log(document.querySelector("img").src = url);
*/

/*
const zoom = ???;

const minX = lonToTileX(minLon, zoom);
const maxX = lonToTileX(maxLon, zoom);

const minY = latToTileY(maxLat, zoom);
const maxY = latToTileY(minLat, zoom);

const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
console.log(url);
*/

/*
function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}
*/


const loadCSV = (path) =>
  fetch(path)
    .then(r => r.text())
    .then(text => Papa.parse(text, { header: true, skipEmptyLines: true }).data)

const sketch = (p) => {
  let lfrData, locationsLookup

  p.setup = () => {
    p.createCanvas(800, 600)
  }

  p.draw = () => {
    p.background(220)
    if (lfrData && locationsLookup) {
      drawLocations(lfrData, locationsLookup)
    }
  }

  const drawLocations = (lfr, lookup) => {
    lfr.forEach(row => {
      const locationInfo = lookup.find(loc => loc['location_raw'] === row['Location'])

      if (locationInfo) {
        const lat = parseFloat(locationInfo['latitude'])
        const lng = parseFloat(locationInfo['longitude'])

        
        const canvasX = p.map(lng, minLon, maxLon, 0, p.width)
        const canvasY = p.map(lat, minLat, maxLat, p.height, 0)
        

        p.fill(255, 0, 0, 80)
        p.noStroke()
        p.ellipse(canvasX, canvasY, 10, 10)
      }
    })
  }

  p.setData = (lfr, locations) => {
    lfrData = lfr
    locationsLookup = locations
  }
}

Promise.all([
  loadCSV('./assets/2025lfr.csv'),
  loadCSV('./assets/locations_lookup.csv')
]).then(([lfr, locations]) => {
  const mySketch = new p5(sketch, canvas)
  mySketch.setData(lfr, locations)
})