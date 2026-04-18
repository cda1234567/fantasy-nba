// Standalone parallel probe — measures serial vs parallel fan-out on /api/state.
// No mutation. Run as: node _g1o_conc.js
const https = require('https');
const BASE = 'https://nbafantasy.cda1234567.com';

function get(path) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(BASE + path, { rejectUnauthorized: false }, (res) => {
      let n = 0;
      res.on('data', (c) => (n += c.length));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start, bytes: n }));
    });
    req.on('error', (e) => resolve({ status: -1, ms: Date.now() - start, error: String(e.message) }));
  });
}

function stats(arr) {
  if (!arr.length) return {};
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: arr.length,
    min: s[0],
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)] || s[s.length - 1],
    p99: s[Math.floor(s.length * 0.99)] || s[s.length - 1],
    max: s[s.length - 1],
    mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
  };
}

(async () => {
  // warmup
  for (let i = 0; i < 3; i++) await get('/api/state');

  // Serial 10
  const serial = [];
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const r = await get('/api/state');
    serial.push(r.ms);
  }
  const serialWall = Date.now() - t0;

  // Parallel 50
  const t1 = Date.now();
  const parallel = await Promise.all(Array.from({ length: 50 }, () => get('/api/state').then((r) => r.ms)));
  const parallelWall = Date.now() - t1;

  // Parallel 10 (for A/B vs serial 10)
  const t2 = Date.now();
  const parallel10 = await Promise.all(Array.from({ length: 10 }, () => get('/api/state').then((r) => r.ms)));
  const parallel10Wall = Date.now() - t2;

  const out = {
    version: (await (await fetch(BASE + '/api/health')).json()).version,
    serial10: { wall: serialWall, ...stats(serial) },
    parallel10: { wall: parallel10Wall, ...stats(parallel10) },
    parallel50: { wall: parallelWall, ...stats(parallel) },
  };
  console.log(JSON.stringify(out, null, 2));
  require('fs').writeFileSync('_g1o_artifacts/conc_detailed.json', JSON.stringify(out, null, 2));
})();
