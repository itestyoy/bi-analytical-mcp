// THE TASK INDEX'S THREAD: one computation of src/task-themes.js over the rows it was handed — the
// vectors packed into one buffer (transferred, not copied) — answered once, then the thread ends.

import { parentPort, workerData } from 'node:worker_threads';
import { compute } from './task-themes.js';

const { op, payload, packed } = workerData;
if (packed) {
  const all = new Float32Array(packed.buffer);
  payload.vectors = Array.from({ length: packed.n }, (_, i) => Array.from(all.subarray(i * packed.dims, (i + 1) * packed.dims)));
  if (packed.query) payload[packed.query.field] = packed.query.vector;
}
try {
  parentPort.postMessage({ ok: true, result: compute(op, payload) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e?.message || String(e) });
}
