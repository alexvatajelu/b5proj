import './style.css'
import p5 from 'p5'
import Papa from 'papaparse'

const canvas = document.getElementById('canvas')

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

        const canvasX = p.map(lng, -0.55, 0.35, 0, p.width)
        const canvasY = p.map(lat, 51.28, 51.70, p.height, 0)

        p.fill(255, 0, 0)
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