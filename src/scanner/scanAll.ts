import { Framework, ProjectInfo, SchemaInfo } from '../types';
import { ParseCache } from './parseCache';
import { parseGrapheneSchemas } from './grapheneParser';
import { parseStrawberrySchemas } from './strawberryParser';
import { parseAriadneSchemas } from './ariadneParser';
import { parseGraphQLFiles } from './graphqlFileParser';
import { error, info } from '../logger';

export type FrameworkParser = (rootDir: string, cache?: ParseCache) => Promise<SchemaInfo[]>;

export type ParserMap = Partial<Record<Framework, FrameworkParser>>;

export const DEFAULT_PARSERS: ParserMap = {
  graphene: parseGrapheneSchemas,
  strawberry: (rootDir: string) => parseStrawberrySchemas(rootDir),
  ariadne: (rootDir: string) => parseAriadneSchemas(rootDir),
  'graphql-schema': (rootDir: string) => parseGraphQLFiles(rootDir),
};

/**
 * Run every parser for every project and collect SchemaInfo. A failing parser
 * does NOT abort the rest — its error is logged and the remaining frameworks
 * still run. Intended as the single entry point from extension activation and
 * from tests.
 */
export async function scanProjects(
  projects: ProjectInfo[],
  cache?: ParseCache,
  parsers: ParserMap = DEFAULT_PARSERS,
): Promise<SchemaInfo[]> {
  const all: SchemaInfo[] = [];

  for (const project of projects) {
    for (const framework of project.frameworks) {
      const parser = parsers[framework];
      if (!parser) continue;
      try {
        const result = await parser(project.rootDir, cache);
        all.push(...result);
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
        error(`[scanAll] ${framework} parser failed for ${project.rootDir}: ${msg}`);
      }
    }
  }

  info(`[scanAll] Gathered ${all.length} schemas across ${projects.length} project(s)`);
  return all;
}
