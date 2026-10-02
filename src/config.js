// READING THE ENVIRONMENT — one parser per kind of setting, so every variable of the same kind reads
// the same way (.env.example lists them all, with their defaults):
//
//   envFlag    on / off: 1|true|yes|on is on, 0|false|no|off is off, anything else (unset, empty, a
//              typo) is the default — a flag is never turned on or off by a value that says neither;
//   envNumber  a number at or above `min` (0 by default, so an explicit 0 is honoured — "no
//              schedule", "never expire"); unset, empty or not a number → the default;
//   envInt     the same, whole numbers only;
//   envString  the value, or the default when unset or empty.
//
// Each takes the environment to read (process.env unless given), so a caller can read a copy.

const ON = /^(1|true|yes|on)$/i;
const OFF = /^(0|false|no|off)$/i;

export function envFlag(name, fallback, env = process.env) {
  const v = String(env[name] ?? '').trim();
  return ON.test(v) ? true : OFF.test(v) ? false : fallback;
}

export function envNumber(name, fallback, { min = 0 } = {}, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function envInt(name, fallback, opts = {}, env = process.env) {
  const n = envNumber(name, fallback, opts, env);
  return Number.isInteger(n) ? n : fallback;
}

export function envString(name, fallback = undefined, env = process.env) {
  const v = env[name];
  return v == null || v === '' ? fallback : v;
}
