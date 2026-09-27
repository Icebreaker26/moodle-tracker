// Pruebas de la lectura de contenido de cursos contra un Moodle simulado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, promises as fsp } from 'node:fs';

process.env.TRACKER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'moodle-content-'));
const { Moodle } = await import('../src/moodle.js');
const { readContent, stripHtml, unviewedMaterial, downloadMaterial } = await import('../src/content.js');
const { syncAll } = await import('../src/sync.js');
const { bucketOf } = await import('../src/status.js');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const ME = 7;
const PDF = Buffer.from('%PDF-1.4 contenido de prueba');
let server, url, base;
const seen = { downloads: [] };

const mod = (id, modname, name, over = {}) => ({ id, instance: id * 10, modname, name, url: `http://x/mod/${modname}/view.php?id=${id}`, uservisible: true, completion: 0, dates: [], contents: [], ...over });

const SECTIONS = () => [
  { name: 'Semana 1', summary: '<p>Introducción</p>', modules: [
    mod(1, 'forum', 'Foro con fecha (no participé)', { completion: 0, dates: [{ label: 'Vencimiento:', timestamp: NOW + 2 * DAY }] }),
    mod(2, 'forum', 'Foro con fecha (sí participé)', { dates: [{ label: 'Vencimiento:', timestamp: NOW + 3 * DAY }] }),
    mod(3, 'forum', 'Foro por completar', { completion: 2, completiondata: { state: 0 } }),
    mod(4, 'quiz', 'Cuestionario sin intentar y ya cerrado'),
    mod(5, 'quiz', 'Cuestionario terminado'),
    mod(6, 'feedback', 'Encuesta de percepción', { completion: 1, completiondata: { state: 0 } }),
    mod(7, 'feedback', 'Encuesta ya hecha', { completion: 1, completiondata: { state: 1 } }),
    mod(8, 'resource', 'Lectura 1 (sin ver)', { completion: 2, completiondata: { state: 0 }, contents: [{ type: 'file', filename: 'Lectura 1.pdf', filesize: PDF.length, mimetype: 'application/pdf', timemodified: NOW, fileurl: `${base}/webservice/pluginfile.php/1/mod_resource/content/0/Lectura%201.pdf` }] }),
    mod(9, 'label', 'Bienvenidos', { description: '<p>Hola &amp; bienvenidos</p>' }),
  ] },
  { name: 'Semana 2', summary: '', modules: [
    mod(10, 'collabwordcloud', 'Para mi fe es...', { completion: 1, completiondata: { state: 0 }, dates: [{ label: 'Cierre:', timestamp: NOW + 4 * DAY }] }),
    mod(11, 'assign', 'Una tarea (se cubre aparte)', { completion: 1, completiondata: { state: 0 } }),
  ] },
];

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/webservice/pluginfile.php')) {
      seen.downloads.push(new URL(req.url, 'http://x').searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(PDF);
    }
    const p = new URLSearchParams(raw);
    switch (p.get('wsfunction')) {
      case 'core_webservice_get_site_info': return json({ userid: ME, fullname: 'Ana' });
      case 'core_course_get_enrolled_courses_by_timeline_classification': return json({ courses: [{ id: 2, fullname: 'Seminario', shortname: 'SEM' }], nextoffset: 1 });
      case 'core_course_get_contents': return json(SECTIONS());
      case 'core_completion_get_activities_completion_status':
        return json({ statuses: [
          { cmid: 3, modname: 'forum', state: 0, tracking: 2, details: [
            { rulename: 'completionreplies', rulevalue: { status: 0, description: 'Publicar respuestas: 1' } },
            { rulename: 'completionposts', rulevalue: { status: 1, description: 'Hacer publicaciones en el foro: 2' } } ] },
          { cmid: 6, modname: 'feedback', state: 0, tracking: 1, details: [] },
        ] });
      case 'mod_assign_get_assignments': return json({ courses: [] });
      case 'mod_forum_get_forums_by_courses':
        return json([
          { id: 10, course: 2, name: 'Foro con fecha (no participé)', type: 'general', duedate: NOW + 2 * DAY, cutoffdate: 0 },
          { id: 20, course: 2, name: 'Foro con fecha (sí participé)', type: 'general', duedate: NOW + 3 * DAY, cutoffdate: 0 },
          { id: 30, course: 2, name: 'Foro por completar', type: 'general', duedate: 0, cutoffdate: 0 },
        ]);
      case 'mod_forum_get_forum_discussions': {
        const id = Number(p.get('forumid'));
        if (id === 10) return json({ discussions: [{ discussion: 101, name: 'Hilo ajeno', subject: 'Hilo ajeno', message: '<p>Mensaje del <b>profesor</b></p>', userid: 99, userfullname: 'Profe', timemodified: NOW - 3600 }] });
        if (id === 20) return json({ discussions: [{ discussion: 201, name: 'Mi hilo', subject: 'Mi hilo', message: '<p>Yo publiqué</p>', userid: ME, userfullname: 'Ana', timemodified: NOW - 600 }] });
        return json({ discussions: [] });
      }
      case 'mod_forum_get_discussion_posts': return json({ posts: [{ id: 1, author: { id: 99 }, message: 'x' }] });
      case 'mod_quiz_get_quizzes_by_courses':
        return json({ quizzes: [
          { id: 40, course: 2, name: 'Cuestionario sin intentar y ya cerrado', timeopen: NOW - 10 * DAY, timeclose: NOW - 2 * DAY },
          { id: 50, course: 2, name: 'Cuestionario terminado', timeopen: 0, timeclose: 0 },
        ] });
      case 'mod_quiz_get_user_attempts':
        return json({ attempts: p.get('quizid') === '50' ? [{ state: 'finished' }] : [] });
      case 'core_calendar_get_action_events_by_timesort':
        return json({ events: [{ id: 1, name: 'Cierre del cuestionario', timesort: NOW - 2 * DAY, modulename: 'quiz', instance: 4, course: { id: 2, fullname: 'Seminario' }, action: { actionable: true } }] });
      default: return json({ exception: 'moodle_exception', errorcode: 'nofunc', message: 'no existe ' + p.get('wsfunction') });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  url = base;
});
after(() => server.close());

const client = () => new Moodle({ baseUrl: url, token: 'tok123' });
const COURSES = [{ id: 2, name: 'Seminario', short: 'SEM' }];

test('stripHtml convierte HTML de Moodle a texto', () => {
  assert.equal(stripHtml('<p>Hola &amp; <b>mundo</b></p><ul><li>uno</li><li>dos</li></ul>'), 'Hola & mundo\n• uno\n• dos');
  assert.equal(stripHtml(''), '');
});

test('readContent: esquema del curso con fechas, archivos y finalización', async () => {
  const r = await readContent(client(), COURSES, { userid: ME });
  assert.deepEqual(r.warnings, []);
  const c = r.courses[0];
  assert.equal(c.sections.length, 2);
  const lectura = c.sections[0].modules.find((m) => m.cmid === 8);
  assert.equal(lectura.completed, false);
  assert.equal(lectura.files[0].filename, 'Lectura 1.pdf');
  assert.equal(c.sections[0].modules.find((m) => m.cmid === 9).description, 'Hola & bienvenidos');
  assert.equal(c.sections[0].modules.find((m) => m.cmid === 1).dates[0].label, 'Vencimiento');
  assert.equal(c.forums.find((f) => f.id === 10).messages[0].text, 'Mensaje del profesor');
});

test('readContent: foros con fecha según hayas participado o no', async () => {
  const { tasks } = await readContent(client(), COURSES, { userid: ME });
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.equal(by['forum:10'].state, 'pendiente', 'no participé y tiene fecha');
  assert.equal(by['forum:10'].dueAt, (NOW + 2 * DAY) * 1000);
  assert.equal(by['forum:20'].state, 'entregada', 'publiqué un hilo propio');
  assert.equal(by['forum:30'].state, 'pendiente', 'sin fecha pero con finalización requerida');
  assert.equal(by['forum:30'].dueAt, null);
  assert.deepEqual(by['forum:30'].missing, ['Publicar respuestas: 1'], 'muestra qué regla de finalización falta');
});

test('readContent: cuestionarios según intentos', async () => {
  const { tasks } = await readContent(client(), COURSES, { userid: ME });
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.equal(by['quiz:40'].state, 'pendiente');
  assert.equal(bucketOf(by['quiz:40'], Date.now()), 'vencida', 'cerrado sin intentar');
  assert.equal(by['quiz:50'].state, 'entregada');
});

test('readContent: otras actividades por completar, sin material ni tareas', async () => {
  const { tasks } = await readContent(client(), COURSES, { userid: ME });
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.equal(by['mod:6'].kind, 'feedback');
  assert.equal(by['mod:6'].state, 'pendiente');
  assert.ok(!by['mod:7'], 'la encuesta ya hecha no aparece');
  assert.equal(by['mod:10'].kind, 'collabwordcloud');
  assert.equal(by['mod:10'].dueAt, (NOW + 4 * DAY) * 1000, 'toma la fecha de cierre');
  assert.ok(!by['mod:8'] && !by['mod:9'] && !by['mod:11'], 'material, etiquetas y tareas no son actividades pendientes');
});

test('material sin ver: lista solo lecturas con seguimiento pendiente', async () => {
  const r = await readContent(client(), COURSES, { userid: ME });
  assert.deepEqual(unviewedMaterial(r.courses[0]).map((m) => m.name), ['Lectura 1 (sin ver)']);
});

test('syncAll integra el contenido y no duplica eventos del calendario ya leídos', async () => {
  const data = await syncAll(client(), { nowSec: NOW });
  const ids = data.tasks.map((t) => t.id);
  assert.ok(ids.includes('quiz:40'));
  assert.ok(!ids.some((i) => i.startsWith('cal:')), 'el evento del cuestionario 40 ya se leyó desde el contenido');
  assert.equal(data.content.length, 1);
});

test('si una función de contenido falla, avisa y sigue con lo demás', async () => {
  const broken = { baseUrl: 'http://x', token: 't', call: async (fn, params) => {
    if (fn === 'mod_forum_get_forums_by_courses') throw new Error('no permitido');
    return client().call(fn, params);
  } };
  const r = await readContent(broken, COURSES, { userid: ME });
  assert.match(r.warnings.join('|'), /Foros: no permitido/);
  assert.ok(r.tasks.some((t) => t.id === 'quiz:50'), 'los cuestionarios se leyeron igual');
});

test('downloadMaterial: descarga con el token, no repite y respeta el tamaño máximo', async () => {
  const r = await readContent(client(), COURSES, { userid: ME });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'moodle-material-'));
  const first = await downloadMaterial(client(), r.courses[0], dir);
  assert.equal(first.downloaded.length, 1);
  assert.deepEqual(first.failed, []);
  assert.equal(seen.downloads.at(-1), 'tok123', 'la descarga lleva el token');
  const saved = path.join(dir, 'SEM', '01 Semana 1', 'Lectura 1.pdf');
  assert.deepEqual(await fsp.readFile(saved), PDF);

  const again = await downloadMaterial(client(), r.courses[0], dir);
  assert.equal(again.downloaded.length, 0);
  assert.equal(again.skipped[0].why, 'ya descargado');

  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'moodle-material-'));
  const tiny = await downloadMaterial(client(), r.courses[0], dir2, { maxBytes: 5 });
  assert.equal(tiny.downloaded.length, 0);
  assert.match(tiny.skipped[0].why, /pesa más de/);
});
