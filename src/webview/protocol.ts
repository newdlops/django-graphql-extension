/**
 * Narrow runtime guards for messages crossing the extension/Webview boundary.
 * Webview scripts are not a trusted TypeScript boundary at runtime, so hosts
 * must validate the small action surface before reading message fields.
 */
export type ExplorerToHostMessage =
  | { type: 'ready'; surface: 'explorer' | 'inspector' }
  | { type: 'search'; query: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean }
  | { type: 'sort'; mode: 'none' | 'asc' | 'desc' }
  | { type: 'open'; file: string; line?: number }
  | { type: 'refresh' }
  | { type: 'preview'; classId?: string; className?: string }
  | { type: 'navigate'; classId?: string; className?: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isOptionalLine(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

export function isExplorerToHostMessage(value: unknown): value is ExplorerToHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'ready':
      return value.surface === 'explorer' || value.surface === 'inspector';
    case 'search':
      return typeof value.query === 'string' && value.query.length <= 512 &&
        typeof value.caseSensitive === 'boolean' && typeof value.wholeWord === 'boolean' && typeof value.useRegex === 'boolean';
    case 'sort':
      return value.mode === 'none' || value.mode === 'asc' || value.mode === 'desc';
    case 'open':
      return typeof value.file === 'string' && value.file.length > 0 && isOptionalLine(value.line);
    case 'refresh':
      return true;
    case 'preview':
    case 'navigate':
      return typeof value.classId === 'string' || typeof value.className === 'string';
    default:
      return false;
  }
}

export interface LazyExpandMessage {
  type: 'expandType';
  requestId?: string;
  nodeId: string;
  typeName: string;
  ancestry: string[];
  depth?: number;
}

export type SurfaceStatus =
  | { kind: 'loading'; message: string; hasStaleData: boolean }
  | { kind: 'ready'; message?: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string; retryable: boolean }
  | { kind: 'stale'; message: string };

export function isLazyExpandMessage(value: unknown): value is LazyExpandMessage {
  if (!isRecord(value) || value.type !== 'expandType') return false;
  return typeof value.nodeId === 'string' && value.nodeId.length > 0 && typeof value.typeName === 'string' && value.typeName.length > 0 &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    Array.isArray(value.ancestry) && value.ancestry.every((item) => typeof item === 'string') &&
    (value.depth === undefined || (typeof value.depth === 'number' && Number.isInteger(value.depth) && value.depth >= 0));
}
