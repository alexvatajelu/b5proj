
import express from 'express';
import cors    from 'cors';
import fs      from 'fs/promises';
import path    from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT      = 3000;
const CACHE_DIR = path.join(__dirname, 'tile_cache');
const MAX_TILES = 2000;

const ORIGIN   = { lat: 51.505, lon: -0.09 };
const TILE_DEG = 0.005;

const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const OVERPASS_DELAY_MS  = 1200;
const OVERPASS_TIMEOUT   = 30_000;


const MAX_QUEUE_SIZE     = 40;
const DEFAULT_PRIORITY   = 5;


const app = express();
app.use(cors());

await fs.mkdir(CACHE_DIR, { recursive: true });

const pending = new Map();


const q       = [];
let   running = 0;

function scheduleNext() {
    if (running > 0 || q.length === 0) return;
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

/**
 * @param {() => Promise<any>} fn
 * @param {number}             priority
 * @returns {Promise<any>}
 */
function enqueue(fn, priority = DEFAULT_PRIORITY) {
    return new Promise((resolve, reject) => {
        const item = { fn, resolve, reject, priority };

        let lo = 0, hi = q.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (q[mid].priority <= item.priority) lo = mid + 1;
            else hi = mid;
        }
        q.splice(lo, 0, item);

        if (q.length > MAX_QUEUE_SIZE) {
            const dropped = q.pop();
            dropped.reject(new Error('Queue overflow — request dropped (low priority)'));
            console.log(`[queue] overflow — dropped lowest-priority item (queue: ${q.length})`);
        }

        scheduleNext();
    });
}

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

const cf = (tx, ty) => path.join(CACHE_DIR, `${tx}_${ty}.json`);

async function readCache(tx, ty) {
    try   { return JSON.parse(await fs.readFile(cf(tx, ty), 'utf8')); }
    catch { return null; }
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
    await fs.writeFile(cf(tx, ty), JSON.stringify(entry));
}

async function evictLRU() {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
    if (files.length <= MAX_TILES) return;
    const meta = await Promise.all(files.map(async f => {
        try {
            const { lastAccessedAt } = JSON.parse(
                await fs.readFile(path.join(CACHE_DIR, f), 'utf8')
            );
            return { f, lastAccessedAt };
        } catch { return { f, lastAccessedAt: '1970-01-01T00:00:00Z' }; }
    }));
    meta.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
    const excess = meta.slice(0, files.length - MAX_TILES);
    await Promise.all(excess.map(({ f }) =>
        fs.unlink(path.join(CACHE_DIR, f)).catch(() => {})
    ));
    console.log(`[evict] removed ${excess.length} tile(s)`);
}


app.get('/health', (_req, res) => res.json({ ok: true }));

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

app.get('/tile/:tx/:ty', async (req, res) => {
    const tx       = parseInt(req.params.tx, 10);
    const ty       = parseInt(req.params.ty, 10);
    const priority = Math.max(1, parseInt(req.query.priority ?? String(DEFAULT_PRIORITY), 10));
    const key      = `${tx},${ty}`;

    if (isNaN(tx) || isNaN(ty))
        return res.status(400).json({ error: 'tx and ty must be integers' });

    try {
        const cached = await readCache(tx, ty);
        if (cached) {
            console.log(`[HIT ] (${tx},${ty})`);
            touchCache(tx, ty, cached);
            return res.json(cached.data);
        }

        if (pending.has(key)) {
            console.log(`[WAIT] (${tx},${ty})`);
            return res.json(await pending.get(key));
        }

        console.log(`[MISS] (${tx},${ty})  priority=${priority}  queue=${q.length} waiting`);
        const promise = enqueue(() => fetchOverpass(tx, ty), priority);
        pending.set(key, promise);

        let data;
        try   { data = await promise; }
        finally { pending.delete(key); }

        await writeCache(tx, ty, data);
        evictLRU();

        return res.json(data);

    } catch (err) {
        console.error(`[ERR ] (${tx},${ty}): ${err.message}`);
        return res.status(502).json({ error: err.message });
    }
});

app.get('/stats', async (_req, res) => {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
    res.json({
        cachedTiles:  files.length,
        maxTiles:     MAX_TILES,
        queueWaiting: q.length,
        queueRunning: running,
        maxQueueSize: MAX_QUEUE_SIZE,
    });
});

app.listen(PORT, () => {
    console.log(`Tile server  →  http://localhost:${PORT}`);
    console.log(`Cache dir    →  ${CACHE_DIR}`);
    console.log(`Test URL     →  http://localhost:${PORT}/test`);
});