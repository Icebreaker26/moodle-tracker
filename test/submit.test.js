// Pruebas del flujo de entrega contra un Moodle simulado. No se conectan a tu Moodle real.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, promises as fsp } from 'node:fs';

const DATA = mkdtempSync(path.join(os.tmpdir(), 'moodle-submit-'));
process.env.TRACKER_DATA_DIR = DATA;
const FILES = mkdtempSync(path.join(os.tmpdir(), 'moodle-files-'));

const { Moodle } = await import('../src/moodle.js');
const { buildPlan, executePlan, SubmitError, PLAN_TTL_MS } = await import('../src/submit.js');
const store = await import('../src/store.js');

const NOW = Date.now();
const S = 1000;
const DAY = 86400;

let A, sub, calls, server, url;
function reset(over = {}) {
  A = {
    id: 42, cmid: 420, name: 'Taller No. 1', duedate: Math.floor(NOW / S) + 2 * DAY, cutoffdate: 0, allowsubmissionsfromdate: 0,
    nosubmissions: 0, submissiondrafts: 1, requiresubmissionstatement: 1, teamsubmission: 0,
    configs: [
      { plugin: 'file', name: 'enabled', value: '1' },
      { plugin: 'file', name: 'maxfilesubmissions', value: '2' },
      { plugin: 'file', name: 'maxsubmissionsizebytes', value: '1048576' },
      { plugin: 'file', name: 'filetypeslist', value: '.pdf,.docx' },
      { plugin: 'onlinetext', name: 'enabled', value: '0' },
    ],
    locked: false, caneditowner: true, ...over,
  };
  sub = { status: 'new', files: [] };
  calls = [];
}

function statusBody() {
  return {
    lastattempt: {
      submission: { status: sub.status, plugins: [{ type: 'file', fileareas: [{ files: sub.files.map((f) => ({ filename: f })) }] }] },
      submissionsenabled: true, locked: A.locked, caneditowner: A.caneditowner, gradingstatus: 'notgraded',
    },
  };
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/webservice/upload.php') {
      const text = raw.toString('latin1');
      const fname = /filename="([^"]+)"/.exec(text)?.[1];
      const given = Number(/name="itemid"\r\n\r\n(\d+)/.exec(text)?.[1] || 0);
      calls.push({ fn: 'upload', fname, given });
      sub.pendingFiles = [...(sub.pendingFiles || []), fname];
      return json([{ itemid: given || 777, filename: fname }]);
    }
    const p = new URLSearchParams(raw.toString());
    const fn = p.get('wsfunction');
    const params = Object.fromEntries(p.entries());
    if (fn !== 'mod_assign_get_assignments' && fn !== 'mod_assign_get_submission_status') calls.push({ fn, params });
    switch (fn) {
      case 'mod_assign_get_assignments': return json({ courses: [{ id: 5, assignments: [A] }] });
      case 'mod_assign_get_submission_status': return json(statusBody());
      case 'mod_assign_save_submission':
        sub.files = sub.pendingFiles || sub.files; sub.pendingFiles = [];
        sub.status = A.submissiondrafts === 1 ? 'draft' : 'submitted';
        return json([]);
      case 'mod_assign_submit_for_grading':
        if (A.requiresubmissionstatement === 1 && p.get('acceptsubmissionstatement') !== '1') return json([{ item: 'x', message: 'Debes aceptar la declaración' }]);
        sub.status = 'submitted';
        return json([]);
      default: return json({ exception: 'moodle_exception', errorcode: 'nofunc', message: 'no existe ' + fn });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => reset());

const client = () => new Moodle({ baseUrl: url, token: 'tok' });
const file = (name, content = 'contenido de prueba') => { const p = path.join(FILES, name); writeFileSync(p, content); return p; };
const writes = () => calls.filter((c) => ['upload', 'mod_assign_save_submission', 'mod_assign_submit_for_grading'].includes(c.fn));
const reasons = async (promise) => { try { await promise; } catch (e) { assert.ok(e instanceof SubmitError, String(e)); return e.details; } assert.fail('debía rechazarse'); };

test('la vista previa solo lee: no sube, no guarda, no envía', async () => {
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [file('a.pdf')], now: NOW });
  assert.equal(plan.name, 'Taller No. 1');
  assert.equal(plan.files.length, 1);
  assert.equal(plan.definitive, false, 'con borradores activos y sin --final se guarda como borrador');
  assert.equal(plan.code.length, 8);
  assert.equal(writes().length, 0);
});

test('rechaza lo que Moodle no permite, con los motivos', async () => {
  const a = file('a.pdf'), big = file('big.pdf', 'x'.repeat(2 * 1024 * 1024)), img = file('foto.png'), c = file('c.pdf'), d = file('d.pdf');
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [img], now: NOW }))).join('|'), /solo se aceptan/);
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [big], now: NOW }))).join('|'), /máximo/);
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [a, c, d], now: NOW }))).join('|'), /Solo se permiten 2/);
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [], now: NOW }))).join('|'), /nada que entregar/);
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [file('e.pdf', '')], now: NOW }))).join('|'), /vacío/);
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, text: 'hola', now: NOW }))).join('|'), /no acepta texto/);
  assert.equal(writes().length, 0);
});

test('rechaza según el estado de la tarea', async () => {
  const f = file('a.pdf');
  reset({ cutoffdate: Math.floor(NOW / S) - DAY });
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW }))).join('|'), /ya cerraron/);
  reset({ allowsubmissionsfromdate: Math.floor(NOW / S) + DAY });
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW }))).join('|'), /aún no están abiertas/);
  reset({ locked: true });
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW }))).join('|'), /bloqueada/);
  reset({ nosubmissions: 1 });
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW }))).join('|'), /no recibe entregas/);
  reset({ caneditowner: false });
  assert.match((await reasons(buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW }))).join('|'), /no te permite editar/);
});

test('avisa de entrega tardía y de archivos que se reemplazan', async () => {
  reset({ duedate: Math.floor(NOW / S) - DAY });
  sub = { status: 'draft', files: ['viejo.pdf'] };
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [file('a.pdf')], now: NOW });
  assert.equal(plan.late, true);
  assert.match(plan.warnings.join('|'), /entrega tardía/);
  assert.match(plan.warnings.join('|'), /viejo\.pdf/);
});

test('el código cambia si cambian los archivos, el texto o si es definitiva', async () => {
  const f = file('a.pdf', 'uno');
  const p1 = await buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW });
  const p2 = await buildPlan(client(), { courseId: 5, assignId: 42, files: [f], final: true, now: NOW });
  writeFileSync(f, 'dos');
  const p3 = await buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW });
  assert.equal(new Set([p1.code, p2.code, p3.code]).size, 3);
});

test('confirmar exige el código correcto, que no haya caducado y que los archivos no hayan cambiado', async () => {
  const f = file('a.pdf', 'original');
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [f], now: NOW });
  await assert.rejects(() => executePlan(client(), plan, { code: 'deadbeef' }), /no coincide/);
  await assert.rejects(() => executePlan(client(), null, { code: plan.code }), /ninguna entrega preparada/);
  await assert.rejects(() => executePlan(client(), plan, { code: plan.code, now: NOW + PLAN_TTL_MS + 1000 }), /caducó/);
  writeFileSync(f, 'modificado después de la vista previa');
  await assert.rejects(() => executePlan(client(), plan, { code: plan.code, now: NOW }), /cambió desde la vista previa/);
  assert.equal(writes().length, 0, 'ninguna de las negativas escribió en Moodle');
});

test('guardar borrador: sube los archivos, guarda y NO envía', async () => {
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [file('a.pdf'), file('b.docx')], now: NOW });
  const r = await executePlan(client(), plan, { code: plan.code, now: NOW });
  assert.equal(r.state, 'draft');
  assert.equal(r.sent, false);
  assert.deepEqual(r.files, ['a.pdf', 'b.docx']);
  const ups = calls.filter((c) => c.fn === 'upload');
  assert.equal(ups.length, 2);
  assert.equal(ups[1].given, 777, 'el segundo archivo reutiliza el mismo borrador');
  const save = calls.find((c) => c.fn === 'mod_assign_save_submission');
  assert.equal(save.params['plugindata[files_filemanager]'], '777');
  assert.ok(!calls.some((c) => c.fn === 'mod_assign_submit_for_grading'));
});

test('envío definitivo: exige aceptar la declaración y luego envía', async () => {
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [file('a.pdf')], final: true, now: NOW });
  assert.equal(plan.definitive, true);
  assert.equal(plan.requiresStatement, true);
  await assert.rejects(() => executePlan(client(), plan, { code: plan.code, now: NOW }), /declaración de autoría/);
  assert.equal(writes().length, 0, 'sin aceptar la declaración no se sube nada');
  const r = await executePlan(client(), plan, { code: plan.code, acceptStatement: true, now: NOW });
  assert.equal(r.state, 'submitted');
  assert.equal(r.sent, true);
  assert.equal(calls.find((c) => c.fn === 'mod_assign_submit_for_grading').params.acceptsubmissionstatement, '1');
});

test('si la tarea no usa botón "Enviar", guardar ya es definitivo y se avisa', async () => {
  reset({ submissiondrafts: 0, requiresubmissionstatement: 0 });
  const plan = await buildPlan(client(), { courseId: 5, assignId: 42, files: [file('a.pdf')], now: NOW });
  assert.equal(plan.definitive, true);
  assert.match(plan.warnings.join('|'), /NO usa el botón/);
  const r = await executePlan(client(), plan, { code: plan.code, now: NOW });
  assert.equal(r.state, 'submitted');
});

test('CLI de punta a punta: vista previa, confirmación y registro', async () => {
  reset({ submissiondrafts: 1 });
  await store.saveSession({ baseUrl: url, token: 'tok' });
  await store.saveData({
    generatedAt: NOW, baseUrl: url, user: { id: 1, name: 'Ana' }, courses: [{ id: 5, name: 'Linux' }], warnings: [],
    tasks: [{ id: 'assign:42', kind: 'tarea', courseId: 5, course: 'Linux', name: 'Taller No. 1', dueAt: NOW + DAY * S * 2, state: 'pendiente' }],
  });
  const f = file('entrega.pdf');
  // Asíncrono a propósito: el Moodle simulado vive en este mismo proceso y no podría responder si nos bloqueáramos.
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['src/cli.js', 'submit', ...args],
    { env: { ...process.env, TRACKER_DATA_DIR: DATA }, cwd: path.resolve(import.meta.dirname, '..') },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

  const prev = await run('taller no. 1', '--file', f);
  assert.equal(prev.status, 0, prev.stderr);
  assert.match(prev.stdout, /VISTA PREVIA/);
  assert.match(prev.stdout, /guardar como borrador/);
  const code = /--confirm (\w{8})/.exec(prev.stdout)[1];
  assert.equal(writes().length, 0, 'la vista previa no escribió nada');

  const bad = await run('--confirm', '00000000');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no coincide/);
  assert.equal(writes().length, 0);

  const ok = await run('--confirm', code);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /borrador/);
  const log = (await fsp.readFile(path.join(DATA, 'submissions.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].name, 'Taller No. 1');
  assert.equal(log[0].sent, false);
  assert.equal(await store.loadPlan(), null, 'la vista previa se consume al confirmar');

  const again = await run('--confirm', code);
  assert.notEqual(again.status, 0, 'el mismo código no se puede reutilizar');

  const cancel = await run('--cancel');
  assert.match(cancel.stdout, /No se entregó nada/);
});
