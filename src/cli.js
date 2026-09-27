#!/usr/bin/env node
// Uso: node src/cli.js <login|sync|status|serve>
import readline from 'node:readline';
import { Moodle, MoodleError, normalizeBaseUrl, requestToken } from './moodle.js';
import path from 'node:path';
import { saveSession, loadSession, loadConfig, saveConfig, loadData, loadContent, loadPlan, savePlan, clearPlan, appendSubmissionLog, DATA_DIR } from './store.js';
import { unviewedMaterial, downloadMaterial } from './content.js';
import { isExcluded } from './status.js';
import { buildPlan, executePlan, SubmitError } from './submit.js';
import { runSync, createServer, buildPayload } from './server.js';

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) {
      if (rl.muted) rl.output.write(s === '\r\n' || s === '\n' ? s : '');
      else rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.muted = hidden;
  });
}

async function login() {
  const current = await loadSession();
  const defaultUrl = current?.baseUrl || 'https://miaulavirtual.ucp.edu.co';
  const urlAnswer = (await ask(`Dirección de tu Moodle [${defaultUrl}]: `)).trim() || defaultUrl;
  const baseUrl = normalizeBaseUrl(urlAnswer);
  const username = (await ask('Usuario o correo: ')).trim();
  const password = await ask('Contraseña (no se muestra ni se guarda): ', { hidden: true });
  console.log('');
  if (!username || !password) throw new MoodleError('Usuario y contraseña son obligatorios', 'missing');

  const token = await requestToken(baseUrl, username, password);
  const info = await new Moodle({ baseUrl, token }).call('core_webservice_get_site_info');
  await saveSession({ baseUrl, token, userid: info.userid, fullname: info.fullname });
  console.log(`${C.green}Listo.${C.off} Sesión guardada para ${C.bold}${info.fullname}${C.off}.`);
  console.log(`${C.dim}Solo se guardó un token en data/session.json. Tu contraseña no se almacenó.${C.off}`);
}

async function sync() {
  const data = await runSync((m) => console.log(`${C.dim}· ${m}${C.off}`));
  console.log(`${C.green}Sincronizado:${C.off} ${data.tasks.length} elementos en ${data.courses.length} cursos.`);
  for (const w of data.warnings) console.log(`${C.yellow}! ${w}${C.off}`);
}

async function status() {
  const p = await buildPayload();
  if (p.empty) return console.log('Todavía no hay datos. Ejecuta: npm run sync');
  const fmt = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  for (const b of p.order) {
    if (b === 'entregada') continue;
    const items = p.tasks.filter((t) => t.bucket === b);
    if (!items.length) continue;
    const color = b === 'vencida' ? C.red : b === 'hoy' ? C.yellow : C.bold;
    console.log(`\n${color}${p.labels[b]} (${items.length})${C.off}`);
    for (const t of items) console.log(`  ${t.dueAt ? fmt.format(t.dueAt) : '—'.padEnd(10)}  ${t.course} · ${t.name}`);
  }
  console.log(`\n${C.dim}${p.counts.entregada} entregadas. Datos de ${new Date(p.generatedAt).toLocaleString('es-CO')}${C.off}`);
}

const STATE_TEXT = { pendiente: 'sin completar', borrador: 'borrador sin enviar', desconocido: 'estado desconocido' };

/** Lo que NO has entregado, por curso en progreso. Con --json devuelve datos para otros programas. */
async function pending() {
  const p = await buildPayload();
  if (p.empty) return console.log('Todavía no hay datos. Ejecuta: npm run sync');
  const todo = p.tasks.filter((t) => ['vencida', 'hoy', 'semana', 'proxima', 'sin_fecha'].includes(t.bucket));
  if (process.argv.includes('--json')) {
    return console.log(JSON.stringify({ generatedAt: p.generatedAt, courses: p.courses.map((c) => c.name), pending: todo }, null, 2));
  }
  const fmt = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  console.log(`${C.bold}Entregas sin realizar en tus cursos en progreso: ${todo.length}${C.off}`);
  for (const course of p.courses) {
    const items = todo.filter((t) => t.courseId === course.id);
    console.log(`\n${C.bold}${course.name}${C.off} ${C.dim}(${items.length} pendientes)${C.off}`);
    if (!items.length) console.log(`  ${C.green}Al día${C.off}`);
    for (const t of items) {
      const color = t.bucket === 'vencida' ? C.red : t.bucket === 'hoy' ? C.yellow : '';
      const when = t.dueAt ? fmt.format(t.dueAt) : 'sin fecha';
      const tag = t.bucket === 'vencida' ? 'VENCIDA' : t.bucket === 'hoy' ? 'HOY' : '';
      console.log(`  ${color}${tag ? tag.padEnd(8) : '        '}${C.off}${when.padEnd(24)} ${t.name}  ${C.dim}[${STATE_TEXT[t.state] || t.state}]${C.off}`);
      if (t.missing?.length) console.log(`  ${' '.repeat(32)}${C.yellow}falta:${C.off} ${t.missing.join('; ')}`);
    }
  }
  console.log(`\n${C.dim}Datos de ${new Date(p.generatedAt).toLocaleString('es-CO')}${C.off}`);
}

/** Cursos que no quieres ver. Uso: exclude | exclude "texto" | exclude --remove "texto" */
async function exclude() {
  const args = process.argv.slice(3);
  const remove = args.includes('--remove');
  const text = args.filter((a) => a !== '--remove').join(' ').trim();
  const cfg = await loadConfig();
  if (text) {
    const list = new Set(cfg.excludeCourses);
    if (remove) list.delete(text);
    else list.add(text);
    cfg.excludeCourses = [...list];
    await saveConfig(cfg);
  }
  if (!cfg.excludeCourses.length) return console.log('No hay cursos excluidos.');
  console.log('Cursos excluidos (por texto contenido en el nombre):');
  for (const c of cfg.excludeCourses) console.log('  - ' + c);
}

/**
 * Entrega de tareas, siempre en dos pasos:
 *   submit "<tarea>" --file a.pdf [--file b.docx] [--text "..."] [--final]   -> vista previa (no sube nada)
 *   submit --confirm <código> [--acepto-declaracion]                           -> entrega de verdad
 *   submit --cancel                                                            -> descarta la vista previa
 */
async function submit() {
  const args = process.argv.slice(3);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const optAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const has = (name) => args.includes(name);
  const fmtDate = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  if (has('--cancel')) {
    await clearPlan();
    return console.log('Vista previa descartada. No se entregó nada.');
  }

  const session = await loadSession();
  if (!session) throw new MoodleError('Primero inicia sesión: npm run login', 'no_session');
  const client = new Moodle(session);

  // ---- Paso 2: confirmación
  if (has('--confirm')) {
    const code = opt('--confirm');
    const plan = await loadPlan();
    const result = await executePlan(client, plan, { code, acceptStatement: has('--acepto-declaracion') });
    await appendSubmissionLog({ at: new Date(result.at).toISOString(), assignId: plan.assignId, name: plan.name, courseId: plan.courseId,
      files: plan.files.map((f) => f.name), text: !!plan.text, sent: result.sent, state: result.state, code: plan.code });
    await clearPlan();
    // El mensaje sigue el estado REAL en Moodle, no la bandera --final: sin botón "Enviar", guardar ya entrega.
    const entregada = result.state === 'submitted';
    console.log(`${C.green}Hecho.${C.off} "${plan.name}" quedó en estado ${C.bold}${result.state}${C.off}${entregada ? ' (ENTREGADA: el profesor ya la ve)' : ' (borrador: aún NO la ve el profesor)'}.`);
    if (result.files.length) console.log(`Archivos en Moodle: ${result.files.join(', ')}`);
    console.log(`${C.dim}Registrado en data/submissions.log. Ejecuta npm run sync para actualizar el panel.${C.off}`);
    return;
  }

  // ---- Paso 1: vista previa
  const target = args.find((a, i) => !a.startsWith('--') && !['--file', '--text'].includes(args[i - 1]));
  if (!target) throw new MoodleError('Indica la tarea: npm run submit -- "nombre o id" --file archivo.pdf', 'missing');
  const data = await loadData();
  if (!data) throw new MoodleError('Primero sincroniza: npm run sync', 'no_data');
  const wanted = target.replace(/^assign:/, '');
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const matches = data.tasks.filter((t) => t.id.startsWith('assign:') && (t.id === 'assign:' + wanted || norm(t.name).includes(norm(wanted))));
  if (matches.length !== 1) {
    console.log(matches.length ? 'Hay varias coincidencias, sé más específico o usa el id:' : 'No encontré esa tarea. Las que puedes entregar:');
    for (const t of (matches.length ? matches : data.tasks.filter((x) => x.id.startsWith('assign:') && x.state !== 'entregada'))) console.log(`  ${t.id.padEnd(12)} ${t.course} · ${t.name}`);
    process.exit(1);
  }
  const t = matches[0];
  const plan = await buildPlan(client, { courseId: t.courseId, assignId: Number(t.id.split(':')[1]), files: optAll('--file'), text: opt('--text') || '', final: has('--final') });
  await savePlan(plan);

  console.log(`\n${C.bold}VISTA PREVIA. Todavía no se subió nada.${C.off}`);
  console.log(`Curso:    ${t.course}\nTarea:    ${plan.name}`);
  console.log(`Vence:    ${plan.dueAt ? fmtDate.format(plan.dueAt) : 'sin fecha'}${plan.late ? `  ${C.red}(entrega tardía)${C.off}` : ''}`);
  for (const f of plan.files) console.log(`Archivo:  ${f.name}  ${C.dim}(${(f.size / 1024).toFixed(0)} KB · sha ${f.sha256.slice(0, 8)})${C.off}`);
  if (plan.text) console.log(`Texto:    ${plan.text.length} caracteres`);
  console.log(`Acción:   ${plan.definitive ? `${C.red}ENTREGA DEFINITIVA${C.off}` : 'guardar como borrador (se puede editar)'}`);
  for (const w of plan.warnings) console.log(`${C.yellow}! ${w}${C.off}`);
  if (plan.definitive && plan.requiresStatement) console.log(`${C.yellow}! Moodle exige aceptar la declaración de autoría: esta tarea es tu propio trabajo.${C.off}`);
  const extra = plan.definitive && plan.requiresStatement ? ' --acepto-declaracion' : '';
  console.log(`\nPara ejecutarla (caduca a las ${new Date(plan.expiresAt).toLocaleTimeString('es-CO')}):\n  npm run submit -- --confirm ${plan.code}${extra}`);
  console.log(`Para descartarla:\n  npm run submit -- --cancel`);
}

/**
 * Contenido de los cursos ya descargado con `sync`.
 *   content [curso]             esquema: secciones y actividades con sus fechas y si las completaste
 *   content [curso] --forums    mensajes recientes de los foros y avisos
 *   content [curso] --material  material que Moodle marca como no visto
 */
async function content() {
  const args = process.argv.slice(3);
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  const c = await loadContent();
  if (!c) return console.log('Todavía no hay contenido. Ejecuta: npm run sync');
  const cfg = await loadConfig();
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const courses = c.courses.filter((x) => !isExcluded(x.name, cfg.excludeCourses) && (!text || norm(x.name).includes(norm(text))));
  const fmt = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  for (const course of courses) {
    console.log(`\n${C.bold}${course.name}${C.off}`);
    if (args.includes('--forums')) {
      for (const f of course.forums) {
        console.log(`  ${C.bold}${f.name}${C.off} ${C.dim}(${f.type === 'news' ? 'avisos' : 'foro'}${f.dueAt ? ', vence ' + fmt.format(f.dueAt) : ''})${C.off}`);
        if (!f.messages.length) console.log(`    ${C.dim}sin mensajes${C.off}`);
        for (const m of f.messages) console.log(`    ${fmt.format(m.at)} · ${m.author}: ${m.subject}\n      ${m.text.replace(/\s+/g, ' ').slice(0, 220)}`);
      }
    } else if (args.includes('--material')) {
      const mods = unviewedMaterial(course);
      if (!mods.length) console.log(`  ${C.green}Todo el material marcado como visto${C.off}`);
      for (const m of mods) console.log(`  ○ ${m.modname.padEnd(9)} ${m.name}  ${C.dim}(${m.section})${C.off}`);
    } else {
      for (const s of course.sections) {
        if (!s.modules.length) continue;
        console.log(`  ${C.dim}▸ ${s.name}${C.off}`);
        for (const m of s.modules) {
          if (m.modname === 'label') continue;
          const mark = m.completed === true ? `${C.green}✓${C.off}` : m.completed === false ? `${C.yellow}○${C.off}` : ' ';
          const dates = m.dates.map((d) => `${d.label} ${fmt.format(d.at)}`).join(' · ');
          console.log(`    ${mark} ${m.modname.padEnd(9)} ${m.name}${dates ? `  ${C.dim}${dates}${C.off}` : ''}${m.files.length ? `  ${C.dim}[${m.files.length} archivo(s)]${C.off}` : ''}`);
        }
      }
    }
  }
}

/** Descarga los archivos del material a data/material/. Uso: material [curso] [--max-mb N] */
async function material() {
  const args = process.argv.slice(3);
  const maxMb = Number(args[args.indexOf('--max-mb') + 1]) || 100;
  const text = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--max-mb').join(' ').trim();
  const session = await loadSession();
  if (!session) throw new MoodleError('Primero inicia sesión: npm run login', 'no_session');
  const c = await loadContent();
  if (!c) throw new MoodleError('Primero sincroniza: npm run sync', 'no_data');
  const cfg = await loadConfig();
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const courses = c.courses.filter((x) => !isExcluded(x.name, cfg.excludeCourses) && (!text || norm(x.name).includes(norm(text))));
  const client = new Moodle(session);
  const dir = path.join(DATA_DIR, 'material');
  let total = { downloaded: 0, skipped: 0, failed: 0 };
  for (const course of courses) {
    console.log(`\n${C.bold}${course.name}${C.off}`);
    const r = await downloadMaterial(client, course, dir, { maxBytes: maxMb * 1048576, log: (m) => console.log(`  ${C.dim}${m}${C.off}`) });
    for (const s of r.skipped.filter((x) => x.why !== 'ya descargado')) console.log(`  ${C.yellow}omitido:${C.off} ${s.file} (${s.why})`);
    for (const f of r.failed) console.log(`  ${C.red}falló:${C.off} ${f.file} (${f.why})`);
    console.log(`  ${r.downloaded.length} descargados · ${r.skipped.filter((x) => x.why === 'ya descargado').length} ya estaban · ${r.failed.length} fallidos`);
    total = { downloaded: total.downloaded + r.downloaded.length, skipped: total.skipped + r.skipped.length, failed: total.failed + r.failed.length };
  }
  console.log(`\n${C.green}Listo.${C.off} Material en ${dir}`);
}

async function serve() {
  const port = Number(process.env.PORT) || 4173;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Panel en ${C.bold}http://127.0.0.1:${port}${C.off}  (Ctrl+C para salir)`);
  });
}

const commands = { login, sync, status, pending, exclude, submit, content, material, serve };
const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log('Uso: npm run <login | sync | status | pending | content | material | exclude | submit | start>');
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  const hint =
    e.code === 'invalidlogin' ? 'Usuario o contraseña incorrectos.' :
    e.code === 'servicenotavailable' ? 'Moodle no ofrece el servicio móvil para tu cuenta.' :
    e.code === 'invalidtoken' ? 'El token ya no sirve. Vuelve a ejecutar: npm run login' : '';
  console.error(`${C.red}Error:${C.off} ${e.message}${hint ? ' ' + hint : ''}`);
  for (const d of e.details || []) console.error(`  - ${d}`);
  process.exit(1);
}
