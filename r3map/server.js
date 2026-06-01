import express from 'express';
import cors    from 'cors';
import fs      from 'fs/promises';
import path    from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT           = 3000;
const CACHE_DIR      = path.join(__dirname, 'tile_cache');
const MAX_CACHE_TILES = 10000;

const ORIGIN   = { lat: 51.505, lon: -0.09 };
const TILE_DEG = 0.005;

const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const OVERPASS_DELAY_MS = 1200;
const OVERPASS_TIMEOUT  = 10_000;
const MAX_QUEUE_SIZE    = 40;
const BG_QUEUE_SLOTS    = 4;    // max background items allowed in q at once
const DEFAULT_PRIORITY  = 5;

const POI_CACHE_DIR    = path.join(__dirname, 'poi_cache');
const DATA_TILE_FACTOR = 10;                       // data tile = 10×10 geom tiles
const POI_QUERY_REGEX  =
    'Sports Direct|B&M|Iceland|Sainsbury|Spar|Costcutter|Budgens|' +
    'Farmfoods|River Island|Home Bargains|Frasers|Flannels|Southern Co-op|Eat 17';


const app = express();
app.use(cors());
app.use(express.json());

await fs.mkdir(CACHE_DIR, { recursive: true });
await fs.mkdir(POI_CACHE_DIR, { recursive: true });

function isFresh(entry) {
    if (!entry?.fetchedAt) return false;
    return (Date.now() - new Date(entry.fetchedAt).getTime()) < MAX_CACHE_AGE_MS;
}

// ─── Overpass queue ───────────────────────────────────────────────────────────
//
//  Single-threaded, rate-limited priority queue. Every Overpass request —
//  from GET /tile or the background worker — goes through here so the rate
//  limit is always global.
//
//  Items carry an optional `key` string (used for dedup checks) and a
//  `fromBg` flag (used to count how many background slots are occupied).

const pending = new Map();  // key → Promise<OSM data>
const q       = [];         // { fn, resolve, reject, priority, key, fromBg }
let   running = 0;

function scheduleNext() {
    if (running > 0 || q.length === 0) {
        // When the queue drains completely, top it up from the background list.
        if (running === 0 && q.length === 0) promoteBg();
        return;
    }
    running++;
    const { fn, resolve, reject } = q.shift();
    fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
            running--;
            setTimeout(scheduleNext, OVERPASS_DELAY_MS);
        });
}

function enqueue(fn, priority = DEFAULT_PRIORITY, key = null, fromBg = false) {
    return new Promise((resolve, reject) => {
        const item = { fn, resolve, reject, priority, key, fromBg };

        let lo = 0, hi = q.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (q[mid].priority <= item.priority) lo = mid + 1;
            else hi = mid;
        }
        q.splice(lo, 0, item);

        if (q.length > MAX_QUEUE_SIZE) {
            const dropped = q.pop();
            if (dropped.key) pending.delete(dropped.key);
            dropped.reject(new Error('Queue overflow — request dropped (low priority)'));
            console.log(`[queue] overflow — dropped lowest-priority item (queue: ${q.length})`);
        }

        scheduleNext();
    });
}


// ─── Overpass fetch ───────────────────────────────────────────────────────────
async function fetchOverpass(tx, ty) {
    const s    = ORIGIN.lat +  ty      * TILE_DEG;
    const w    = ORIGIN.lon +  tx      * TILE_DEG;
    const n    = ORIGIN.lat + (ty + 1) * TILE_DEG;
    const e    = ORIGIN.lon + (tx + 1) * TILE_DEG;
    const bbox = `${s},${w},${n},${e}`;
    const body = 'data=' + encodeURIComponent(
        `[out:json][timeout:25];way["building"](${bbox});out body;>;out skel qt;`
    );
    const opts = {
        method:  'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   'TileMapApp/1.0 (local dev)',
        },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT),
    };

    let lastErr;
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const res = await fetch(mirror, opts);
            if (res.status === 429 || res.status === 406) {
                console.warn(`  [mirror] ${mirror} → ${res.status}, trying next`);
                lastErr = new Error(`HTTP ${res.status}`);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            console.log(`  [mirror] ${mirror} → OK`);
            return await res.json();
        } catch (err) {
            console.warn(`  [mirror] ${mirror} → ${err.message}, trying next`);
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('All Overpass mirrors failed');
}

async function fetchOverpassPOI(dtx, dty) {
    const s    = ORIGIN.lat +  dty      * TILE_DEG * DATA_TILE_FACTOR;
    const w    = ORIGIN.lon +  dtx      * TILE_DEG * DATA_TILE_FACTOR;
    const n    = ORIGIN.lat + (dty + 1) * TILE_DEG * DATA_TILE_FACTOR;
    const e    = ORIGIN.lon + (dtx + 1) * TILE_DEG * DATA_TILE_FACTOR;
    const bbox = `${s},${w},${n},${e}`;

    const body = 'data=' + encodeURIComponent(
        `[out:json][timeout:30];\n` +
        `(\n` +
        `  node["name"~"${POI_QUERY_REGEX}",i](${bbox});\n` +
        `  way["name"~"${POI_QUERY_REGEX}",i](${bbox});\n` +
        `);\n` +
        `out center;`
    );
    const opts = {
        method:  'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   'TileMapApp/1.0 (local dev)',
        },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT),
    };

    let lastErr;
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const res = await fetch(mirror, opts);
            if (res.status === 429 || res.status === 406) {
                lastErr = new Error(`HTTP ${res.status}`);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            console.log(`  [POI mirror] ${mirror} → OK`);
            return await res.json();
        } catch (err) {
            console.warn(`  [POI mirror] ${mirror} → ${err.message}`);
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('All Overpass mirrors failed');
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
const cf = (tx, ty) => path.join(CACHE_DIR, `${tx}_${ty}.json`);

async function readCache(tx, ty) {
    try {
        const entry = JSON.parse(await fs.readFile(cf(tx, ty), 'utf8'));
        if (!isFresh(entry)) {
            console.log(`[STALE] geo (${tx},${ty}) — will re-fetch`);
            return null;
        }
        return entry;
    } catch { return null; }
}

async function writeCache(tx, ty, data) {
    await fs.writeFile(cf(tx, ty), JSON.stringify({
        tx, ty,
        fetchedAt:      new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        data,
    }));
}

async function touchCache(tx, ty, entry) {
    entry.lastAccessedAt = new Date().toISOString();
    await fs.writeFile(cf(tx, ty), JSON.stringify(entry)).catch(() => {});
}

async function evictLRU() {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
    if (files.length <= MAX_CACHE_TILES) return;
    const meta = await Promise.all(files.map(async f => {
        try {
            const { lastAccessedAt } = JSON.parse(
                await fs.readFile(path.join(CACHE_DIR, f), 'utf8')
            );
            return { f, lastAccessedAt };
        } catch { return { f, lastAccessedAt: '1970-01-01T00:00:00Z' }; }
    }));
    meta.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
    const excess = meta.slice(0, files.length - MAX_CACHE_TILES);
    await Promise.all(excess.map(({ f }) =>
        fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})
    ));
    console.log(`[evict] removed ${excess.length} tile(s)`);
}


const poiCf = (dtx, dty) => path.join(POI_CACHE_DIR, `${dtx}_${dty}.json`);

async function readPoiCache(dtx, dty) {
    try {
        const entry = JSON.parse(await fs.readFile(poiCf(dtx, dty), 'utf8'));
        if (!isFresh(entry)) {
            console.log(`[STALE] poi (${dtx},${dty}) — will re-fetch`);
            return null;
        }
        return entry;
    } catch { return null; }
}

async function writePoiCache(dtx, dty, pois) {
    await fs.writeFile(poiCf(dtx, dty), JSON.stringify({
        dtx, dty,
        fetchedAt: new Date().toISOString(),
        data: pois,
    }));
}

function parsePoiElements(raw) {
    return raw.elements
        .map(el => ({
            id:   el.id,
            type: el.type,
            lat:  el.lat ?? el.center?.lat,
            lon:  el.lon ?? el.center?.lon,
            tags: el.tags ?? {},
        }))
        .filter(el => el.lat != null && el.lon != null);
}

app.get('/poi/:dtx/:dty', async (req, res) => {
    const dtx = parseInt(req.params.dtx, 10);
    const dty = parseInt(req.params.dty, 10);
    if (isNaN(dtx) || isNaN(dty))
        return res.status(400).json({ error: 'dtx and dty must be integers' });

    // 'poi:' prefix avoids collision with regular tile keys in pending
    const key = `poi:${dtx},${dty}`;

    try {
        // Cache hit — instant
        const cached = await readPoiCache(dtx, dty);
        if (cached) {
            console.log(`[POI HIT ] (${dtx},${dty})`);
            return res.json(cached.data);
        }

        // Deduplicate concurrent requests for the same data tile
        if (pending.has(key)) {
            console.log(`[POI WAIT] (${dtx},${dty})`);
            return res.json(await pending.get(key));
        }

        console.log(`[POI MISS] (${dtx},${dty}) — queue=${q.length}`);

        // Enqueue with priority 3 — below explicit user tile requests (5+)
        // but above background geometry tiles
        const p = enqueue(
            () => fetchOverpassPOI(dtx, dty).then(raw => {
                const pois = parsePoiElements(raw);
                writePoiCache(dtx, dty, pois).catch(console.error);
                return pois;
            }),
            3,
            key,
        );
        pending.set(key, p);

        let pois;
        try   { pois = await p; }
        finally { pending.delete(key); }

        console.log(`[POI DONE] (${dtx},${dty}) → ${pois.length} POI(s)`);
        return res.json(pois);

    } catch (err) {
        console.error(`[POI ERR ] (${dtx},${dty}): ${err.message}`);
        return res.status(502).json({ error: err.message });
    }
});

const bgQueue    = [];    // [{ tx, ty, dist }] sorted ascending by dist
let   bgBusy     = false; // re-entrancy guard (promoteBg is async)

function updateBgQueue(tiles) {
    const incoming = new Map(tiles.map(t => [`${t.tx},${t.ty}`, t]));

    // Drop tiles no longer in the client's view.
    for (let i = bgQueue.length - 1; i >= 0; i--) {
        if (!incoming.has(`${bgQueue[i].tx},${bgQueue[i].ty}`)) bgQueue.splice(i, 1);
    }

    // Add new tiles / update priority of existing ones.
    for (const [key, t] of incoming) {
        const idx = bgQueue.findIndex(b => `${b.tx},${b.ty}` === key);
        if (idx >= 0) bgQueue[idx].dist = t.dist;
        else bgQueue.push({ tx: t.tx, ty: t.ty, dist: t.dist });
    }

    bgQueue.sort((a, b) => a.dist - b.dist);
    promoteBg();
}

async function promoteBg() {
    if (bgBusy) return;
    bgBusy = true;
    try {
        // Count background items already sitting in the waiting queue.
        const bgInQueue = q.filter(item => item.fromBg).length;
        if (bgInQueue >= BG_QUEUE_SLOTS || bgQueue.length === 0) return;

        for (let i = 0; i < bgQueue.length; i++) {
            const item = bgQueue[i];
            const key  = `${item.tx},${item.ty}`;

            // Skip if already in-flight (pending) or already waiting in q.
            if (pending.has(key)) { bgQueue.splice(i--, 1); continue; }
            if (q.some(qi => qi.key === key)) continue;

            // Skip if already cached on disk.
            const cached = await readCache(item.tx, item.ty);
            if (cached) { bgQueue.splice(i--, 1); continue; }

            // Promote: move from bgQueue into the main Overpass queue.
            bgQueue.splice(i, 1);
            console.log(`[BG  ] promote (${item.tx},${item.ty})  dist=${item.dist.toFixed(1)}  bgQueue=${bgQueue.length}`);

            const p = enqueue(
                () => fetchOverpass(item.tx, item.ty),
                Math.max(1, Math.round(item.dist)),
                key,
                true,   // fromBg
            );
            pending.set(key, p);

            p.then(data  => writeCache(item.tx, item.ty, data))
             .then(()    => evictLRU())
             .catch(e    => console.error(`[BG  ] (${item.tx},${item.ty}): ${e.message}`))
             .finally(() => { pending.delete(key); promoteBg(); });

            break; // One promotion per call; next slot opens when this one finishes.
        }
    } finally {
        bgBusy = false;
    }
}


// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /priority ───────────────────────────────────────────────────────────────
//
// The client sends its full sorted tile list on every retile cycle.
// We update bgQueue and let the background worker fetch missing tiles in order.
// The client never waits for this response — it fire-and-forgets.
app.post('/priority', (req, res) => {
    const tiles = req.body?.tiles;
    if (!Array.isArray(tiles))
        return res.status(400).json({ error: 'tiles[] required' });

    const valid = tiles.filter(t => Number.isInteger(t.tx) && Number.isInteger(t.ty));
    updateBgQueue(valid);

    res.json({ ok: true, bgQueue: bgQueue.length, queue: q.length, pending: pending.size });
});

// GET /tile/:tx/:ty ─────────────────────────────────────────────────────────────
//
// ?cacheOnly=true  → instant 200 (data) or 404 (not yet on disk). Never blocks.
//                    This is the hot path the client polls after submitting its
//                    priority list. Cached tiles are served with zero queue wait.
//
// default          → 200 once available; may wait in Overpass queue.
//                    Used as a direct fallback (no-server mode doesn't reach here,
//                    but kept for compatibility and manual testing).
app.get('/tile/:tx/:ty', async (req, res) => {
    const tx        = parseInt(req.params.tx, 10);
    const ty        = parseInt(req.params.ty, 10);
    const priority  = Math.max(1, parseInt(req.query.priority ?? String(DEFAULT_PRIORITY), 10));
    const cacheOnly = req.query.cacheOnly === 'true';
    const key       = `${tx},${ty}`;

    if (isNaN(tx) || isNaN(ty))
        return res.status(400).json({ error: 'tx and ty must be integers' });

    try {
        // Cache hit — always fast, never queued.
        const cached = await readCache(tx, ty);
        if (cached) {
            console.log(`[HIT ] (${tx},${ty})`);
            touchCache(tx, ty, cached);
            return res.json(cached.data);
        }

        // Cache miss + cacheOnly: tell client to keep waiting.
        if (cacheOnly) return res.status(404).json({ cached: false });

        // Deduplicate: piggyback on an in-flight fetch for the same tile.
        if (pending.has(key)) {
            console.log(`[WAIT] (${tx},${ty})`);
            return res.json(await pending.get(key));
        }

        console.log(`[MISS] (${tx},${ty})  priority=${priority}  queue=${q.length} waiting`);
        const p = enqueue(() => fetchOverpass(tx, ty), priority, key);
        pending.set(key, p);

        let data;
        try   { data = await p; }
        finally { pending.delete(key); }

        await writeCache(tx, ty, data);
        evictLRU().catch(console.error);
        return res.json(data);

    } catch (err) {
        console.error(`[ERR ] (${tx},${ty}): ${err.message}`);
        return res.status(502).json({ error: err.message });
    }
});

app.get('/test', async (_req, res) => {
    const results = [];
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const r = await fetch(mirror, {
                method:  'POST',
                body:    'data=' + encodeURIComponent(
                    '[out:json];node(51.505,-0.09,51.506,-0.089);out count;'
                ),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent':   'TileMapApp/1.0 (local dev)',
                },
                signal: AbortSignal.timeout(8000),
            });
            results.push({ mirror, status: r.status, ok: r.ok });
        } catch (e) {
            results.push({ mirror, status: 'fetch failed', error: e.message });
        }
    }
    res.json(results);
});

app.get('/stats', async (_req, res) => {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
    res.json({
        cachedTiles:  files.length,
        maxTiles:     MAX_CACHE_TILES,
        bgQueue:      bgQueue.length,
        queueWaiting: q.length,
        queueRunning: running,
        pendingCount: pending.size,
        maxQueueSize: MAX_QUEUE_SIZE,
        poiCached: (await fs.readdir(POI_CACHE_DIR)).filter(f => f.endsWith('.json')).length,
    });
});

app.listen(PORT, () => {
    console.log(`Tile server  →  http://localhost:${PORT}`);
    console.log(`Cache dir    →  ${CACHE_DIR}`);
    console.log(`Test URL     →  http://localhost:${PORT}/test`);
});