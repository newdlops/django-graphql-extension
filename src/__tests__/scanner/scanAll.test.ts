// Phase (m): a failing parser must not take down the rest. Errors go to the
// logger (visible in tests via the mock log sink) and the orchestrator keeps
// going with whatever schemas the surviving parsers produced.

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { __clearMockLog, __getMockLog } from 'vscode';
import { scanProjects, ParserMap } from '../../scanner/scanAll';
import { ProjectInfo, SchemaInfo } from '../../types';
import { setLogLevel } from '../../logger';

function mkSchema(name: string): SchemaInfo {
  return { name, filePath: '/fake.py', queries: [], mutations: [], subscriptions: [], types: [] };
}

beforeEach(() => {
  __clearMockLog();
  setLogLevel('INFO'); // default — info+ is captured
});

describe('scanProjects — error isolation (phase m)', () => {
  const projects: ProjectInfo[] = [
    { rootDir: '/p', frameworks: ['graphene', 'strawberry', 'ariadne'] },
  ];

  it('returns schemas from every framework in the happy path', async () => {
    const parsers: ParserMap = {
      graphene: async () => [mkSchema('g')],
      strawberry: async () => [mkSchema('s')],
      ariadne: async () => [mkSchema('a')],
    };
    const schemas = await scanProjects(projects, undefined, parsers);
    expect(schemas.map((s) => s.name).sort()).toEqual(['a', 'g', 's']);
  });

  it('keeps going when one parser throws, and logs the error', async () => {
    const parsers: ParserMap = {
      graphene: async () => { throw new Error('graphene boom'); },
      strawberry: async () => [mkSchema('s')],
      ariadne: async () => [mkSchema('a')],
    };
    const schemas = await scanProjects(projects, undefined, parsers);
    // Surviving parsers still contributed schemas.
    expect(schemas.map((s) => s.name).sort()).toEqual(['a', 's']);

    const logLines = __getMockLog();
    const hasError = logLines.some((l) => l.includes('[ERROR]') && l.includes('graphene parser failed') && l.includes('graphene boom'));
    expect(hasError, 'ERROR-level line about graphene failure should be logged').toBe(true);
  });

  it('returns an empty list when every parser fails (no crash)', async () => {
    const parsers: ParserMap = {
      graphene: async () => { throw new Error('g'); },
      strawberry: async () => { throw new Error('s'); },
      ariadne: async () => { throw new Error('a'); },
    };
    const schemas = await scanProjects(projects, undefined, parsers);
    expect(schemas).toEqual([]);
    const errorCount = __getMockLog().filter((l) => l.includes('[ERROR]')).length;
    expect(errorCount).toBe(3);
  });

  it('skips frameworks with no registered parser without throwing', async () => {
    const parsers: ParserMap = {
      graphene: async () => [mkSchema('g')],
      // strawberry and ariadne intentionally omitted
    };
    const schemas = await scanProjects(projects, undefined, parsers);
    expect(schemas.map((s) => s.name)).toEqual(['g']);
  });
});
