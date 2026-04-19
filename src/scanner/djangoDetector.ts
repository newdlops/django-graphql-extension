import * as vscode from 'vscode';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { ProjectInfo, Framework } from '../types';
import { log, info } from '../logger';
import { isNativeAvailable, detectProjectsNativeAsync } from './nativeScanner';

const KNOWN_FRAMEWORKS: ReadonlySet<Framework> = new Set<Framework>([
  'graphene',
  'strawberry',
  'ariadne',
  'graphql-schema',
]);

function sanitizeFrameworks(fws: string[]): Framework[] {
  return fws.filter((f): f is Framework => (KNOWN_FRAMEWORKS as ReadonlySet<string>).has(f));
}

// TTL-keyed cache of the most recent detectProjects result. A full workspace
// walk costs ~200-400ms even with the native scanner; the file watcher fires
// this function for every .py save, and the project set essentially never
// changes between saves — a short-lived in-memory cache collapses that cost
// to ~0ms for the common case without risking stale state for long.
// Explicitly invalidated on workspace folder changes and on settings.py
// writes (see invalidateDetectCache) so the legitimate cases where the
// project set actually shifts still re-run detection promptly.
const DETECT_CACHE_TTL_MS = 30_000;
let detectCache: { at: number; key: string; value: ProjectInfo[] } | null = null;

function workspaceKey(): string {
  return (vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).sort().join('|')) ?? '';
}

export function invalidateDetectCache(): void {
  detectCache = null;
}

export async function detectProjects(): Promise<ProjectInfo[]> {
  const __tStart = performance.now();

  const now = Date.now();
  const key = workspaceKey();
  if (detectCache && detectCache.key === key && now - detectCache.at < DETECT_CACHE_TTL_MS) {
    const r = (n: number) => Math.round(n);
    info(
      `[timing] detectProjects [cached] total=${r(performance.now() - __tStart)}ms ` +
      `projects=${detectCache.value.length} (age=${now - detectCache.at}ms)`,
    );
    return detectCache.value;
  }

  // ---------- native fast path ----------
  // Rust walks each workspace folder once, regex-matches settings.py for
  // framework markers, pre-computes manage.py directories for root
  // resolution, and bundles .graphql/.gql detection. Dozens of
  // vscode.workspace.findFiles + openTextDocument calls collapse into a
  // single NAPI call.
  if (isNativeAvailable()) {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (workspaceFolders.length > 0) {
      const native = await detectProjectsNativeAsync(workspaceFolders);
      if (native) {
        const out: ProjectInfo[] = [];
        for (const p of native.projects) {
          const frameworks = sanitizeFrameworks(p.frameworks);
          if (frameworks.length === 0) continue;
          out.push({ rootDir: p.rootDir, frameworks });
        }
        log(`[detectProjects] Found ${out.length} project(s)`);
        for (const p of out) {
          log(`  rootDir=${p.rootDir}, frameworks=[${p.frameworks.join(', ')}]`);
        }
        const r = (n: number) => Math.round(n);
        info(
          `[timing] detectProjects [native] total=${r(performance.now() - __tStart)}ms ` +
          `walk=${native.walkMs}ms (rust=${native.totalMs}ms, projects=${out.length})`,
        );
        detectCache = { at: Date.now(), key, value: out };
        return out;
      }
    }
  }

  // ---------- JS fallback ----------
  const projects: ProjectInfo[] = [];
  const seenRoots = new Set<string>();

  // Strategy 1: Find Django settings.py with any GraphQL framework
  const __tS1Start = performance.now();
  const settingsFiles = await vscode.workspace.findFiles(
    '**/settings.py',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**,**/site-packages/**}'
  );

  for (const uri of settingsFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    const frameworks: Framework[] = [];

    if (/GRAPHENE\s*=\s*\{/.test(text) || /['"]graphene_django['"]/.test(text)) {
      frameworks.push('graphene');
    }
    if (/['"]strawberry_django['"]/.test(text) || /['"]strawberry\.django['"]/.test(text)) {
      frameworks.push('strawberry');
    }
    if (/['"]ariadne['"]/.test(text) || /['"]ariadne_django['"]/.test(text)) {
      frameworks.push('ariadne');
    }

    if (frameworks.length > 0) {
      const rootDir = await resolveProjectRoot(uri.fsPath);
      if (!seenRoots.has(rootDir)) {
        seenRoots.add(rootDir);
        projects.push({ rootDir, frameworks });
      } else {
        const existing = projects.find((p) => p.rootDir === rootDir);
        if (existing) {
          for (const fw of frameworks) {
            if (!existing.frameworks.includes(fw)) {
              existing.frameworks.push(fw);
            }
          }
        }
      }
    }
  }

  const __tS1 = performance.now() - __tS1Start;

  // Strategy 2: Find Python files importing graphql frameworks (no settings.py required)
  const __tS2Start = performance.now();
  const pyFiles = await vscode.workspace.findFiles(
    '**/*.py',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**,**/site-packages/**,**/migrations/**,**/__pycache__/**}',
    50 // limit to 50 files for quick scan
  );

  for (const uri of pyFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    const frameworks: Framework[] = [];

    if (/(?:import\s+graphene|from\s+graphene|from\s+graphene_django)/.test(text)) {
      frameworks.push('graphene');
    }
    if (/(?:import\s+strawberry|from\s+strawberry)/.test(text)) {
      frameworks.push('strawberry');
    }
    if (/(?:import\s+ariadne|from\s+ariadne)/.test(text)) {
      frameworks.push('ariadne');
    }

    if (frameworks.length > 0) {
      const rootDir = await resolveProjectRoot(uri.fsPath);
      if (!seenRoots.has(rootDir)) {
        seenRoots.add(rootDir);
        projects.push({ rootDir, frameworks });
      } else {
        // Merge frameworks into existing project
        const existing = projects.find((p) => p.rootDir === rootDir);
        if (existing) {
          for (const fw of frameworks) {
            if (!existing.frameworks.includes(fw)) {
              existing.frameworks.push(fw);
            }
          }
        }
      }
    }
  }

  const __tS2 = performance.now() - __tS2Start;

  // Strategy 3: Find .graphql / .gql schema files
  const __tS3Start = performance.now();
  const graphqlFiles = await vscode.workspace.findFiles(
    '**/*.{graphql,gql}',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}',
    10
  );

  if (graphqlFiles.length > 0) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(graphqlFiles[0]);
    const rootDir = workspaceFolder?.uri.fsPath ?? path.dirname(graphqlFiles[0].fsPath);
    if (!seenRoots.has(rootDir)) {
      seenRoots.add(rootDir);
      projects.push({ rootDir, frameworks: ['graphql-schema'] });
    } else {
      // Add graphql-schema framework to existing project
      const existing = projects.find((p) => p.rootDir === rootDir);
      if (existing && !existing.frameworks.includes('graphql-schema')) {
        existing.frameworks.push('graphql-schema');
      }
    }
  }

  const __tS3 = performance.now() - __tS3Start;

  log(`[detectProjects] Found ${projects.length} project(s)`);
  for (const p of projects) {
    log(`  rootDir=${p.rootDir}, frameworks=[${p.frameworks.join(', ')}]`);
  }

  const r = (n: number) => Math.round(n);
  info(
    `[timing] detectProjects [js] total=${r(performance.now() - __tStart)}ms ` +
    `s1.settings=${r(__tS1)}ms(n=${settingsFiles.length}) ` +
    `s2.py=${r(__tS2)}ms(n=${pyFiles.length}) ` +
    `s3.graphql=${r(__tS3)}ms(n=${graphqlFiles.length})`,
  );

  detectCache = { at: Date.now(), key, value: projects };
  return projects;
}

async function resolveProjectRoot(settingsPath: string): Promise<string> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(settingsPath));
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  // Walk up from settings.py dir toward workspace root, looking for manage.py
  let dir = path.dirname(settingsPath);
  while (dir !== path.dirname(dir)) {
    const manageFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(dir, 'manage.py')
    );
    if (manageFiles.length > 0) {
      return dir;
    }
    // Don't go above workspace root
    if (workspaceRoot && dir === workspaceRoot) {
      break;
    }
    dir = path.dirname(dir);
  }

  // Fallback: parent of settings.py dir
  return path.dirname(path.dirname(settingsPath));
}
