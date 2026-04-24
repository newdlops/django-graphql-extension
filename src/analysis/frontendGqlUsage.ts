import * as vscode from 'vscode';
import * as path from 'path';
import { parseGqlFields, collectDocumentFragments, FragmentDef } from '../codelens/gqlCodeLensProvider';
import { log } from '../logger';

export interface FrontendGqlOperation {
  kind: 'query' | 'mutation' | 'subscription' | 'fragment' | 'anonymous';
  label: string;
  lineNumber: number;
  rootFields: string[];
}

export interface FrontendGqlFileUsage {
  filePath: string;
  relativePath: string;
  operationCount: number;
  operations: FrontendGqlOperation[];
}

interface GqlTemplate {
  body: string;
  startOffset: number;
}

const FRONTEND_GQL_GLOB = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,vue,svelte,astro}';
const FRONTEND_GQL_EXCLUDE = '**/{node_modules,dist,build,.next,.nuxt,.turbo,.yarn,coverage,out,out-e2e}/**';
const FRONTEND_EXT_RE = /\.(?:[cm]?[jt]sx?|[cm]?[jt]s|vue|svelte|astro)$/i;
const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.yarn',
  'coverage',
  'out',
  'out-e2e',
]);

export async function scanFrontendGqlUsages(): Promise<FrontendGqlFileUsage[]> {
  const uris = await vscode.workspace.findFiles(FRONTEND_GQL_GLOB, FRONTEND_GQL_EXCLUDE);
  const candidates = uris.filter((uri) => isFrontendCandidate(uri.fsPath));
  const commonRoot = findCommonParent(candidates.map((uri) => uri.fsPath));

  const results = await Promise.all(candidates.map(async (uri) => {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      const workspaceFolder = typeof vscode.workspace.getWorkspaceFolder === 'function'
        ? vscode.workspace.getWorkspaceFolder(uri)
        : undefined;
      const baseDir = workspaceFolder?.uri?.fsPath ?? commonRoot;
      const relativePath = baseDir
        ? normalizeSlashes(path.relative(baseDir, uri.fsPath))
        : normalizeSlashes(uri.fsPath);
      return extractFrontendGqlUsageFromText(text, uri.fsPath, relativePath);
    } catch {
      return null;
    }
  }));

  return results
    .filter((usage): usage is FrontendGqlFileUsage => !!usage)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Result of a workspace-wide frontend fragment scan.
 *
 * Two complementary indexes are built in the same pass:
 * - `fragments` — fragment NAME → FragmentDef, for spread resolution when
 *   the query body's parser encounters `...FragName` and wants to inline it.
 * - `constBodies` — JS const NAME → raw gql template body text, so providers
 *   can expand `${MY_FRAGMENT}` interpolations into their fragment text at
 *   parse time (what graphql-tag does at runtime). This makes fragment
 *   resolution robust even when by-name lookup misses: the inlined text
 *   becomes local to the expanded body, and `collectFragmentDefsFromSource`
 *   picks up the fragment directly.
 */
export interface WorkspaceFragmentIndex {
  fragments: Map<string, FragmentDef>;
  constBodies: Map<string, string>;
}

/**
 * Harvest every `fragment Name on Type { ... }` definition AND every
 * `const NAME = gql\`...\`` template body from every gql literal in every
 * frontend file in the workspace. Supports both the `...FragName` spread
 * path (`fragments`) and the `${CONST}` interpolation path (`constBodies`).
 *
 * Each `FragmentDef`'s `source` is the originating file's gql body and
 * `bodyStart` points at the opening brace within that body. First occurrence
 * (by sorted path) wins on duplicates, both for fragment names and const
 * names, so builds are deterministic.
 */
export async function scanWorkspaceFragments(): Promise<WorkspaceFragmentIndex> {
  const uris = await vscode.workspace.findFiles(FRONTEND_GQL_GLOB, FRONTEND_GQL_EXCLUDE);
  const candidates = uris
    .filter((uri) => isFrontendCandidate(uri.fsPath))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  log(`[fragments] findFiles returned ${uris.length} URIs, ${candidates.length} pass the candidate filter`);
  if (candidates.length === 0) {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    log(`[fragments] NO candidates. Workspace folders: ${JSON.stringify(folders)}`);
  }

  let readFailures = 0;
  const perFile = await Promise.all(candidates.map(async (uri) => {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      return {
        fragments: collectDocumentFragments(text),
        constBodies: collectConstGqlBodies(text),
      };
    } catch {
      readFailures++;
      return { fragments: new Map<string, FragmentDef>(), constBodies: new Map<string, string>() };
    }
  }));
  if (readFailures > 0) log(`[fragments] read failed for ${readFailures}/${candidates.length} files`);

  // Merge in deterministic order so duplicate names resolve consistently.
  const mergedFragments = new Map<string, FragmentDef>();
  const mergedConstBodies = new Map<string, string>();
  for (const { fragments, constBodies } of perFile) {
    for (const [name, def] of fragments) {
      if (!mergedFragments.has(name)) mergedFragments.set(name, def);
    }
    for (const [name, body] of constBodies) {
      if (!mergedConstBodies.has(name)) mergedConstBodies.set(name, body);
    }
  }
  log(`[fragments] merged ${mergedFragments.size} unique fragment name(s), ${mergedConstBodies.size} gql const body(ies) across workspace`);
  return { fragments: mergedFragments, constBodies: mergedConstBodies };
}

/**
 * Scan a TS/JS file for `const NAME = gql\`...\`` assignments (with optional
 * `export` and optional `: TypeAnnotation`). Returns a map from the JS
 * identifier to the gql template body text (everything between the
 * backticks, unmodified — callers strip / expand as needed).
 *
 * First assignment wins on duplicate const names, matching the "first
 * definition wins" rule used elsewhere in the scanner.
 */
function collectConstGqlBodies(docText: string): Map<string, string> {
  const out = new Map<string, string>();
  // `export const NAME[: typeof FOO_DOC] = gql\`` — capture NAME, then walk
  // from the opening backtick to the matching close to get the body.
  const re = /(?:export\s+)?const\s+([A-Za-z_][\w$]*)\s*(?::[^=]*?)?\s*=\s*(?:gql|graphql)\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docText)) !== null) {
    const constName = m[1];
    const bodyStart = m.index + m[0].length;
    const bodyEnd = findTemplateEnd(docText, bodyStart);
    if (bodyEnd === -1) continue;
    if (!out.has(constName)) {
      out.set(constName, docText.substring(bodyStart, bodyEnd));
    }
  }
  return out;
}

export function extractFrontendGqlUsageFromText(
  text: string,
  filePath: string,
  relativePath: string,
): FrontendGqlFileUsage | null {
  const templates = extractGqlTemplates(text);
  if (templates.length === 0) return null;

  const operations = templates.map((tpl) => {
    const meta = readOperationMeta(tpl.body);
    return {
      kind: meta.kind,
      label: meta.label,
      lineNumber: offsetToLine(text, tpl.startOffset),
      rootFields: parseGqlFields(tpl.body).map((field) => field.name),
    } satisfies FrontendGqlOperation;
  });

  if (operations.length === 0) return null;

  return {
    filePath,
    relativePath: normalizeSlashes(relativePath),
    operationCount: operations.length,
    operations,
  };
}

function extractGqlTemplates(text: string): GqlTemplate[] {
  const out: GqlTemplate[] = [];
  const re = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const backtickIdx = text.indexOf('`', match.index);
    if (backtickIdx === -1) continue;
    const startOffset = backtickIdx + 1;
    const endOffset = findTemplateEnd(text, startOffset);
    if (endOffset <= startOffset) continue;

    const rawBody = text.substring(startOffset, endOffset);
    out.push({
      body: stripTemplateExpressions(rawBody),
      startOffset,
    });
  }
  return out;
}

function findTemplateEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') return i;
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
}

function stripTemplateExpressions(body: string): string {
  let result = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      result += '  ';
      i += 2;
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        result += ' ';
        i++;
      }
      continue;
    }
    result += body[i];
    i++;
  }
  return result;
}

function readOperationMeta(gqlBody: string): Pick<FrontendGqlOperation, 'kind' | 'label'> {
  const opMatch = /^\s*(query|mutation|subscription)\b(?:\s+([A-Za-z_]\w*))?/s.exec(gqlBody);
  if (opMatch) {
    const kind = opMatch[1] as FrontendGqlOperation['kind'];
    return {
      kind,
      label: opMatch[2] ? `${kind} ${opMatch[2]}` : kind,
    };
  }

  const fragmentMatch = /^\s*fragment\s+([A-Za-z_]\w*)\b/s.exec(gqlBody);
  if (fragmentMatch) {
    return {
      kind: 'fragment',
      label: `fragment ${fragmentMatch[1]}`,
    };
  }

  return {
    kind: 'anonymous',
    label: 'anonymous gql',
  };
}

function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function isFrontendCandidate(filePath: string): boolean {
  if (!FRONTEND_EXT_RE.test(filePath)) return false;
  const segments = normalizeSlashes(filePath).split('/');
  return !segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}

function findCommonParent(paths: string[]): string {
  if (paths.length === 0) return '';
  const dirParts = paths.map((filePath) => normalizeSlashes(path.dirname(filePath)).split('/'));
  const shared: string[] = [];
  const limit = Math.min(...dirParts.map((parts) => parts.length));
  for (let i = 0; i < limit; i++) {
    const candidate = dirParts[0][i];
    if (dirParts.every((parts) => parts[i] === candidate)) shared.push(candidate);
    else break;
  }
  if (shared.length === 0) return '';
  if (shared.length === 1 && shared[0] === '') return path.sep;
  return shared.join(path.sep) || path.sep;
}

function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, '/');
}
