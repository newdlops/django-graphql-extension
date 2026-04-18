// Minimal vscode API mock for vitest unit tests.
// Only implements the surface actually touched during parser/provider unit tests.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];
  event = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  start!: Position;
  end!: Position;
}

export class CodeLens {
  constructor(public range: Range, public command?: { title: string; command: string; tooltip?: string; arguments?: unknown[] }) {}
}

export class MarkdownString {
  value: string;
  isTrusted = false;
  constructor(value: string = '') { this.value = value; }
  appendMarkdown(v: string) { this.value += v; return this; }
}

export class Hover {
  constructor(public contents: MarkdownString | MarkdownString[], public range?: Range) {}
}

export const InlayHintKind = { Type: 1, Parameter: 2 } as const;

export class InlayHintLabelPart {
  tooltip?: string | MarkdownString;
  location?: Location;
  constructor(public value: string) {}
}

export class InlayHint {
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: string | MarkdownString;
  constructor(
    public position: Position,
    public label: string | InlayHintLabelPart[],
    public kind?: number,
  ) {}
}

export class Location {
  constructor(public uri: Uri, public range: Position | Range) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;

let __nextDecorationTypeId = 1;
const __decorations = new Map<number, { options: unknown; lastRanges: unknown[] }>();
export function __getDecorationRanges(typeId: number): unknown[] {
  return __decorations.get(typeId)?.lastRanges ?? [];
}
export function __listDecorationTypes(): Array<{ id: number; options: unknown; lastRanges: unknown[] }> {
  return [...__decorations.entries()].map(([id, v]) => ({ id, ...v }));
}

export interface TextEditorDecorationType { id: number; options: unknown; dispose: () => void }

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: number = DiagnosticSeverity.Error,
  ) {}
}

// Test-observable diagnostics collection.
const __diagnostics = new Map<string, Diagnostic[]>();
export function __getDiagnosticsFor(path: string): Diagnostic[] {
  return __diagnostics.get(path) ?? [];
}
export function __clearDiagnostics(): void { __diagnostics.clear(); }

export class Uri {
  constructor(public fsPath: string) {}
  static file(p: string): Uri { return new Uri(p); }
}

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

// Minimal TextDocument stand-in for tests that drive CodeLens/Hover providers.
export class TextDocument {
  constructor(public text: string, public fileName: string = '/test.ts') {}
  getText(): string { return this.text; }
  offsetAt(pos: Position): number {
    const parts = this.text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line && i < parts.length; i++) off += parts[i].length + 1;
    return off + pos.character;
  }
  positionAt(offset: number): Position {
    let line = 0, col = 0;
    const n = Math.min(offset, this.text.length);
    for (let i = 0; i < n; i++) {
      if (this.text[i] === '\n') { line++; col = 0; } else col++;
    }
    return new Position(line, col);
  }
}

export class TextEditor {
  constructor(public document: TextDocument) {}
  setDecorations(decorationType: TextEditorDecorationType, rangesOrOptions: unknown[]): void {
    const entry = __decorations.get(decorationType.id);
    if (entry) entry.lastRanges = rangesOrOptions;
  }
}

// In-memory virtual filesystem for tests.
// Tests populate this via __setMockFiles() before calling into the scanner.
let __mockFiles: Map<string, string> = new Map();

export function __setMockFiles(files: Record<string, string>): void {
  __mockFiles = new Map(Object.entries(files));
}

export function __clearMockFiles(): void {
  __mockFiles.clear();
}

export const workspace = {
  findFiles: async (_include: unknown, _exclude?: unknown) => {
    return [...__mockFiles.keys()].map((p) => Uri.file(p));
  },
  fs: {
    readFile: async (uri: Uri): Promise<Uint8Array> => {
      const content = __mockFiles.get(uri.fsPath) ?? '';
      return new Uint8Array(Buffer.from(content, 'utf-8'));
    },
  },
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeTextDocument: (_l: unknown) => ({ dispose: () => {} }),
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    has: (_k: string) => false,
    inspect: (_k: string) => undefined,
    update: () => Promise.resolve(),
  }),
};

// Test-observable log sink. Every appendLine call is captured; tests can
// inspect/clear via the __ helpers below.
const __mockLog: string[] = [];
export function __getMockLog(): string[] { return [...__mockLog]; }
export function __clearMockLog(): void { __mockLog.length = 0; }

// Track webview panels so tests can observe posted messages and trigger
// inbound ones via .simulateMessage(...).
export class FakeWebviewPanel {
  title: string;
  webview: {
    html: string;
    postedMessages: unknown[];
    postMessage: (m: unknown) => Promise<boolean>;
    onDidReceiveMessage: (listener: (m: unknown) => void) => { dispose: () => void };
    _messageListeners: Array<(m: unknown) => void>;
  };
  private disposed = false;
  private disposeListeners: Array<() => void> = [];

  constructor(_viewType: string, title: string) {
    this.title = title;
    const postedMessages: unknown[] = [];
    const messageListeners: Array<(m: unknown) => void> = [];
    this.webview = {
      html: '',
      postedMessages,
      postMessage: async (m: unknown) => { postedMessages.push(m); return true; },
      onDidReceiveMessage: (listener: (m: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: () => {} };
      },
      _messageListeners: messageListeners,
    };
  }

  reveal(_column?: number, _preserveFocus?: boolean): void {}

  onDidDispose(listener: () => void): { dispose: () => void } {
    this.disposeListeners.push(listener);
    return { dispose: () => {} };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const l of this.disposeListeners) l();
  }

  /** Test helper: simulate the webview sending a message back to the extension. */
  simulateMessage(msg: unknown): void {
    for (const l of this.webview._messageListeners) l(msg);
  }
}

const __panels: FakeWebviewPanel[] = [];
export function __getLastPanel(): FakeWebviewPanel | undefined { return __panels[__panels.length - 1]; }
export function __clearPanels(): void { __panels.length = 0; }

// Test-settable quick pick behavior: next pick to return, and observed calls.
interface MockQuickPickCall { items: unknown[]; options: unknown }
let __nextQuickPickPick: unknown = undefined;
const __quickPickCalls: MockQuickPickCall[] = [];
export function __setNextQuickPickSelection(v: unknown): void { __nextQuickPickPick = v; }
export function __getQuickPickCalls(): MockQuickPickCall[] { return [...__quickPickCalls]; }
export function __clearQuickPickState(): void { __nextQuickPickPick = undefined; __quickPickCalls.length = 0; }

let __lastInfoMessage: string | undefined;
export function __getLastInfoMessage(): string | undefined { return __lastInfoMessage; }
export function __clearInfoMessage(): void { __lastInfoMessage = undefined; }

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (s: string) => { __mockLog.push(s); },
    append: (s: string) => { __mockLog.push(s); },
    dispose: () => {},
    show: () => {},
  }),
  showTextDocument: () => Promise.resolve(undefined),
  createWebviewPanel: (viewType: string, title: string, _showOptions?: unknown, _options?: unknown) => {
    const panel = new FakeWebviewPanel(viewType, title);
    __panels.push(panel);
    return panel;
  },
  showQuickPick: async (items: unknown, options?: unknown) => {
    const resolvedItems = Array.isArray(items) ? items : await items;
    __quickPickCalls.push({ items: resolvedItems, options });
    const pick = __nextQuickPickPick;
    __nextQuickPickPick = undefined;
    return pick;
  },
  showInformationMessage: (message: string) => {
    __lastInfoMessage = message;
    return Promise.resolve(undefined);
  },
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: (_listener: unknown) => ({ dispose: () => {} }),
  createTextEditorDecorationType: (options: unknown): TextEditorDecorationType => {
    const id = __nextDecorationTypeId++;
    __decorations.set(id, { options, lastRanges: [] });
    return {
      id,
      options,
      dispose: () => __decorations.delete(id),
    };
  },
};

export const languages = {
  registerCodeLensProvider: () => ({ dispose: () => {} }),
  registerHoverProvider: () => ({ dispose: () => {} }),
  registerInlayHintsProvider: () => ({ dispose: () => {} }),
  createDiagnosticCollection: (_name?: string) => ({
    set: (uri: Uri, diags: Diagnostic[]) => { __diagnostics.set(uri.fsPath, diags); },
    delete: (uri: Uri) => { __diagnostics.delete(uri.fsPath); },
    clear: () => { __diagnostics.clear(); },
    dispose: () => {},
  }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(undefined),
};

export const ViewColumn = { Beside: 2, One: 1 } as const;

export default {
  EventEmitter, Position, Range, CodeLens, MarkdownString, Hover, Uri,
  RelativePattern, workspace, window, languages, commands, ViewColumn,
};
