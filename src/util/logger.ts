/**
 * Structured logger. Deliberately dependency-free and line-oriented so the
 * output is greppable in a container and parseable by a log shipper.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

/**
 * Key names whose values must never reach a log line. Matched at EVERY depth:
 * a top-level check only would let `{ admin: { token } }` through, which is
 * exactly how a secret escapes in practice — nobody writes `log.info(msg,
 * { token })`, they log a config object that happens to contain one.
 */
const SECRET_KEY =
  /token|secret|password|passwd|bearer|authorization|api[_-]?key|credential|cookie|session[_-]?id|private[_-]?key|webhook[_-]?url/i;

const REDACTED = '[redacted]';

/** Depth ceiling, so a self-referential config object cannot hang the logger. */
const MAX_DEPTH = 6;

/**
 * Replaces secret-looking values and flattens anything JSON.stringify would
 * choke on. Redaction is VISIBLE rather than silent — an operator has to be
 * able to tell "this field was hidden" from "this field was never set".
 */
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[fn]';
  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : sanitize(v, depth + 1, seen);
  }
  return out;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      record[k] = SECRET_KEY.test(k) ? REDACTED : sanitize(v);
    }
  }

  // A log line must never be able to take down its caller. The scheduler logs
  // from inside a .catch(); a throw here would become an unhandled rejection
  // and the thing that fails would be the reporting, not the work.
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ t: record.t, level, scope, msg, fields: '[unserialisable]' });
  }

  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(subscope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('scout');
