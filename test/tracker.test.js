// Pruebas contra un Moodle simulado (no toca tu Moodle real).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.TRACKER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'moodle-tracker-'));

const { Moodle, requestToken, flatten, normalizeBaseUrl } = await import('../src/moodle.js');
const { syncAll, parseSubmission } = await import('../src/sync.js');
const { bucketOf, annotate, summarize } = await import('../src/status.js');
const { createServer } = await import('../src/server.js');
const store = await import('../src/store.js');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const seen = { courseids: null };

function mockMoodle() {
  const submissions = {
    10: { lastattempt: { submission: { status: 'submitted' }, gradingstatus: 'graded', submissionsenabled: true }, feedback: { gradefordisplay: '<b>9,5 / 10</b>' } },
    11: { lastattempt: { submission: { status: 'new' }, gradingstatus: 'notgraded', submissionsenabled: true } },
    20: { lastattempt: { submission: { status: 'draft' }, gradingstatus: 'notgraded', submissionsenabled: true } },
    21: { lastattempt: { submissionsenabled: false } },
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const p = new URLSearchParams(raw);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/login/token.php') {
      if (p.get('username') === 'ana' && p.get('password') === 'secreta') return json({ token: 'tok123' });
      return json({ error: 'Nombre de usuario o contraseña incorrectos', errorcode: 'invalidlogin' });
    }
    if (req.url === '/webservice/rest/server.php') {
      if (p.get('wstoken') !== 'tok123') return json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Token inválido' });
      switch (p.get('wsfunction')) {
        case 'core_webservice_get_site_info': return json({ userid: 7, fullname: 'Ana Pérez' });
        case 'core_enrol_get_users_courses':
          return json([
            { id: 1, fullname: 'Cálculo', shortname: 'CAL', enddate: 0 },
            { id: 2, fullname: 'Linux', shortname: 'LIN', enddate: 0 },
            { id: 3, fullname: 'Curso viejo', shortname: 'OLD', enddate: NOW - 90 * DAY },
          ]);
        case 'mod_assign_get_assignments':
          seen.courseids = [0, 1, 2].map((i) => p.get(`courseids[${i}]`)).filter(Boolean).map(Number);
          return json({
            courses: [
              { id: 1, assignments: [
                { id: 10, cmid: 100, name: 'Taller 1', duedate: NOW - 2 * DAY, nosubmissions: 0 },
                { id: 11, cmid: 101, name: 'Taller 2', duedate: NOW + 2 * DAY, nosubmissions: 0 },
              ] },
              { id: 2, assignments: [
                { id: 20, cmid: 200, name: 'Ejercicio sin fecha', duedate: 0, nosubmissions: 0 },
                { id: 21, cmid: 201, name: 'Exposición en clase', duedate: NOW + 5 * DAY, nosubmissions: 1 },
              ] },
            ],
          });
        case 'mod_assign_get_submission_status': return json(submissions[p.get('assignid')] || {});
        case 'core_calendar_get_action_events_by_timesort':
          return json({ events: [
            { id: 900, name: 'Quiz 1 cierra', timesort: NOW + DAY, modulename: 'quiz', course: { id: 2, fullname: 'Linux' }, action: { actionable: true }, url: 'http://x/quiz' },
            { id: 901, name: 'Taller 2 (duplicado)', timesort: NOW + 2 * DAY, modulename: 'assign', course: { id: 1, fullname: 'Cálculo' }, action: { actionable: true } },
            { id: 902, name: 'Foro cerrado', timesort: NOW + 3 * DAY, modulename: 'forum', course: { id: 2, fullname: 'Linux' }, action: { actionable: false } },
          ] });
        default: return json({ exception: 'moodle_exception', errorcode: 'accessexception', message: 'función no permitida' });
      }
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

let mock;
before(async () => { mock = await mockMoodle(); });
after(() => mock.server.close());

test('flatten y normalizeBaseUrl', () => {
  assert.equal(flatten({ courseids: [1, 2], a: { b: 3 } }).toString(), 'courseids%5B0%5D=1&courseids%5B1%5D=2&a%5Bb%5D=3');
  assert.equal(normalizeBaseUrl('miaulavirtual.ucp.edu.co/'), 'https://miaulavirtual.ucp.edu.co');
  assert.equal(normalizeBaseUrl('https://x.edu/moodle/login/index.php'), 'https://x.edu/moodle');
});

test('requestToken: acepta credenciales correctas y rechaza las erróneas', async () => {
  assert.equal(await requestToken(mock.url, 'ana', 'secreta'), 'tok123');
  await assert.rejects(() => requestToken(mock.url, 'ana', 'mala'), (e) => e.code === 'invalidlogin');
});

test('un token inválido produce un error claro', async () => {
  const m = new Moodle({ baseUrl: mock.url, token: 'otro' });
  await assert.rejects(() => m.call('core_webservice_get_site_info'), (e) => e.code === 'invalidtoken');
});

test('parseSubmission distingue los estados', () => {
  assert.equal(parseSubmission({ lastattempt: { submission: { status: 'submitted' }, gradingstatus: 'notgraded' } }).state, 'entregada');
  assert.equal(parseSubmission({ lastattempt: { submission: { status: 'submitted' }, gradingstatus: 'graded' } }).state, 'calificada');
  assert.equal(parseSubmission({ lastattempt: { submission: { status: 'draft' } } }).state, 'borrador');
  assert.equal(parseSubmission({ lastattempt: { submission: { status: 'new' }, submissionsenabled: true } }).state, 'pendiente');
  assert.equal(parseSubmission({ lastattempt: { submissionsenabled: false } }).state, 'sin_entrega_en_linea');
  assert.equal(parseSubmission({}).state, 'pendiente');
});

test('syncAll combina tareas y calendario, sin cursos terminados ni duplicados', async () => {
  const data = await syncAll(new Moodle({ baseUrl: mock.url, token: 'tok123' }), { nowSec: NOW });
  assert.deepEqual(seen.courseids, [1, 2], 'no debe pedir el curso terminado');
  assert.equal(data.user.name, 'Ana Pérez');
  assert.equal(data.warnings.length, 0);
  const by = Object.fromEntries(data.tasks.map((t) => [t.id, t]));
  assert.equal(data.tasks.length, 5);
  assert.equal(by['assign:10'].state, 'calificada');
  assert.equal(by['assign:10'].grade, '9,5 / 10');
  assert.equal(by['assign:11'].state, 'pendiente');
  assert.equal(by['assign:11'].dueAt, (NOW + 2 * DAY) * 1000);
  assert.equal(by['assign:20'].state, 'borrador');
  assert.equal(by['assign:20'].dueAt, null);
  assert.equal(by['assign:21'].state, 'sin_entrega_en_linea');
  assert.equal(by['cal:900'].kind, 'quiz');
  assert.ok(!by['cal:901'] && !by['cal:902'], 'sin duplicar tareas ni eventos no accionables');
  assert.equal(by['assign:11'].url, `${mock.url}/mod/assign/view.php?id=101`);
});

test('bucketOf clasifica según la fecha (hora de Bogotá)', () => {
  const now = Date.parse('2026-10-05T15:00:00Z'); // 10:00 a. m. en Bogotá
  const at = (iso) => Date.parse(iso);
  const t = (over) => ({ state: 'pendiente', dueAt: null, ...over });
  assert.equal(bucketOf(t({ dueAt: at('2026-10-05T14:00:00Z') }), now), 'vencida');
  assert.equal(bucketOf(t({ dueAt: at('2026-10-06T04:00:00Z') }), now), 'hoy'); // 11 p. m. de hoy en Bogotá
  assert.equal(bucketOf(t({ dueAt: at('2026-10-06T06:00:00Z') }), now), 'semana'); // 1 a. m. de mañana
  assert.equal(bucketOf(t({ dueAt: at('2026-10-20T12:00:00Z') }), now), 'proxima');
  assert.equal(bucketOf(t({}), now), 'sin_fecha');
  assert.equal(bucketOf(t({ state: 'borrador', dueAt: at('2026-10-05T14:00:00Z') }), now), 'vencida');
  assert.equal(bucketOf(t({ state: 'entregada', dueAt: at('2026-10-05T14:00:00Z') }), now), 'entregada');
  assert.equal(bucketOf(t({ state: 'sin_entrega_en_linea' }), now), 'sin_entrega');
  assert.equal(bucketOf(t({ dueAt: at('2026-10-05T14:00:00Z') }), now, true), 'entregada', 'marcada a mano');
});

test('annotate ordena por urgencia y summarize cuenta', () => {
  const now = Date.parse('2026-10-05T15:00:00Z');
  const tasks = [
    { id: 'a', state: 'pendiente', dueAt: now + 10 * DAY * 1000 },
    { id: 'b', state: 'pendiente', dueAt: now - 1000 },
    { id: 'c', state: 'entregada', dueAt: now - 5 * DAY * 1000 },
    { id: 'd', state: 'pendiente', dueAt: null },
  ];
  const ann = annotate(tasks, {}, now);
  assert.deepEqual(ann.map((t) => t.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(summarize(ann), { vencida: 1, hoy: 0, semana: 0, proxima: 1, sin_fecha: 1, sin_entrega: 0, entregada: 1 });
});

test('API local: datos, protección de cabecera, marcar hecha y sincronizar', async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { 'X-Requested-With': 'moodle-tracker', 'Content-Type': 'application/json' };
  try {
    assert.equal((await (await fetch(`${base}/api/data`)).json()).empty, true);

    // sin sesión guardada no se puede sincronizar
    assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', headers: H })).status, 401);
    // sin la cabecera propia se rechaza (protección contra otras páginas abiertas)
    assert.equal((await fetch(`${base}/api/sync`, { method: 'POST' })).status, 403);

    await store.saveSession({ baseUrl: mock.url, token: 'tok123' });
    const synced = await (await fetch(`${base}/api/sync`, { method: 'POST', headers: H })).json();
    assert.equal(synced.tasks.length, 5);
    assert.ok(synced.counts.entregada >= 1);

    const before = synced.counts.entregada;
    const after1 = await (await fetch(`${base}/api/override`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'assign:11', done: true }) })).json();
    assert.equal(after1.counts.entregada, before + 1);
    assert.equal(after1.tasks.find((t) => t.id === 'assign:11').doneManual, true);
    const after2 = await (await fetch(`${base}/api/override`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'assign:11', done: false }) })).json();
    assert.equal(after2.counts.entregada, before);

    assert.match(await (await fetch(`${base}/`)).text(), /Mis entregas/);
    assert.equal((await fetch(`${base}/../package.json`)).status === 200, false);
  } finally {
    srv.close();
  }
});
