// Thin wrapper around the Rust NAPI module in /native. Loads lazily and
// returns null when the binary is missing (wrong platform, unbuilt) or when
// running under vitest — tests rely on mocked vscode.workspace.fs, which the
// Rust walker bypasses. The JS fallback path in grapheneParser.ts takes over
// whenever this wrapper reports unavailable.

export interface NativeClassEntry {
  name: string;
  baseClasses: string[];
  lineNumber: number;
  isDataclass: boolean;
  isNested: boolean;
}

export interface NativeImports {
  fromGraphene: string[];
  fromGrapheneDjango: string[];
  hasGrapheneImport: boolean;
}

export interface NativeSchemaEntry {
  queryRootName?: string;
  mutationRootName?: string;
}

export interface NativeFileParsed {
  containsGraphene: boolean;
  classes: NativeClassEntry[];
  imports: NativeImports;
  schemaEntries: NativeSchemaEntry[];
}

export interface NativeFileResult {
  path: string;
  contentHash: string;
  /** Populated when ScanOptions.includeText is not false (default true). */
  text?: string;
  cacheHit: boolean;
  data?: NativeFileParsed;
}

export interface NativeScanStats {
  fileCount: number;
  totalBytes: number;
  walkMs: number;
  readMs: number;
  parseMs: number;
  totalMs: number;
}

export interface NativeScanResult {
  files: NativeFileResult[];
  stats: NativeScanStats;
}

export interface NativeProjectInfo {
  rootDir: string;
  frameworks: string[];
}

export interface NativeDetectResult {
  projects: NativeProjectInfo[];
  walkMs: number;
  totalMs: number;
}

interface NativeScanOpts {
  rootDir: string;
  cachedHashes: Record<string, string>;
  cachedNonemptyPaths?: string[];
  includeText?: boolean;
}

interface NativeBinding {
  scanProject(opts: NativeScanOpts): NativeScanResult;
  scanProjectAsync(opts: NativeScanOpts): Promise<NativeScanResult>;
  detectProjects(workspaceRoots: string[]): NativeDetectResult;
  detectProjectsAsync(workspaceRoots: string[]): Promise<NativeDetectResult>;
  parseFile(text: string): NativeFileParsed;
  hashText(text: string): string;
}

let loaded: NativeBinding | null = null;
let attempted = false;
let loadErr: unknown = null;

function tryLoad(): NativeBinding | null {
  if (attempted) return loaded;
  attempted = true;
  // vitest sets VITEST=true; skip native and use JS fallback so mocked
  // vscode.workspace.fs continues to drive parsing.
  if (process.env.VITEST) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('../../native') as NativeBinding;
  } catch (e) {
    loadErr = e;
    loaded = null;
  }
  return loaded;
}

export function isNativeAvailable(): boolean {
  return tryLoad() != null;
}

export function getNativeLoadError(): unknown {
  tryLoad();
  return loadErr;
}

export interface ScanNativeExtra {
  cachedNonemptyPaths?: string[];
  includeText?: boolean;
}

export function scanProjectNative(
  rootDir: string,
  cachedHashes: Record<string, string>,
  extra: ScanNativeExtra = {},
): NativeScanResult | null {
  const mod = tryLoad();
  if (!mod) return null;
  return mod.scanProject({ rootDir, cachedHashes, ...extra });
}

export async function scanProjectNativeAsync(
  rootDir: string,
  cachedHashes: Record<string, string>,
  extra: ScanNativeExtra = {},
): Promise<NativeScanResult | null> {
  const mod = tryLoad();
  if (!mod) return null;
  // AsyncTask runs the Rust work on a libuv worker thread so the extension
  // host's main thread stays free for VS Code UI events during the scan.
  return mod.scanProjectAsync({ rootDir, cachedHashes, ...extra });
}

export function detectProjectsNative(workspaceRoots: string[]): NativeDetectResult | null {
  const mod = tryLoad();
  if (!mod) return null;
  return mod.detectProjects(workspaceRoots);
}

export async function detectProjectsNativeAsync(
  workspaceRoots: string[],
): Promise<NativeDetectResult | null> {
  const mod = tryLoad();
  if (!mod) return null;
  return mod.detectProjectsAsync(workspaceRoots);
}

export function parseFileNative(text: string): NativeFileParsed | null {
  const mod = tryLoad();
  if (!mod) return null;
  return mod.parseFile(text);
}

export function hashTextNative(text: string): string | null {
  const mod = tryLoad();
  if (!mod) return null;
  return mod.hashText(text);
}
