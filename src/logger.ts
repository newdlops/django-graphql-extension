import * as vscode from 'vscode';

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

const LEVEL_RANK: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

let channel: vscode.OutputChannel | undefined;
let minLevel: LogLevel = 'INFO';

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Django GraphQL Explorer');
  }
  return channel;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function emit(level: LogLevel, msg: string): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[minLevel]) return;
  getLogger().appendLine(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

export function error(msg: string): void { emit('ERROR', msg); }
export function warn(msg: string): void { emit('WARN', msg); }
export function info(msg: string): void { emit('INFO', msg); }
export function debug(msg: string): void { emit('DEBUG', msg); }

// Back-compat shim: routes to INFO. Existing `log(...)` call sites keep working.
export function log(msg: string): void { info(msg); }
