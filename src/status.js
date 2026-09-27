// Reglas para clasificar cada tarea según su estado de entrega y su fecha límite.

// Colombia (America/Bogota) es UTC-5 todo el año, sin horario de verano.
export const TZ_OFFSET_MS = -5 * 3600 * 1000;
const DAY = 86400000;

export function startOfLocalDay(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

/**
 * Cubos, de más a menos urgente:
 *  vencida · hoy · semana · proxima · sin_fecha · sin_entrega · entregada
 */
export function bucketOf(task, nowMs, doneManual = false) {
  if (doneManual || task.state === 'entregada' || task.state === 'calificada') return 'entregada';
  if (task.state === 'sin_entrega_en_linea') return 'sin_entrega';
  if (task.dueAt == null) return 'sin_fecha';
  if (task.dueAt < nowMs) return 'vencida';
  const today = startOfLocalDay(nowMs);
  if (task.dueAt < today + DAY) return 'hoy';
  if (task.dueAt < today + 7 * DAY) return 'semana';
  return 'proxima';
}

export const BUCKET_ORDER = ['vencida', 'hoy', 'semana', 'proxima', 'sin_fecha', 'sin_entrega', 'entregada'];

export const BUCKET_LABEL = {
  vencida: 'Vencidas sin entregar',
  hoy: 'Vencen hoy',
  semana: 'Esta semana',
  proxima: 'Más adelante',
  sin_fecha: 'Sin fecha límite',
  sin_entrega: 'Sin entrega en línea',
  entregada: 'Entregadas',
};

/** Agrega el cubo a cada tarea y las ordena por urgencia dentro de su cubo. */
export function annotate(tasks, overrides = {}, nowMs = Date.now()) {
  return tasks
    .map((t) => {
      const doneManual = !!overrides[t.id];
      return { ...t, doneManual, bucket: bucketOf(t, nowMs, doneManual) };
    })
    .sort((a, b) => {
      const bo = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
      if (bo) return bo;
      // Dentro de un cubo: las que vencen antes primero; las entregadas, las más recientes primero.
      const da = a.dueAt ?? Infinity;
      const db = b.dueAt ?? Infinity;
      return a.bucket === 'entregada' ? db - da : da - db;
    });
}

export function summarize(annotated) {
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  for (const t of annotated) counts[t.bucket]++;
  return counts;
}
