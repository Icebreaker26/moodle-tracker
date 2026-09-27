// Entrega de tareas, en dos pasos: 1) vista previa (no escribe nada en Moodle) y 2) confirmación con código.
//
// Garantías:
//  - La vista previa solo LEE. Nada se sube ni se guarda hasta ejecutar la confirmación.
//  - El código de confirmación depende de la tarea, los archivos (contenido incluido), el texto y si es
//    definitiva. Si algo cambia, el código deja de servir. Además caduca a los 30 minutos.
//  - Guardar como borrador y enviar definitivamente son cosas distintas.
//  - Toda entrega queda registrada en data/submissions.log.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PLAN_TTL_MS = 30 * 60 * 1000;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class SubmitError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'SubmitError';
    this.details = details;
  }
}

const cfg = (a, plugin, name) => (a.configs || []).find((c) => c.plugin === plugin && c.name === name)?.value;
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/** Nombres de los archivos que ya hay subidos en la entrega actual. */
function currentFiles(status) {
  const sub = status?.lastattempt?.submission || status?.lastattempt?.teamsubmission;
  const names = [];
  for (const p of sub?.plugins || []) {
    if (p.type !== 'file') continue;
    for (const area of p.fileareas || []) for (const f of area.files || []) names.push(f.filename);
  }
  return names;
}

function planCode({ assignId, files, text, final }) {
  const payload = JSON.stringify({ assignId, files: files.map((f) => [f.name, f.sha256]), text: text || '', final: !!final });
  return sha256(payload).slice(0, 8);
}

/**
 * Prepara la entrega. Solo hace lecturas. Devuelve el plan (con su código) o lanza SubmitError
 * con la lista de motivos por los que NO se puede entregar.
 */
export async function buildPlan(client, { courseId, assignId, files = [], text = '', final = false, now = Date.now() }) {
  const list = await client.call('mod_assign_get_assignments', { courseids: [courseId] });
  const a = (list.courses || []).flatMap((c) => c.assignments || []).find((x) => x.id === assignId);
  if (!a) throw new SubmitError('No encontré esa tarea en el curso indicado');
  const st = await client.call('mod_assign_get_submission_status', { assignid: a.id });
  const la = st.lastattempt || {};

  const errors = [];
  const warnings = [];

  if (a.nosubmissions) errors.push('Esta tarea no recibe entregas en línea.');
  if (la.submissionsenabled === false) errors.push('Las entregas en línea están desactivadas para esta tarea.');
  if (la.locked) errors.push('La entrega está bloqueada por el profesor.');
  if (la.caneditowner === false) errors.push('Moodle no te permite editar la entrega en este momento.');
  if (a.allowsubmissionsfromdate && a.allowsubmissionsfromdate * 1000 > now) errors.push('Las entregas aún no están abiertas.');
  if (a.cutoffdate && a.cutoffdate * 1000 < now) errors.push('Las entregas ya cerraron (fecha de cierre superada).');
  const late = !!(a.duedate && a.duedate * 1000 < now);
  if (late && !errors.length) warnings.push('La fecha límite ya pasó: será una entrega tardía.');
  if (a.teamsubmission) warnings.push('Es una tarea en grupo: la entrega cuenta para todo el grupo.');

  const fileOn = cfg(a, 'file', 'enabled') === '1';
  const textOn = cfg(a, 'onlinetext', 'enabled') === '1';
  if (!files.length && !text) errors.push('No hay nada que entregar: indica al menos un archivo o un texto.');
  if (files.length && !fileOn) errors.push('Esta tarea no acepta archivos.');
  if (text && !textOn) errors.push('Esta tarea no acepta texto en línea.');

  const maxFiles = Number(cfg(a, 'file', 'maxfilesubmissions') || 0);
  const maxBytes = Number(cfg(a, 'file', 'maxsubmissionsizebytes') || 0);
  const types = (cfg(a, 'file', 'filetypeslist') || '').split(/[,;\s]+/).filter(Boolean);
  const extTypes = types.filter((t) => t.startsWith('.')).map((t) => t.toLowerCase());
  if (maxFiles && files.length > maxFiles) errors.push(`Solo se permiten ${maxFiles} archivo(s) y indicaste ${files.length}.`);
  if (types.length && !extTypes.length) warnings.push(`Moodle restringe los tipos de archivo (${types.join(', ')}); se comprobará al subir.`);

  const planFiles = [];
  for (const p of files) {
    let buf;
    try {
      buf = await fs.readFile(p);
    } catch {
      errors.push(`No pude leer el archivo: ${p}`);
      continue;
    }
    const name = path.basename(p);
    const ext = path.extname(name).toLowerCase();
    if (!buf.length) errors.push(`El archivo está vacío: ${name}`);
    if (maxBytes > 0 && buf.length > maxBytes) errors.push(`${name} pesa ${fmtBytes(buf.length)} y el máximo es ${fmtBytes(maxBytes)}.`);
    if (extTypes.length && !extTypes.includes(ext)) errors.push(`${name}: solo se aceptan ${extTypes.join(', ')}.`);
    planFiles.push({ path: path.resolve(p), name, size: buf.length, sha256: sha256(buf) });
  }

  const replaces = planFiles.length ? currentFiles(st) : [];
  if (replaces.length) warnings.push(`Reemplazará los archivos que ya subiste: ${replaces.join(', ')}.`);

  const requiresStatement = a.requiresubmissionstatement === 1;
  const drafts = a.submissiondrafts === 1;
  const definitive = !drafts || !!final; // sin botón "Enviar", guardar ya cuenta como entrega
  if (!drafts) warnings.push('Esta tarea NO usa el botón "Enviar": al guardar, la entrega queda hecha.');
  if (drafts && !final) warnings.push('Se guardará como BORRADOR: el profesor no la verá hasta que la envíes.');

  if (errors.length) throw new SubmitError('No se puede preparar la entrega', errors);

  const plan = {
    code: planCode({ assignId: a.id, files: planFiles, text, final }),
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    courseId,
    assignId: a.id,
    cmid: a.cmid,
    name: a.name,
    dueAt: a.duedate > 0 ? a.duedate * 1000 : null,
    late,
    files: planFiles,
    text,
    final: !!final,
    definitive,
    requiresStatement,
    warnings,
  };
  return plan;
}

/** Ejecuta un plan ya confirmado. Vuelve a comprobar todo antes de escribir. */
export async function executePlan(client, plan, { code, acceptStatement = false, now = Date.now() }) {
  if (!plan) throw new SubmitError('No hay ninguna entrega preparada. Empieza con la vista previa.');
  if (code !== plan.code) throw new SubmitError('El código no coincide con la entrega preparada.');
  if (now > plan.expiresAt) throw new SubmitError('La vista previa caducó (30 minutos). Prepárala de nuevo.');
  if (plan.definitive && plan.requiresStatement && !acceptStatement) {
    throw new SubmitError('Esta entrega exige aceptar la declaración de autoría de Moodle. Confírmalo con --acepto-declaracion.');
  }

  // Los archivos deben ser exactamente los que viste en la vista previa.
  for (const f of plan.files) {
    let buf;
    try {
      buf = await fs.readFile(f.path);
    } catch {
      throw new SubmitError(`El archivo ya no está: ${f.path}`);
    }
    if (sha256(buf) !== f.sha256) throw new SubmitError(`El archivo cambió desde la vista previa: ${f.name}. Prepárala de nuevo.`);
  }

  // Estado actual: si alguien lo cambió mientras tanto, se detiene.
  const before = await client.call('mod_assign_get_submission_status', { assignid: plan.assignId });
  if (before.lastattempt?.locked) throw new SubmitError('La entrega quedó bloqueada.');

  const plugindata = {};
  if (plan.files.length) {
    let itemid = 0;
    for (const f of plan.files) {
      const up = await client.upload(f.path, { itemid });
      itemid = up.itemid;
    }
    plugindata.files_filemanager = itemid;
  }
  if (plan.text) plugindata.onlinetext_editor = { text: plan.text, format: 1, itemid: 0 };

  const saved = await client.call('mod_assign_save_submission', { assignmentid: plan.assignId, plugindata });
  if (Array.isArray(saved) && saved.length) {
    throw new SubmitError('Moodle no guardó la entrega', saved.map((w) => w.message || JSON.stringify(w)));
  }

  let sent = false;
  if (plan.final) {
    const res = await client.call('mod_assign_submit_for_grading', {
      assignmentid: plan.assignId,
      acceptsubmissionstatement: plan.requiresStatement ? 1 : 0,
    });
    if (Array.isArray(res) && res.length) {
      throw new SubmitError('Moodle guardó el borrador pero no pudo enviarlo', res.map((w) => w.message || JSON.stringify(w)));
    }
    sent = true;
  }

  const after = await client.call('mod_assign_get_submission_status', { assignid: plan.assignId });
  const state = after.lastattempt?.submission?.status || 'desconocido';
  return { state, sent, files: currentFiles(after), at: now };
}
