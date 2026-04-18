// Phase (m): logger levels. Setting minLevel filters everything below it.

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { __clearMockLog, __getMockLog } from 'vscode';
import { setLogLevel, error, warn, info, debug, log } from '../logger';

beforeEach(() => {
  __clearMockLog();
  setLogLevel('INFO');
});

function tagsOf(lines: string[]): string[] {
  return lines.map((l) => {
    const m = l.match(/\[(ERROR|WARN|INFO|DEBUG)\]/);
    return m ? m[1] : '';
  });
}

describe('logger — level filtering (phase m)', () => {
  it('at INFO, emits ERROR/WARN/INFO but drops DEBUG', () => {
    setLogLevel('INFO');
    error('e'); warn('w'); info('i'); debug('d');
    expect(tagsOf(__getMockLog()).sort()).toEqual(['ERROR', 'INFO', 'WARN']);
  });

  it('at DEBUG, emits everything', () => {
    setLogLevel('DEBUG');
    error('e'); warn('w'); info('i'); debug('d');
    expect(tagsOf(__getMockLog()).sort()).toEqual(['DEBUG', 'ERROR', 'INFO', 'WARN']);
  });

  it('at ERROR, emits ONLY ERROR', () => {
    setLogLevel('ERROR');
    error('e'); warn('w'); info('i'); debug('d');
    expect(tagsOf(__getMockLog())).toEqual(['ERROR']);
  });

  it('back-compat `log()` routes to INFO', () => {
    setLogLevel('INFO');
    log('hello');
    const lines = __getMockLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[INFO]');
    expect(lines[0]).toContain('hello');
  });

  it('timestamps each line', () => {
    error('x');
    const lines = __getMockLog();
    // ISO 8601 timestamp at the start: YYYY-MM-DDTHH:MM:SS...
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
