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
      // Never let a secret ride along in a log line.
      if (/token|secret|password|bearer|authorization/i.test(k)) continue;
      record[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
    }
  }
  const line = JSON.stringify(record);
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
