import './style.css'

import * as THREE from 'three'

console.log("tile trial");


const CWIDTH = window.innerWidth;
const CHEIGHT = window.innerHeight;

const TILESIZE = {
    lat: 1,
    lon: 1
};

const ORIGIN = {
    lat: 0,
    lon: 0
};



class Tile {
    constructor(latLower, latUpper, lonLower, lonUpper) {
        this.latLower = latLower;
        this.latUpper = latUpper;
        this.lonLower = lonLower;
        this.lonUpper = lonUpper;
    }
}

class Tiles {
    constructor() {
        this.tiles = [];
        newTile(0, 0);
    }
    newTile(x, y) {
        let lat, lon = xy2latlon (x, y);
        let t = new Tile(lat, lon);
        this.tiles.push(t);
    }
    xy2latlon(x, y) {
        // SCALE TO BE ADDED
        let lat = ORIGIN.lat + x * TILESIZE.lat;
        let lon = ORIGIN.lon + x * TILESIZE.lon;
        return (lat, lon);
    }
    latlon2xy(lat, lon) {
        // TO BE ADDED
    }
}


let tiles = new Tiles();

console.log(tiles.tiles);

/*

let tiles = [];

tiles.append(new tile(0,0));


console.log(tiles);

*/