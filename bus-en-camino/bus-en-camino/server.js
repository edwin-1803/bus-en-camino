'use strict';
/*
 * Bus en Camino: servidor sin dependencias (solo Node 18+).
 * - Guarda la ruta, las casetas (en data.json) y, en memoria, buses y personas esperando.
 * - Entrega todo en vivo por SSE (/api/stream).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed.json');
const PUBLIC = path.join(__dirname, 'public');

const BUS_TTL = 45000;      // un bus sin reportes por 45 s desaparece
const WAIT_TTL = 100000;    // "estoy esperando" sin latido por 100 s se retira
const OFF_ROUTE_M = 400;    // más lejos que esto de la ruta no cuenta como bus
const CASETA_MAX_M = 300;   // una caseta debe quedar a menos de esto de la ruta
const DEDUPE_M = 35;        // casetas más cerca que esto se consideran la misma
const MAX_CASETAS = 500;

/* ---------- datos persistentes ---------- */
const DEFAULT_DATA = {
  // Posiciones aproximadas: se ajustan desde la app (pestaña Casetas > Ajustar extremos).
  waypoints: [
    { name: 'Divalá', lat: 8.42, lng: -82.72 },
    { name: 'David', lat: 8.4333, lng: -82.4333 }
  ],
  casetas: []
};
let data;
function loadData() {
  for (const f of [DATA_FILE, SEED_FILE]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* siguiente */ }
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('No se pudo guardar data.json:', e.message); }
}
data = loadData();
if (!Array.isArray(data.waypoints) || data.waypoints.length < 2) data.waypoints = DEFAULT_DATA.waypoints;
if (!Array.isArray(data.casetas)) data.casetas = [];

/* ---------- ruta ---------- */
let route = { ver: 0, approx: true, pts: [], cum: [], len: 0 };

function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function buildRoute() {
  const w = data.waypoints;
  let pts = null;
  try {
    const coords = w.map(p => p.lng + ',' + p.lat).join(';');
    const url = 'https://router.project-osrm.org/route/v1/driving/' + coords + '?overview=full&geometries=geojson';
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code === 'Ok' && j.routes && j.routes[0]) {
      pts = j.routes[0].geometry.coordinates.map(c => [Number(c[1].toFixed(6)), Number(c[0].toFixed(6))]);
    }
  } catch (e) { console.warn('OSRM no disponible, uso línea recta:', e.message); }
  const approx = !pts;
  if (!pts) pts = w.map(p => [p.lat, p.lng]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  route = { ver: route.ver + 1, approx, pts, cum, len: cum[cum.length - 1] };
  for (const c of data.casetas) {
    const pr = project(c.lat, c.lng);
    c.s = pr ? pr.s : 0;
  }
  console.log('Ruta lista:', pts.length, 'puntos,', Math.round(route.len), 'm', approx ? '(aproximada)' : '(por carretera)');
}

function project(lat, lng) {
  const P = route.pts;
  if (P.length < 2) return null;
  const k = Math.cos(lat * Math.PI / 180) * 111320, m = 110540;
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < P.length - 1; i++) {
    const ax = (P[i][1] - lng) * k, ay = (P[i][0] - lat) * m;
    const bx = (P[i + 1][1] - lng) * k, by = (P[i + 1][0] - lat) * m;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, s: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]) };
  }
  return best;
}

/* ---------- estado en vivo ---------- */
const live = new Map();   // id -> reporte de posición
const waits = new Map();  // id -> { caseta, dir, ts }

function cleanup() {
  const now = Date.now();
  for (const [id, r] of live) if (now - r.ts > BUS_TTL) live.delete(id);
  for (const [id, w] of waits) if (now - w.ts > WAIT_TTL) waits.delete(id);
}

function clusterBuses() {
  const fresh = [...live.values()].filter(r => !r.off)
    .sort((a, b) => (a.role === 'driver' ? 0 : 1) - (b.role === 'driver' ? 0 : 1) || a.s - b.s);
  const cl = [];
  for (const r of fresh) {
    if (r.role !== 'driver') {
      const c = cl.find(c => c.dir === r.dir && Math.abs(c.s - r.s) < 120);
      if (c) { c.n++; continue; }
    }
    cl.push({ id: r.id, role: r.role, dir: r.dir, lat: r.lat, lng: r.lng, s: Math.round(r.s), speed: Number(r.speed.toFixed(1)), n: 1 });
  }
  return cl;
}

function snapshot() {
  const waiting = {};
  for (const w of waits.values()) {
    const key = w.caseta + '|' + w.dir;
    waiting[key] = (waiting[key] || 0) + 1;
  }
  return {
    ts: Date.now(),
    routeVer: route.ver,
    buses: clusterBuses(),
    waiting,
    casetas: data.casetas.map(c => ({ id: c.id, name: c.name, town: c.town, lat: c.lat, lng: c.lng, s: Math.round(c.s || 0), by: c.by }))
  };
}

const clients = new Set();
function broadcast() {
  const msg = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) res.write(msg);
}
let kickTimer = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; broadcast(); }, 250);
}
setInterval(() => { cleanup(); if (clients.size) broadcast(); }, 2000);

/* ---------- utilidades HTTP ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 30000) { reject(new Error('Cuerpo muy grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
const okId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v);
const okNum = (v, a, b) => typeof v === 'number' && isFinite(v) && v >= a && v <= b;
const clean = (v, max) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Prohibido'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- rutas de la API ---------- */
async function handleApi(req, res, pathname, query) {
  const m = req.method;

  if (m === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, route: route.ver, approx: route.approx, casetas: data.casetas.length });

  if (m === 'GET' && pathname === '/api/route') {
    return send(res, 200, { ver: route.ver, approx: route.approx, waypoints: data.waypoints, pts: route.pts, cum: route.cum.map(Math.round), len: Math.round(route.len) });
  }

  if (m === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && pathname === '/api/export') {
    if (query.get('pin') !== ADMIN_PIN) return send(res, 403, { error: 'PIN incorrecto' });
    return send(res, 200, data);
  }

  if (m !== 'POST') return send(res, 404, { error: 'No existe' });
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  if (pathname === '/api/pos') {
    if (!okId(b.id) || !['driver', 'passenger'].includes(b.role) || ![1, -1].includes(b.dir) || !okNum(b.lat, -90, 90) || !okNum(b.lng, -180, 180)) return send(res, 400, { error: 'Datos inválidos' });
    const pr = project(b.lat, b.lng);
    const now = Date.now(), prev = live.get(b.id);
    const off = pr.d > OFF_ROUTE_M;
    let speed = prev ? prev.speed : 0;
    if (prev && now - prev.ts > 500 && !prev.off && !off) {
      const inst = Math.abs(pr.s - prev.s) / ((now - prev.ts) / 1000);
      speed = prev.speed ? 0.7 * prev.speed + 0.3 * inst : inst;
    }
    live.set(b.id, { id: b.id, role: b.role, dir: b.dir, lat: b.lat, lng: b.lng, s: pr.s, d: pr.d, off, speed: Math.min(speed, 30), ts: now });
    kick();
    return send(res, 200, { ok: true, off, d: Math.round(pr.d) });
  }

  if (pathname === '/api/leave') {
    if (okId(b.id)) { live.delete(b.id); waits.delete(b.id); kick(); }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/wait') {
    if (!okId(b.id) || ![1, -1].includes(b.dir) || !data.casetas.some(c => c.id === b.caseta)) return send(res, 400, { error: 'Datos inválidos' });
    waits.set(b.id, { caseta: b.caseta, dir: b.dir, ts: Date.now() });
    kick();
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/unwait') {
    if (okId(b.id)) { waits.delete(b.id); kick(); }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/caseta') {
    const name = clean(b.name, 60), town = clean(b.town, 40);
    if (!okId(b.id) || name.length < 2 || town.length < 2 || !okNum(b.lat, -90, 90) || !okNum(b.lng, -180, 180)) return send(res, 400, { error: 'Falta el nombre o el poblado de la caseta.' });
    if (data.casetas.length >= MAX_CASETAS) return send(res, 400, { error: 'Se alcanzó el máximo de casetas.' });
    const pr = project(b.lat, b.lng);
    if (pr.d > CASETA_MAX_M) return send(res, 400, { error: 'Esa ubicación queda a ' + Math.round(pr.d) + ' m de la ruta. Acércate a la carretera.' });
    const near = data.casetas.find(c => hav([c.lat, c.lng], [b.lat, b.lng]) < DEDUPE_M);
    if (near) return send(res, 409, { error: 'Ya hay una caseta aquí: ' + near.name + ' (' + near.town + ').', existing: near.id });
    const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, town, lat: Number(b.lat.toFixed(6)), lng: Number(b.lng.toFixed(6)), s: pr.s, by: b.id, ts: Date.now() };
    data.casetas.push(c);
    saveData(); kick();
    return send(res, 200, { ok: true, caseta: { id: c.id } });
  }

  if (pathname === '/api/caseta/delete') {
    const i = data.casetas.findIndex(c => c.id === b.caseta);
    if (i < 0) return send(res, 404, { error: 'No existe esa caseta.' });
    const isAdmin = b.pin && b.pin === ADMIN_PIN;
    if (!isAdmin && data.casetas[i].by !== b.id) return send(res, 403, { error: 'Solo quien la creó puede eliminarla.' });
    const [gone] = data.casetas.splice(i, 1);
    for (const [id, w] of waits) if (w.caseta === gone.id) waits.delete(id);
    saveData(); kick();
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/waypoints') {
    if (b.pin !== ADMIN_PIN) return send(res, 403, { error: 'PIN incorrecto.' });
    const w = b.waypoints;
    if (!Array.isArray(w) || w.length < 2 || w.length > 6 || !w.every(p => okNum(p.lat, -90, 90) && okNum(p.lng, -180, 180) && clean(p.name, 40).length >= 2)) return send(res, 400, { error: 'Puntos inválidos.' });
    data.waypoints = w.map(p => ({ name: clean(p.name, 40), lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) }));
    await buildRoute();
    live.clear();
    saveData(); kick();
    return send(res, 200, { ok: true, approx: route.approx });
  }

  return send(res, 404, { error: 'No existe' });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    handleApi(req, res, u.pathname, u.searchParams).catch(e => { console.error(e); send(res, 500, { error: 'Error del servidor' }); });
  } else {
    serveStatic(req, res, u.pathname);
  }
});

buildRoute().then(() => {
  server.listen(PORT, () => {
    console.log('Bus en Camino escuchando en el puerto ' + PORT);
    if (ADMIN_PIN === '1234') console.warn('AVISO: usa la variable ADMIN_PIN para cambiar el PIN de administrador (ahora es 1234).');
  });
});
