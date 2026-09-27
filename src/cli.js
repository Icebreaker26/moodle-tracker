#!/usr/bin/env node
// Uso: node src/cli.js <login|sync|status|serve>
import readline from 'node:readline';
import { Moodle, MoodleError, normalizeBaseUrl, requestToken } from './moodle.js';
import { saveSession, loadSession } from './store.js';
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

async function serve() {
  const port = Number(process.env.PORT) || 4173;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Panel en ${C.bold}http://127.0.0.1:${port}${C.off}  (Ctrl+C para salir)`);
  });
}

const commands = { login, sync, status, serve };
const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log('Uso: npm run <login | sync | status | start>');
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
  process.exit(1);
}
