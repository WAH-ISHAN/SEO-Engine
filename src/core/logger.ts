export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = 'info', scope = 'uwoe'): Logger {
  const at = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, meta?: unknown) => {
    if (ORDER[lvl] > at) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const stream = ORDER[lvl] <= 2 ? process.stderr : process.stdout;
    stream.write(meta === undefined ? line + '\n' : `${line} ${safe(meta)}\n`);
  };
  return {
    error: (m, x) => emit('error', m, x),
    warn: (m, x) => emit('warn', m, x),
    info: (m, x) => emit('info', m, x),
    debug: (m, x) => emit('debug', m, x),
    child: (s) => createLogger(level, `${scope}:${s}`),
  };
}

function safe(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}
