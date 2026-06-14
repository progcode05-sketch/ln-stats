import { EventEmitter } from "node:events";

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

// Circular buffer of recent log lines sent to late-joining SSE clients.
const buffer: LogEntry[] = [];
const MAX_BUFFER = 300;

function record(level: LogLevel, args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const entry: LogEntry = { ts: Date.now(), level, msg };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  emitter.emit("entry", entry);
}

// Patch console methods once at module load.
const _log   = console.log.bind(console);
const _info  = console.info.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...a) => { _log(...a);   record("log",   a); };
console.info  = (...a) => { _info(...a);  record("info",  a); };
console.warn  = (...a) => { _warn(...a);  record("warn",  a); };
console.error = (...a) => { _error(...a); record("error", a); };

export function getRecentLogs(): LogEntry[] {
  return buffer.slice();
}

export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
  emitter.on("entry", listener);
  return () => emitter.off("entry", listener);
}
