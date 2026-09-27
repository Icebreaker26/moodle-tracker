// Servidor local del panel. Escucha solo en 127.0.0.1: nadie más en la red puede abrirlo.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Moodle } from './moodle.js';
import { syncAll } from './sync.js';
import { annotate, summarize, isExcluded, BUCKET_ORDER, BUCKET_LABEL } from './status.js';
import { loadSession, loadData, saveData, loadOverrides, setOverride, loadConfig, PUBLIC_DIR } from './store.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) throw new Error('Cuerpo demasiado grande');
  }
  return raw ? JSON.parse(raw) : {};
}

export async function buildPayload(now = Date.now()) {
  const [data, overrides, cfg] = await Promise.all([loadData(), loadOverrides(), loadConfig()]);
  if (!data) return { empty: true, order: BUCKET_ORDER, labels: BUCKET_LABEL };
  const hide = cfg.excludeCourses;
  const courses = data.courses.filter((c) => !isExcluded(c.name, hide));
  const tasks = annotate(data.tasks.filter((t) => !isExcluded(t.course, hide)), overrides, now);
  return {
    generatedAt: data.generatedAt,
    now,
    baseUrl: data.baseUrl,
    user: data.user,
    courses,
    excluded: hide,
    warnings: data.warnings,
    tasks,
    counts: summarize(tasks),
    order: BUCKET_ORDER,
    labels: BUCKET_LABEL,
  };
}

let syncing = null;
export async function runSync(log = () => {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const session = await loadSession();
    if (!session) throw Object.assign(new Error('Aún no has iniciado sesión. Ejecuta: npm run login'), { status: 401 });
    const cfg = await loadConfig();
    const data = await syncAll(new Moodle(session), { log, exclude: cfg.excludeCourses });
    await saveData(data);
    return data;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Las peticiones que cambian algo exigen una cabecera propia: evita que otra página web
      // abierta en tu navegador pueda disparar acciones contra este servidor local.
      if (req.method === 'POST' && req.headers['x-requested-with'] !== 'moodle-tracker') {
        return send(res, 403, { error: 'Petición no permitida' });
      }

      if (req.method === 'GET' && url.pathname === '/api/data') return send(res, 200, await buildPayload());

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        try {
          await runSync();
          return send(res, 200, await buildPayload());
        } catch (e) {
          return send(res, e.status || 502, { error: e.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/override') {
        const { id, done } = await readBody(req);
        if (typeof id !== 'string') return send(res, 400, { error: 'Falta el id' });
        await setOverride(id, !!done);
        return send(res, 200, await buildPayload());
      }

      if (req.method === 'GET') {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const full = path.join(PUBLIC_DIR, file);
        if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido', 'text/plain');
        try {
          return send(res, 200, await fs.readFile(full), MIME[path.extname(full)] || 'application/octet-stream');
        } catch {
          return send(res, 404, 'No encontrado', 'text/plain');
        }
      }
      send(res, 405, { error: 'Método no permitido' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
}
