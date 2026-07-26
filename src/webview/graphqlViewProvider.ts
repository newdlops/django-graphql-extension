import * as vscode from 'vscode';
import * as path from 'path';
import { SchemaInfo, ClassInfo } from '../types';
import { buildInspectorData } from '../preview/inspector';
import { buildReverseIndex } from '../scanner/reverseIndex';
import { computeQueryCoverage, CoverageMap } from '../analysis/gqlCoverage';
import { FrontendGqlFileUsage } from '../analysis/frontendGqlUsage';
import { FragmentDef } from '../codelens/gqlCodeLensProvider';
import { isExplorerToHostMessage, SurfaceStatus } from './protocol';

interface TreeNode {
  label: string;
  desc?: string;
  kind: 'schema' | 'category' | 'class' | 'field' | 'folder' | 'file' | 'operation';
  icon: string;
  file?: string;
  line?: number;
  classId?: string;
  children?: TreeNode[];
}

interface TreeSection {
  id: 'backend' | 'frontend';
  label: string;
  desc: string;
  emptyMessage: string;
  openByDefault: boolean;
  children: TreeNode[];
}

interface SearchFilter {
  key: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  queryLower: string;
  pattern?: RegExp;
}

interface CachedSearchText {
  raw: string;
  lower: string;
}

type SortMode = 'none' | 'asc' | 'desc';

function classIdFor(cls: ClassInfo): string {
  return `${cls.filePath}:${cls.lineNumber}:${cls.kind}:${cls.name}`;
}

function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWebviewNonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

export class GraphqlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'djangoGraphqlExplorer.view';

  constructor(private readonly extensionUri?: vscode.Uri) {}

  private view?: vscode.WebviewView;
  private schemas: SchemaInfo[] = [];
  private classContexts = new Map<string, { cls: ClassInfo; schemaClassMap: Map<string, ClassInfo> }>();
  private classIdsByName = new Map<string, string[]>();
  private classMap = new Map<string, ClassInfo>();
  private coverage: CoverageMap = new Map();
  private frontendUsages: FrontendGqlFileUsage[] = [];
  private searchFilter: SearchFilter | null = null;
  private sortMode: SortMode = 'none';
  private unfilteredSectionsCache = new Map<SortMode, TreeSection[]>();
  private classSearchText = new WeakMap<ClassInfo, CachedSearchText>();
  private relativePathCache = new Map<string, string>();
  private searchError: string | undefined;
  private explorerReady = false;
  private inspectorReady = false;
  private pendingInspectorPayload: (ReturnType<typeof buildInspectorData> & { hasActiveCoverage?: boolean }) | undefined;
  private explorerStatus: SurfaceStatus = { kind: 'loading', message: 'Scanning workspace…', hasStaleData: false };

  hasSchemas(): boolean {
    return this.schemas.length > 0;
  }

  setExplorerStatus(status: SurfaceStatus): void {
    this.explorerStatus = status;
    if (this.view && this.explorerReady) this.view.webview.postMessage({ type: 'status', status });
  }

  /**
   * List of class names the inspector can jump to (fed into the quick pick).
   * Each entry carries enough metadata for a useful QuickPickItem detail row.
   */
  listInspectableClasses(): Array<{ classId: string; name: string; kind: ClassInfo['kind']; filePath: string; fieldCount: number }> {
    return [...this.classContexts.entries()].map(([classId, { cls: c }]) => ({
      classId,
      name: c.name,
      kind: c.kind,
      filePath: c.filePath,
      fieldCount: c.fields.filter((f) => !(f.name.startsWith('__') && f.name.endsWith('__'))).length,
    }));
  }

  /** Public entry point for extension commands to open the inspector for a specific class. */
  showInspectorForClass(classTarget: string): void {
    this.showPreview(classTarget);
  }

  /**
   * Feed the set of active gql template bodies from the focused editor. The
   * Inspector uses this to mark which fields the user is currently querying.
   * `documentFragments` lets coverage include fields pulled in via
   * cross-literal `...FragmentName` spreads.
   */
  setActiveGqlBodies(bodies: string[], documentFragments?: Map<string, FragmentDef>): void {
    const schemaRoots: ClassInfo[] = [];
    for (const s of this.schemas) schemaRoots.push(...s.queries, ...s.mutations, ...s.subscriptions);
    this.coverage = computeQueryCoverage(bodies, {
      classMap: this.classMap,
      schemaRoots,
      documentFragments,
    });
    if (this.previewPanel && this.currentInspectorClassId) {
      this.renderInspector(this.currentInspectorClassId);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.extensionUri ? [this.extensionUri] : undefined,
    };
    this.explorerReady = false;
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendTree();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!isExplorerToHostMessage(msg)) return;
      if (msg.type === 'ready' && msg.surface === 'explorer') {
        this.explorerReady = true;
        this.sendTree();
      } else if (msg.type === 'search') {
        this.applyFilter(msg);
      } else if (msg.type === 'open' && msg.file) {
        const uri = vscode.Uri.file(msg.file!);
        const line = msg.line ?? 0;
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(line, 0, line, 0),
        });
      } else if (msg.type === 'refresh') {
        void vscode.commands.executeCommand('djangoGraphqlExplorer.refresh');
      } else if (msg.type === 'preview' && (msg.classId || msg.className)) {
        this.showPreview(msg.classId ?? msg.className ?? '');
      } else if (msg.type === 'sort') {
        if (msg.mode !== this.sortMode) {
          this.sortMode = msg.mode;
          this.sendTree();
        }
      }
    });
  }

  updateSchemas(schemas: SchemaInfo[], frontendUsages: FrontendGqlFileUsage[] = this.frontendUsages): void {
    this.schemas = schemas;
    this.frontendUsages = frontendUsages;
    this.classContexts.clear();
    this.classIdsByName.clear();
    this.classMap.clear();
    this.clearTreeCaches();
    this.explorerStatus = schemas.length === 0
      ? { kind: 'empty', message: 'No Django GraphQL schema was found in this workspace.' }
      : { kind: 'ready' };
    for (const schema of schemas) {
      const schemaClassMap = new Map<string, ClassInfo>();
      const classes = [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types];
      for (const cls of classes) {
        schemaClassMap.set(cls.name, cls);
      }
      for (const cls of classes) {
        const classId = classIdFor(cls);
        this.classContexts.set(classId, { cls, schemaClassMap });
        const ids = this.classIdsByName.get(cls.name);
        if (ids) ids.push(classId);
        else this.classIdsByName.set(cls.name, [classId]);
        this.classMap.set(cls.name, cls);
      }
    }
    this.sendTree();
    // If the inspector panel is open, refresh it in place so it doesn't go stale.
    if (this.previewPanel && this.currentInspectorClassId) {
      this.renderInspector(this.currentInspectorClassId);
    }
  }

  private applyFilter(msg: { query: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean }): void {
    let nextFilter: SearchFilter | null;
    try {
      nextFilter = this.createSearchFilter(msg);
      this.searchError = undefined;
    } catch (error) {
      this.searchError = error instanceof Error ? `Invalid regular expression: ${error.message}` : 'Invalid regular expression.';
      this.sendTree();
      return;
    }
    if (this.searchFilter?.key === nextFilter?.key) {
      return;
    }
    this.searchFilter = nextFilter;
    this.sendTree();
  }

  private filterAndSortClasses(classes: ClassInfo[]): ClassInfo[] {
    const result = this.searchFilter
      ? classes.filter((cls) => this.matchesClass(cls))
      : [...classes];
    if (this.sortMode === 'asc') {
      result.sort((a, b) => a.name.localeCompare(b.name));
    } else if (this.sortMode === 'desc') {
      result.sort((a, b) => b.name.localeCompare(a.name));
    }
    return result;
  }

  private buildBackendTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    const searchMode = !!this.searchFilter;
    for (const schema of this.schemas) {
      const schemaClassMap = new Map<string, ClassInfo>();
      for (const cls of [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types]) {
        schemaClassMap.set(cls.name, cls);
      }
      const categories: TreeNode[] = [];
      const fq = this.filterAndSortClasses(schema.queries);
      if (fq.length > 0) categories.push({ label: 'Queries', desc: `${fq.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fq, schemaClassMap, searchMode) });
      const fm = this.filterAndSortClasses(schema.mutations);
      if (fm.length > 0) categories.push({ label: 'Mutations', desc: `${fm.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fm, schemaClassMap, searchMode) });
      const fs = this.filterAndSortClasses(schema.subscriptions);
      if (fs.length > 0) categories.push({ label: 'Subscriptions', desc: `${fs.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fs, schemaClassMap, searchMode) });
      const ft = this.filterAndSortClasses(schema.types);
      if (ft.length > 0) categories.push({ label: 'Types', desc: `${ft.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(ft, schemaClassMap, searchMode) });

      if (this.searchFilter && categories.length === 0) continue;
      roots.push({ label: schema.name, kind: 'schema', icon: 'symbol-package', file: schema.filePath, children: categories });
    }
    return roots;
  }

  private buildFrontendTree(): TreeNode[] {
    const usages = [...this.frontendUsages];
    if (this.sortMode === 'asc') {
      usages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    } else if (this.sortMode === 'desc') {
      usages.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
    }

    const roots = this.searchFilter
      ? this.buildFilteredFrontendPathTree(usages)
      : this.buildFrontendPathTree(usages);
    this.decorateFrontendFolderCounts(roots);
    return roots;
  }

  private buildFrontendPathTree(usages: FrontendGqlFileUsage[]): TreeNode[] {
    const roots: TreeNode[] = [];
    const nodeIndexes = new WeakMap<TreeNode[], Map<string, TreeNode>>();
    for (const usage of usages) {
      const segments = usage.relativePath.split('/').filter(Boolean);
      if (segments.length === 0) continue;

      let cursor = roots;
      for (const segment of segments.slice(0, -1)) {
        const folder = this.findOrCreatePathNode(nodeIndexes, cursor, `folder:${segment}`, () => ({
          label: segment,
          kind: 'folder',
          icon: 'folder',
          children: [],
        }));
        if (!folder.children) folder.children = [];
        cursor = folder.children;
      }

      const fileLabel = segments[segments.length - 1];
      const operationNodes: TreeNode[] = usage.operations.map((operation) => ({
        label: operation.label,
        desc: operation.rootFields.length > 0 ? operation.rootFields.join(', ') : undefined,
        kind: 'operation',
        icon: 'symbol-event',
        file: usage.filePath,
        line: operation.lineNumber,
      }));

      cursor.push({
        label: fileLabel,
        desc: usage.operationCount === 1 ? usage.operations[0].label : `${usage.operationCount} gql blocks`,
        kind: 'file',
        icon: 'file-code',
        file: usage.filePath,
        line: usage.operations[0]?.lineNumber ?? 0,
        children: operationNodes.length > 0 ? operationNodes : undefined,
      });
    }

    return roots;
  }

  private buildFilteredFrontendPathTree(usages: FrontendGqlFileUsage[]): TreeNode[] {
    const roots: TreeNode[] = [];
    const nodeIndexes = new WeakMap<TreeNode[], Map<string, TreeNode>>();
    for (const usage of usages) {
      const segments = usage.relativePath.split('/').filter(Boolean);
      if (segments.length === 0) continue;

      const pathMatches = segments.some((segment) => this.matchesValue(segment)) || this.matchesValue(usage.relativePath);
      const operations = pathMatches
        ? usage.operations
        : usage.operations.filter((operation) =>
          this.matchesValue(operation.label) || this.matchesValue(operation.rootFields.join(', ')),
        );
      if (!pathMatches && operations.length === 0) continue;

      let cursor = roots;
      for (const segment of segments.slice(0, -1)) {
        const folder = this.findOrCreatePathNode(nodeIndexes, cursor, `folder:${segment}`, () => ({
          label: segment,
          kind: 'folder',
          icon: 'folder',
          children: [],
        }));
        if (!folder.children) folder.children = [];
        cursor = folder.children;
      }

      const fileLabel = segments[segments.length - 1];
      const operationNodes: TreeNode[] = operations.map((operation) => ({
        label: operation.label,
        desc: operation.rootFields.length > 0 ? operation.rootFields.join(', ') : undefined,
        kind: 'operation',
        icon: 'symbol-event',
        file: usage.filePath,
        line: operation.lineNumber,
      }));

      cursor.push({
        label: fileLabel,
        desc: usage.operationCount === 1 ? usage.operations[0].label : `${usage.operationCount} gql blocks`,
        kind: 'file',
        icon: 'file-code',
        file: usage.filePath,
        line: usage.operations[0]?.lineNumber ?? 0,
        children: operationNodes.length > 0 ? operationNodes : undefined,
      });
    }

    return roots;
  }

  private buildSections(): TreeSection[] {
    if (!this.searchFilter) {
      const cached = this.unfilteredSectionsCache.get(this.sortMode);
      if (cached) return cached;
    }

    const backendTree = this.buildBackendTree();
    const frontendTree = this.buildFrontendTree();
    const backendCount = this.countNodesByIcon(backendTree, 'symbol-class');
    const frontendCount = this.countNodesByIcon(frontendTree, 'file-code');

    const sections: TreeSection[] = [
      {
        id: 'backend',
        label: 'Backend',
        desc: `${backendCount} ${backendCount === 1 ? 'class' : 'classes'}`,
        emptyMessage: this.searchFilter
          ? 'No backend schema items matched the current filter.'
          : 'No backend schemas loaded yet.',
        openByDefault: true,
        children: backendTree,
      },
      {
        id: 'frontend',
        label: 'Frontend',
        desc: `${frontendCount} ${frontendCount === 1 ? 'file' : 'files'}`,
        emptyMessage: this.searchFilter
          ? 'No frontend gql files matched the current filter.'
          : 'No frontend gql templates found.',
        openByDefault: true,
        children: frontendTree,
      },
    ];
    if (!this.searchFilter) {
      this.unfilteredSectionsCache.set(this.sortMode, sections);
    }
    return sections;
  }

  private buildClassNode(cls: ClassInfo, schemaClassMap: Map<string, ClassInfo>, searchMode = false): TreeNode {
    const visibleFields = searchMode ? cls.fields.filter((field) => this.matchesValue(field.name)) : cls.fields;
    const children: TreeNode[] = visibleFields.map((f) => {
      const resolvedClass = f.resolvedType ? schemaClassMap.get(f.resolvedType) : undefined;
      const resolvedChildren = !searchMode && resolvedClass ? this.buildResolvedChildren(resolvedClass) : undefined;
      return {
        label: f.name,
        desc: f.fieldType + (f.resolvedType ? ` → ${f.resolvedType}` : ''),
        kind: 'field',
        icon: 'symbol-field',
        file: f.filePath || cls.filePath,
        line: f.lineNumber,
        children: resolvedChildren,
      };
    });
    return {
      label: cls.name,
      desc: `${cls.fields.length}`,
      kind: 'class',
      icon: 'symbol-class',
      file: cls.filePath,
      line: cls.lineNumber,
      classId: classIdFor(cls),
      children: children.length > 0 ? children : undefined,
    };
  }

  private buildClassPathTree(classes: ClassInfo[], schemaClassMap: Map<string, ClassInfo>, searchMode = false): TreeNode[] {
    const roots: TreeNode[] = [];
    const nodeIndexes = new WeakMap<TreeNode[], Map<string, TreeNode>>();
    for (const cls of classes) {
      const classNode = this.buildClassNode(cls, schemaClassMap, searchMode);
      const relativeFilePath = this.relativeFilePath(cls.filePath);
      const segments = relativeFilePath.split(/[\\/]/).filter(Boolean);
      if (segments.length === 0) {
        roots.push(classNode);
        continue;
      }

      let cursor = roots;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const isFile = i === segments.length - 1;
        const kind = isFile ? 'file' : 'folder';
        const node = this.findOrCreatePathNode(nodeIndexes, cursor, `${kind}:${segment}`, () => ({
          label: segment,
          kind,
          icon: isFile ? 'file-code' : 'folder',
          file: isFile ? cls.filePath : undefined,
          line: isFile ? cls.lineNumber : undefined,
          children: [],
        }));
        if (!node.children) node.children = [];
        if (isFile) {
          node.children.push(classNode);
        } else {
          cursor = node.children;
        }
      }
    }
    return roots;
  }

  private relativeFilePath(filePath: string): string {
    if (!filePath) return '';
    const cached = this.relativePathCache.get(filePath);
    if (cached !== undefined) return cached;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!folder) {
      this.relativePathCache.set(filePath, filePath);
      return filePath;
    }
    const relative = path.relative(folder.uri.fsPath, filePath);
    const out = relative || path.basename(filePath);
    this.relativePathCache.set(filePath, out);
    return out;
  }

  private buildResolvedChildren(cls: ClassInfo): TreeNode[] | undefined {
    if (cls.fields.length === 0) return undefined;
    return cls.fields.map((f) => ({
      label: f.name,
      desc: f.fieldType,
      kind: 'field',
      icon: 'symbol-field',
      file: f.filePath || cls.filePath,
      line: f.lineNumber,
    }));
  }

  private decorateFrontendFolderCounts(nodes: TreeNode[]): number {
    let fileCount = 0;
    for (const node of nodes) {
      if (node.icon === 'folder') {
        const childCount = this.decorateFrontendFolderCounts(node.children ?? []);
        node.desc = `${childCount} ${childCount === 1 ? 'file' : 'files'}`;
        fileCount += childCount;
      } else if (node.icon === 'file-code') {
        fileCount++;
      }
    }
    return fileCount;
  }

  private findOrCreatePathNode(
    nodeIndexes: WeakMap<TreeNode[], Map<string, TreeNode>>,
    cursor: TreeNode[],
    key: string,
    create: () => TreeNode,
  ): TreeNode {
    let index = nodeIndexes.get(cursor);
    if (!index) {
      index = new Map();
      for (const node of cursor) index.set(`${node.kind}:${node.label}`, node);
      nodeIndexes.set(cursor, index);
    }

    let node = index.get(key);
    if (!node) {
      node = create();
      cursor.push(node);
      index.set(key, node);
    }
    return node;
  }

  private createSearchFilter(msg: { query: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean }): SearchFilter | null {
    const query = msg.query.trim();
    if (!query) return null;

    const flags = msg.caseSensitive ? '' : 'i';
    let pattern: RegExp | undefined;
    if (msg.useRegex || msg.wholeWord) {
      const literalSource = escapeRegex(query);
      let source = msg.useRegex ? query : literalSource;
      if (msg.wholeWord) source = `\\b${source}\\b`;
      pattern = new RegExp(source, flags);
    }

    return {
      key: [query, msg.caseSensitive ? '1' : '0', msg.wholeWord ? '1' : '0', msg.useRegex ? '1' : '0'].join('\u0000'),
      query,
      caseSensitive: msg.caseSensitive,
      wholeWord: msg.wholeWord,
      useRegex: msg.useRegex,
      queryLower: query.toLowerCase(),
      pattern,
    };
  }

  private matchesClass(cls: ClassInfo): boolean {
    const filter = this.searchFilter;
    if (!filter) return true;
    if (filter.pattern) {
      return this.matchesValue(cls.name) || cls.fields.some((field) => this.matchesValue(field.name));
    }

    const cached = this.getClassSearchText(cls);
    const haystack = filter.caseSensitive ? cached.raw : cached.lower;
    const needle = filter.caseSensitive ? filter.query : filter.queryLower;
    return haystack.includes(needle);
  }

  private matchesValue(value?: string): boolean {
    const filter = this.searchFilter;
    if (!value || !filter) return false;
    if (filter.pattern) {
      filter.pattern.lastIndex = 0;
      return filter.pattern.test(value);
    }
    const haystack = filter.caseSensitive ? value : value.toLowerCase();
    const needle = filter.caseSensitive ? filter.query : filter.queryLower;
    return haystack.includes(needle);
  }

  private getClassSearchText(cls: ClassInfo): CachedSearchText {
    const cached = this.classSearchText.get(cls);
    if (cached) return cached;
    const raw = [cls.name, ...cls.fields.map((field) => field.name)].join('\n');
    const next = { raw, lower: raw.toLowerCase() };
    this.classSearchText.set(cls, next);
    return next;
  }

  private clearTreeCaches(): void {
    this.unfilteredSectionsCache.clear();
    this.classSearchText = new WeakMap();
    this.relativePathCache.clear();
  }

  private countNodesByIcon(nodes: TreeNode[], icon: string): number {
    let total = 0;
    for (const node of nodes) {
      if (node.icon === icon) total++;
      if (node.children) total += this.countNodesByIcon(node.children, icon);
    }
    return total;
  }

  private previewPanel?: vscode.WebviewPanel;
  private currentInspectorClassId?: string;

  private resolveClassId(classTarget: string): string | undefined {
    if (this.classContexts.has(classTarget)) return classTarget;
    const ids = this.classIdsByName.get(classTarget);
    return ids?.[0];
  }

  private showPreview(classTarget: string): void {
    const classId = this.resolveClassId(classTarget);
    const ctx = classId ? this.classContexts.get(classId) : undefined;
    if (!classId || !ctx) return;

    if (!this.previewPanel) {
      this.previewPanel = vscode.window.createWebviewPanel(
        'graphqlPreview',
        ctx.cls.name,
        { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: this.extensionUri ? [this.extensionUri] : undefined,
        },
      );
      this.inspectorReady = false;
      this.previewPanel.webview.html = this.getInspectorShellHtml(this.previewPanel.webview);
      this.previewPanel.webview.onDidReceiveMessage((msg) => {
        if (!isExplorerToHostMessage(msg)) return;
        if (msg.type === 'ready' && msg.surface === 'inspector') {
          this.inspectorReady = true;
          if (this.pendingInspectorPayload) {
            this.previewPanel?.webview.postMessage({ type: 'inspector', data: this.pendingInspectorPayload });
          }
        } else if (msg.type === 'navigate' && (msg.classId || msg.className)) {
          this.renderInspector(msg.classId ?? msg.className ?? '');
        } else if (msg.type === 'open' && msg.file) {
          const uri = vscode.Uri.file(msg.file!);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
          });
        }
      });
      this.previewPanel.onDidDispose(() => {
        this.previewPanel = undefined;
        this.currentInspectorClassId = undefined;
        this.inspectorReady = false;
        this.pendingInspectorPayload = undefined;
      });
    }

    this.renderInspector(classId);
    this.previewPanel.reveal(vscode.ViewColumn.One, true);
  }

  private renderInspector(classTarget: string): void {
    if (!this.previewPanel) return;
    const classId = this.resolveClassId(classTarget);
    const ctx = classId ? this.classContexts.get(classId) : undefined;
    if (!classId || !ctx) return;
    const coverageForClass = this.coverage.get(ctx.cls.name) ?? new Set<string>();
    const reverseIndex = buildReverseIndex(ctx.schemaClassMap);
    const basePayload = buildInspectorData(
      ctx.cls.name,
      ctx.schemaClassMap,
      reverseIndex,
      coverageForClass,
      (candidate) => classIdFor(candidate),
    );
    if (!basePayload) return;
    const payload = { ...basePayload, hasActiveCoverage: this.coverage.size > 0 };
    this.currentInspectorClassId = classId;
    this.previewPanel.title = ctx.cls.name;
    this.pendingInspectorPayload = payload;
    if (this.inspectorReady) {
      this.previewPanel.webview.postMessage({ type: 'inspector', data: payload });
    }
  }

  private codiconStyleUri(webview?: vscode.Webview): string {
    if (!webview || !this.extensionUri) return '';
    return webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css')).toString();
  }

 private getInspectorShellHtml(webview?: vscode.Webview): string {
    const nonce = createWebviewNonce();
    const cspSource = webview?.cspSource ?? "'none'";
    const codiconStyleUri = this.codiconStyleUri(webview);
   return /*html*/ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Type Inspector</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';">${codiconStyleUri ? `<link nonce="${nonce}" rel="stylesheet" href="${codiconStyleUri}">` : ''}<style nonce="${nonce}">
* { box-sizing: border-box; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  margin: 0; padding: 0;
}
.header {
  padding: 12px 20px 6px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
}
.header .title { display: inline; margin: 0; font-size: 1.4em; font-weight: 600; }
.header .kind {
  display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 3px;
  font-size: 0.7em; text-transform: uppercase; vertical-align: middle;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.header .path {
  display: block; margin-top: 4px; padding: 0; border: 0; color: var(--vscode-textLink-foreground);
  cursor: pointer; font-family: var(--vscode-editor-font-family); font-size: 0.85em; background: transparent; text-align: left;
}
.header .path:hover { text-decoration: underline; }
.section { padding: 12px 20px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1)); }
.section h3 {
  margin: 0 0 8px; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground); font-weight: 600;
}
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-family: var(--vscode-editor-font-family); font-size: 0.9em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.chip.clickable { cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.chip.clickable:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chip.clickable:focus-visible, .path:focus-visible, .ref-item:focus-visible, .filter:focus-visible, .load-more:focus-visible, .sdl-action:focus-visible, .field-source:focus-visible, .base-more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.chip.unknown { opacity: 0.55; font-style: italic; }
.fields-table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
.fields-table th, .fields-table td { text-align: left; padding: 4px 8px; vertical-align: top; }
.fields-table th { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 0.85em; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); position: sticky; top: 0; background: var(--vscode-editor-background); }
.fields-table tr.inherited td .name::after { content: ' ↳'; color: var(--vscode-descriptionForeground); font-size: 0.75em; }
.fields-table tr.queried td .name::before {
  content: '✓ '; color: var(--vscode-testing-iconPassed, #4caf50); font-weight: bold;
}
.fields-table tr:not(.queried) td .name::before {
  content: '  '; white-space: pre;
}
.fields-table tr:hover { background: var(--vscode-list-hoverBackground); }
.coverage-pill {
  display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 10px;
  font-size: 0.7em; vertical-align: middle;
  background: var(--vscode-inputOption-activeBackground, rgba(0,90,180,0.25));
  color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
}
.coverage-pill.zero { background: var(--vscode-badge-background); opacity: 0.6; }
.fields-table .muted { color: var(--vscode-descriptionForeground); }
.fields-table .name { font-weight: 500; }
.field-source { appearance: none; border: 0; padding: 0; margin: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.field-source:hover { text-decoration: underline; }
.fields-table .name-snake { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.fields-table .arg-row { font-size: 0.85em; margin-top: 2px; color: var(--vscode-descriptionForeground); }
.fields-table .arg-row .chip { font-size: 0.85em; padding: 1px 6px; }
.ref-item {
  display: block; width: 100%; border: 0; text-align: left; padding: 3px 0; font-family: var(--vscode-editor-font-family); font-size: 0.9em; cursor: pointer; color: inherit; background: transparent;
}
.ref-item:hover { text-decoration: underline; }
.ref-item .via { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 6px; }
.references summary { cursor: pointer; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
.empty { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
details.sdl { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
details.sdl summary { cursor: pointer; padding: 4px 0; color: var(--vscode-descriptionForeground); }
details.sdl pre { margin: 6px 0 0; padding: 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08)); border-radius: 3px; overflow-x: auto; }
details.sdl pre.wrap { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; }
details.sdl .kw { color: #c586c0; } details.sdl .type { color: #4ec9b0; } details.sdl .comment { color: #6a9955; }
.field-tools { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.field-tools input { min-width: 10rem; flex: 1 1 12rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
.filter, .load-more, .sdl-action { border: 1px solid var(--vscode-button-secondaryBackground); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 3px 7px; cursor: pointer; }
.filter[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.field-count { color: var(--vscode-descriptionForeground); font-size: .9em; margin: 6px 0; }
.base-more { border: 0; padding: 2px 6px; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; }
@media (max-width: 520px) {
  .fields-table .origin-col { display: none; }
  .fields-table .origin-inline { display: inline; }
}
@media (min-width: 521px) { .fields-table .origin-inline { display: none; } }
</style></head><body>
<div id="root" aria-busy="true"><div class="empty" role="status" style="padding:20px">Loading type…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const savedInspectorState = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
let fieldLimit = Number.isInteger(savedInspectorState?.fieldLimit) ? Math.max(100, Math.min(savedInspectorState.fieldLimit, 1000)) : 100;
let lastInspectorData = null;
let fieldQuery = typeof savedInspectorState?.fieldQuery === 'string' ? savedInspectorState.fieldQuery.slice(0, 256) : '';
let fieldFilter = ['all', 'own', 'inherited', 'queried', 'unqueried'].includes(savedInspectorState?.fieldFilter) ? savedInspectorState.fieldFilter : 'all';
let baseClassesExpanded = !!savedInspectorState?.baseClassesExpanded;
let wrapSdl = !!savedInspectorState?.wrapSdl;

function persistInspectorState() {
  if (typeof vscode.setState !== 'function') return;
  vscode.setState({ fieldLimit, fieldQuery, fieldFilter, baseClassesExpanded, wrapSdl });
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderSdl(sdl) {
  return escapeHtml(sdl)
    .replace(/^(type|input|enum|interface|union|scalar|query|mutation|subscription)\\b/gm, '<span class="kw">$1</span>')
    .replace(/^(\\s*#.*)/gm, '<span class="comment">$1</span>')
    .replace(/:\\s*(\\[?)(\\w+)(]?!?)/g, ': $1<span class="type">$2</span>$3');
}

function typeChip(typeName, targetId) {
  if (!typeName) return '';
  if (targetId) return '<button type="button" class="chip clickable" data-nav="' + escapeHtml(targetId) + '" aria-label="Inspect type ' + escapeHtml(typeName) + '">' + escapeHtml(typeName) + '</button>';
  return '<span class="chip unknown">' + escapeHtml(typeName) + '</span>';
}

function argsFragment(args) {
  if (!args || args.length === 0) return '';
  const parts = args.map(a => {
    const req = a.required ? '!' : '';
    const chip = typeChip(a.type, a.typeId);
    return '<span class="muted">' + escapeHtml(a.name) + '</span>: ' + chip + req;
  });
  return '<div class="arg-row">args: ' + parts.join(', ') + '</div>';
}

function render(data) {
  lastInspectorData = data;
  if (!data.hasActiveCoverage && (fieldFilter === 'queried' || fieldFilter === 'unqueried')) fieldFilter = 'all';
  root.setAttribute('aria-busy', 'false');
  const kindBadge = '<span class="kind">' + escapeHtml(data.kind) + '</span>';
  const path = escapeHtml(data.filePath) + ':' + (data.lineNumber + 1);

  const visibleBaseClasses = baseClassesExpanded ? data.baseClasses : data.baseClasses.slice(0, 8);
  const baseChips = data.baseClasses.length === 0
    ? '<span class="empty">—</span>'
    : '<div class="chips">' + visibleBaseClasses.map(b =>
        typeChip(b, data.baseClassTargets[b])
      ).join('') + (data.baseClasses.length > 8 ? '<button type="button" class="base-more" data-toggle-base aria-expanded="' + String(baseClassesExpanded) + '">' + (baseClassesExpanded ? 'Show fewer' : 'Show ' + (data.baseClasses.length - 8) + ' more') + '</button>' : '') + '</div>';

  const coveragePill = data.totalCount === 0
    ? ''
    : '<span class="coverage-pill' + (data.queriedCount === 0 ? ' zero' : '') + '">' +
      '✓ ' + data.queriedCount + ' / ' + data.totalCount + ' queried</span>';

  const normalizedQuery = fieldQuery.trim().toLowerCase();
  const matchingFields = data.fields.filter((field) => {
    const matchesQuery = !normalizedQuery || [field.name, field.displayName, field.fieldType, field.resolvedType || ''].join(' ').toLowerCase().includes(normalizedQuery);
    const matchesFilter = fieldFilter === 'all' || (fieldFilter === 'own' && field.origin === 'own') || (fieldFilter === 'inherited' && field.origin === 'inherited') || (fieldFilter === 'queried' && field.queried) || (fieldFilter === 'unqueried' && !field.queried);
    return matchesQuery && matchesFilter;
  });
  const visibleFields = matchingFields.slice(0, fieldLimit);
  const availableFilters = data.hasActiveCoverage ? ['all', 'own', 'inherited', 'queried', 'unqueried'] : ['all', 'own', 'inherited'];
  const fieldTools = '<div class="field-tools"><label class="sr-only" for="field-search">Search fields</label><input id="field-search" name="field-search" autocomplete="off" type="search" value="' + escapeHtml(fieldQuery) + '" placeholder="Search fields" />' +
    availableFilters.map((filter) => '<button type="button" class="filter" data-filter="' + filter + '" aria-pressed="' + String(fieldFilter === filter) + '">' + ({ all: 'All', own: 'Own', inherited: 'Inherited', queried: 'Queried', unqueried: 'Not queried' })[filter] + '</button>').join('') + '</div>' +
    (data.hasActiveCoverage ? '' : '<div class="field-count">No active operation context</div>');
  const fieldRows = matchingFields.length === 0
    ? '<div class="empty">No fields match the current filters. <button type="button" class="base-more" data-clear-field-filters>Clear field filters</button></div>'
    : '<table class="fields-table"><caption class="sr-only">Fields for ' + escapeHtml(data.className) + '</caption><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th class="origin-col" scope="col">Origin</th></tr></thead><tbody>' +
      visibleFields.map(r => {
        const rowClasses = ['field-row'];
        if (r.origin === 'inherited') rowClasses.push('inherited');
        if (r.queried) rowClasses.push('queried');
        const resolved = r.resolvedType ? ' → ' + typeChip(r.resolvedType, r.resolvedTypeId) : '';
        return '<tr class="' + rowClasses.join(' ') + '">' +
          '<td><button type="button" class="field-source name" data-file="' + escapeHtml(r.filePath) + '" data-line="' + r.lineNumber + '" aria-label="Open source for ' + escapeHtml(r.displayName) + '">' + escapeHtml(r.displayName) + '</button>' +
          (r.name !== r.displayName ? ' <span class="name-snake">(' + escapeHtml(r.name) + ')</span>' : '') +
          '<span class="origin-inline muted"> · ' + escapeHtml(r.origin === 'inherited' ? 'Inherited' : 'Own') + '</span>' +
          '</td><td>' +
          '<span class="muted">' + escapeHtml(r.fieldType) + '</span>' + resolved +
          argsFragment(r.args) +
          '</td><td class="origin-col">' + escapeHtml(r.origin === 'inherited' ? 'Inherited' : 'Own') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="field-count">Showing ' + visibleFields.length + ' of ' + matchingFields.length + ' fields</div>' +
      (visibleFields.length < matchingFields.length ? '<button type="button" class="load-more" id="load-more">Show 100 more fields</button>' : '');

  const refItems = (refs, via) => refs.length === 0
    ? '<div class="empty">—</div>'
    : (() => {
      const items = refs.map(r =>
        (r.fromClassId ? '<button type="button" class="ref-item" data-nav="' + escapeHtml(r.fromClassId) + '" aria-label="Inspect type ' + escapeHtml(r.fromClass) + '">' : '<div class="ref-item">') +
        escapeHtml(r.fromClass) + '.<span class="muted">' + escapeHtml(r.fromField) + '</span>' +
        '<span class="via">(' + via + (r.label !== r.fromField ? ': ' + escapeHtml(r.label) : '') + ')</span>' +
        (r.fromClassId ? '</button>' : '</div>')
      ).join('');
      return refs.length > 20
        ? '<details class="references"><summary>Show all ' + refs.length + ' references</summary>' + items + '</details>'
        : items;
    })();

  root.innerHTML =
    '<div class="header"><div><h1 class="title">' + escapeHtml(data.className) + '</h1>' + kindBadge + '</div>' +
    '<button type="button" class="path" data-file="' + escapeHtml(data.filePath) + '" data-line="' + data.lineNumber + '" aria-label="Open source ' + path + '">' + path + '</button></div>' +

    '<div class="section"><h3>Base classes</h3>' + baseChips + '</div>' +

    '<div class="section"><h3>Fields (' + data.fields.length + ')' + coveragePill + '</h3>' + fieldTools + fieldRows + '</div>' +

    '<div class="section"><h3>Used as field type (' + data.usedAsFieldType.length + ')</h3>' + refItems(data.usedAsFieldType, 'field') + '</div>' +

    '<div class="section"><h3>Used as argument type (' + data.usedAsArgType.length + ')</h3>' + refItems(data.usedAsArgType, 'arg') + '</div>' +

    '<div class="section"><details class="sdl"><summary>GraphQL SDL preview</summary><div class="field-tools"><button type="button" class="sdl-action" data-copy-sdl>Copy SDL</button><button type="button" class="sdl-action" data-wrap-sdl aria-pressed="' + String(wrapSdl) + '">Wrap code</button><span class="field-count" data-sdl-feedback role="status"></span></div><pre class="' + (wrapSdl ? 'wrap' : '') + '"><code>' + renderSdl(data.sdl) + '</code></pre></details></div>';

  root.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'navigate', classId: el.getAttribute('data-nav') });
    });
  });
  root.querySelectorAll('[data-file]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: 'open',
        file: el.getAttribute('data-file'),
        line: parseInt(el.getAttribute('data-line') || '0', 10),
      });
    });
  });
  const loadMore = root.querySelector('#load-more');
  if (loadMore) loadMore.addEventListener('click', () => {
    fieldLimit += 100;
    persistInspectorState();
    render(lastInspectorData);
    root.querySelector('#load-more')?.focus();
  });
  const fieldSearch = root.querySelector('#field-search');
  if (fieldSearch) fieldSearch.addEventListener('input', () => {
    fieldQuery = fieldSearch.value;
    fieldLimit = 100;
    persistInspectorState();
    render(lastInspectorData);
  });
  root.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    fieldFilter = button.getAttribute('data-filter') || 'all';
    fieldLimit = 100;
    persistInspectorState();
    render(lastInspectorData);
  }));
  const baseMore = root.querySelector('[data-toggle-base]');
  if (baseMore) baseMore.addEventListener('click', () => {
    baseClassesExpanded = !baseClassesExpanded;
    persistInspectorState();
    render(lastInspectorData);
  });
  const clearFieldFilters = root.querySelector('[data-clear-field-filters]');
  if (clearFieldFilters) clearFieldFilters.addEventListener('click', () => {
    fieldQuery = '';
    fieldFilter = 'all';
    fieldLimit = 100;
    persistInspectorState();
    render(lastInspectorData);
    root.querySelector('#field-search')?.focus();
  });
  const copySdl = root.querySelector('[data-copy-sdl]');
  const sdlFeedback = root.querySelector('[data-sdl-feedback]');
  if (copySdl) copySdl.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastInspectorData.sdl);
      sdlFeedback.textContent = 'Copied';
    } catch {
      sdlFeedback.textContent = 'Could not copy SDL';
    }
  });
  const wrapButton = root.querySelector('[data-wrap-sdl]');
  if (wrapButton) wrapButton.addEventListener('click', () => {
    wrapSdl = !wrapSdl;
    persistInspectorState();
    render(lastInspectorData);
  });
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'inspector') {
    render(msg.data);
  }
});
vscode.postMessage({ type: 'ready', surface: 'inspector' });
</script>
</body></html>`;
  }

  private sendTree(): void {
    if (!this.view || !this.explorerReady) return;
    const sections = this.buildSections();
    this.view.webview.postMessage({ type: 'status', status: this.explorerStatus });
    this.view.webview.postMessage({
      type: 'tree',
      sections,
      hasFilter: !!this.searchFilter,
      sortMode: this.sortMode,
      filterError: this.searchError,
    });
  }

  private getHtml(webview?: vscode.Webview): string {
    const nonce = createWebviewNonce();
    const cspSource = webview?.cspSource ?? "'none'";
    const codiconStyleUri = this.codiconStyleUri(webview);
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><title>Schema Explorer</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';">${codiconStyleUri ? `<link nonce="${nonce}" rel="stylesheet" href="${codiconStyleUri}">` : ''}<style nonce="${nonce}">
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  overflow: auto;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; }
}

/* ── Search bar ── */
.search-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 4px 8px;
  background: var(--vscode-sideBar-background);
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
}
.search-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  border-radius: 2px;
  padding: 0 2px;
}
.search-row:focus-within {
  border-color: var(--vscode-focusBorder);
}
.search-row input {
  flex: 1 1 156px;
  min-width: 156px;
  border: none;
  padding: 3px 4px;
  font-family: inherit;
  font-size: inherit;
  color: var(--vscode-input-foreground);
  background: transparent;
}
.search-row select { flex: 0 0 106px; min-width: 106px; max-width: 100%; background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); }
@media (max-width: 480px) {
  .search-row input { flex: 1 0 100%; }
  .search-row select { flex: 1 1 100px; min-width: 100px; }
}
.search-row input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
.toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground);
  opacity: 0.5;
  background: transparent;
  flex-shrink: 0;
}
.toggle:hover { opacity: 0.85; background: var(--vscode-toolbar-hoverBackground); }
.toggle:focus-visible, .node:focus-visible, .accordion summary:focus-visible, select:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.sep { width: 1px; height: 14px; background: var(--vscode-widget-border, rgba(128,128,128,0.3)); margin: 0 2px; flex-shrink: 0; }
.toggle.active {
  opacity: 1;
  background: var(--vscode-inputOption-activeBackground, rgba(0,90,180,0.3));
  border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
}

/* ── Sections / accordion ── */
.sections { padding: 6px 0 12px; }
.accordion {
  margin: 0;
  border: 0;
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, rgba(128,128,128,0.2)));
  border-radius: 0;
  overflow: visible;
  background: var(--vscode-sideBar-background);
}
.accordion[open] {
  background: var(--vscode-sideBar-background);
}
.accordion summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 7px 10px;
  background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.06));
}
.accordion summary::-webkit-details-marker { display: none; }
.accordion summary:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.section-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.section-chevron {
  width: 10px;
  color: var(--vscode-descriptionForeground);
  transition: transform 120ms ease;
  transform-origin: 50% 50%;
}
.accordion[open] .section-chevron {
  transform: rotate(90deg);
}
.section-label {
  font-weight: 600;
}
.section-desc {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.section-body { padding: 4px 0 8px; overflow-x: hidden; }
.section-empty {
  padding: 10px 14px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* ── Tree ── */
.tree { display: block; min-width: 0; padding: 2px 0; }
.tree-empty {
  padding: 12px 20px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
.node {
  display: flex;
  align-items: center;
  height: 22px;
  min-width: 0;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}
.node:hover { background: var(--vscode-list-hoverBackground); }
.node .indent { flex-shrink: 0; }
.node .twistie {
  width: 16px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--vscode-foreground);
  opacity: 0.7;
}
.node .twistie.hidden { visibility: hidden; }
.node .icon {
  width: 16px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 4px;
}
.node .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.node .desc {
  min-width: 0;
  flex: 0 1 auto;
  margin-left: 6px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
mark.search-match {
  border-radius: 2px;
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.35));
  color: inherit;
  color: var(--vscode-editor-findMatchForeground, inherit);
}
.children { display: none; }
.children.open { display: block; }
.search-results { display: grid; gap: 1px; padding: 2px 0; }
.search-result { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 6px; width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 5px 10px; cursor: pointer; }
.search-result:hover, .search-result:focus-visible { background: var(--vscode-list-hoverBackground); }
.search-result:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.search-result .result-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-result .result-context { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: .85em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-more { margin: 6px 10px; width: calc(100% - 20px); }

.icon.codicon { font-size: 15px; color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground)); }
</style>
</head>
<body>
<div class="search-bar">
  <div class="search-row">
    <label class="sr-only" for="q">Search schema and operations</label>
    <input id="q" name="schema-search" autocomplete="off" type="text" aria-describedby="search-error" placeholder="Search schema and operations…" spellcheck="false" />
    <button class="toggle" id="clear-search" type="button" aria-label="Clear search" title="Clear search" hidden>×</button>
    <button class="toggle" id="case" type="button" aria-label="Match case" aria-pressed="false" title="Match case">Aa</button>
    <button class="toggle" id="word" type="button" aria-label="Match whole word" aria-pressed="false" title="Match whole word"><b>ab</b>|</button>
    <button class="toggle" id="regex" type="button" aria-label="Use regular expression" aria-pressed="false" title="Use regular expression">.*</button>
    <span class="sep"></span>
    <button class="toggle" id="expand" type="button" aria-label="Expand one level" title="Expand one level">▾</button>
    <button class="toggle" id="collapse" type="button" aria-label="Collapse all" title="Collapse all">▸</button>
    <select id="sort" aria-label="Sort results" title="Sort results"><option value="none">Source order</option><option value="asc">Name: A–Z</option><option value="desc">Name: Z–A</option></select>
  </div>
</div>
<div id="search-error" class="sr-only" role="status"></div>
<div id="status" class="tree-empty" role="status" aria-live="polite">Scanning workspace…</div>
<div id="sections" class="sections" aria-busy="true"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const input = document.getElementById('q');
const clearSearchBtn = document.getElementById('clear-search');
const caseBtn = document.getElementById('case');
const wordBtn = document.getElementById('word');
const regexBtn = document.getElementById('regex');
const expandBtn = document.getElementById('expand');
const collapseBtn = document.getElementById('collapse');
const sortBtn = document.getElementById('sort');
const sectionsEl = document.getElementById('sections');
const statusEl = document.getElementById('status');
const searchErrorEl = document.getElementById('search-error');
const dataControls = [input, clearSearchBtn, caseBtn, wordBtn, regexBtn, expandBtn, collapseBtn, sortBtn];
const codiconByKind = {
  'symbol-package': 'package',
  'symbol-namespace': 'symbol-namespace',
  'symbol-class': 'symbol-class',
  'symbol-field': 'symbol-field',
  folder: 'folder',
  'file-code': 'file-code',
  'symbol-event': 'symbol-event',
};

const savedUiState = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
let searchState = { caseSensitive: !!savedUiState?.caseSensitive, wholeWord: !!savedUiState?.wholeWord, useRegex: !!savedUiState?.useRegex };
const sectionState = { backend: savedUiState?.backendOpen !== false, frontend: savedUiState?.frontendOpen !== false };
const visibleSearchLimitBySection = { backend: 100, frontend: 100 };
const visibleTreeLimitBySection = {
  backend: Number.isInteger(savedUiState?.visibleTreeLimitBySection?.backend) ? Math.max(100, Math.min(savedUiState.visibleTreeLimitBySection.backend, 2000)) : 299,
  frontend: Number.isInteger(savedUiState?.visibleTreeLimitBySection?.frontend) ? Math.max(100, Math.min(savedUiState.visibleTreeLimitBySection.frontend, 2000)) : 299,
};
let expandDepth = Number.isInteger(savedUiState?.expandDepth) ? Math.max(0, Math.min(savedUiState.expandDepth, 8)) : 1;
let selectedNodeId = typeof savedUiState?.selectedNodeId === 'string' ? savedUiState.selectedNodeId.slice(0, 512) : '';
let savedScrollTop = Number.isFinite(savedUiState?.scrollTop) ? Math.max(0, Math.min(savedUiState.scrollTop, 10000000)) : 0;
let lastSections = [];
let lastHasFilter = false;
let searchTimer = 0;
let scrollPersistTimer = 0;
const SEARCH_DEBOUNCE_MS = 180;
input.value = typeof savedUiState?.query === 'string' ? savedUiState.query : '';
sortBtn.value = ['none', 'asc', 'desc'].includes(savedUiState?.sortMode) ? savedUiState.sortMode : 'none';

function persistUiState() {
  if (typeof vscode.setState !== 'function') return;
  vscode.setState({
    query: input.value,
    caseSensitive: searchState.caseSensitive,
    wholeWord: searchState.wholeWord,
    useRegex: searchState.useRegex,
    sortMode: sortBtn.value,
    backendOpen: sectionState.backend,
    frontendOpen: sectionState.frontend,
    visibleTreeLimitBySection,
    expandDepth,
    selectedNodeId,
    scrollTop: Math.round(window.scrollY),
  });
}

function setDataControlsDisabled(disabled) {
  dataControls.forEach((control) => { control.disabled = disabled; });
}

function emitSearchNow() {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = 0;
  }
  visibleSearchLimitBySection.backend = 100;
  visibleSearchLimitBySection.frontend = 100;
  clearSearchBtn.hidden = input.value.length === 0;
  persistUiState();
  vscode.postMessage({ type: 'search', query: input.value, ...searchState });
}

function scheduleSearch() {
  if (input.value.length === 0) {
    emitSearchNow();
    return;
  }
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(emitSearchNow, SEARCH_DEBOUNCE_MS);
}

function clearSearch() {
  if (!input.value) return;
  input.value = '';
  input.removeAttribute('aria-invalid');
  searchErrorEl.textContent = '';
  emitSearchNow();
}

function toggleBtn(btn, key) {
  searchState[key] = !searchState[key];
  btn.classList.toggle('active', searchState[key]);
  btn.setAttribute('aria-pressed', String(searchState[key]));
  emitSearchNow();
}

function syncExpandButton() {
  expandBtn.textContent = '▾';
  expandBtn.title = 'Expand one level';
  expandBtn.setAttribute('aria-label', 'Expand one level');
}

function shouldStartOpen(depth, autoExpand) {
  return !autoExpand && depth < expandDepth;
}

function rerenderTree() {
  renderSections(lastSections, lastHasFilter);
}

input.addEventListener('input', scheduleSearch);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && input.value) {
    clearSearch();
    e.preventDefault();
  }
});
clearSearchBtn.addEventListener('click', clearSearch);
caseBtn.addEventListener('click', () => toggleBtn(caseBtn, 'caseSensitive'));
wordBtn.addEventListener('click', () => toggleBtn(wordBtn, 'wholeWord'));
regexBtn.addEventListener('click', () => toggleBtn(regexBtn, 'useRegex'));
expandBtn.addEventListener('click', () => {
  expandDepth = Math.min(expandDepth + 1, 8);
  persistUiState();
  syncExpandButton();
  rerenderTree();
});
collapseBtn.addEventListener('click', () => {
  expandDepth = 0;
  persistUiState();
  rerenderTree();
});

sortBtn.addEventListener('change', () => {
  persistUiState();
  vscode.postMessage({ type: 'sort', mode: sortBtn.value });
});
[
  [caseBtn, 'caseSensitive'],
  [wordBtn, 'wholeWord'],
  [regexBtn, 'useRegex'],
].forEach(([button, key]) => {
  button.classList.toggle('active', searchState[key]);
  button.setAttribute('aria-pressed', String(searchState[key]));
});
syncExpandButton();
clearSearchBtn.hidden = input.value.length === 0;

// ── Section + tree rendering ──
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function buildHighlightPattern() {
  const query = input.value.trim();
  if (!query) return null;

  let source = searchState.useRegex ? query : escapeRegExp(query);
  if (searchState.wholeWord) source = '\\b' + source + '\\b';

  try {
    return new RegExp(source, searchState.caseSensitive ? 'g' : 'gi');
  } catch {
    return new RegExp(escapeRegExp(query), searchState.caseSensitive ? 'g' : 'gi');
  }
}

function highlightedHtml(value, pattern) {
  const text = String(value || '');
  if (!pattern) return escapeHtml(text);

  let out = '';
  let lastIndex = 0;
  let matched = false;
  let match;
  pattern.lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start === end) {
      pattern.lastIndex = start + 1;
      if (pattern.lastIndex > text.length) break;
      continue;
    }

    out += escapeHtml(text.slice(lastIndex, start)) +
      '<mark class="search-match">' + escapeHtml(text.slice(start, end)) + '</mark>';
    lastIndex = end;
    matched = true;
  }

  return matched ? out + escapeHtml(text.slice(lastIndex)) : escapeHtml(text);
}

function renderSections(sections, hasFilter) {
  sectionsEl.setAttribute('aria-busy', 'false');
  sectionsEl.innerHTML = '';
  if (!sections || sections.length === 0) {
    sectionsEl.innerHTML = '<div class="tree-empty"><strong>No matching schema items</strong><div>Try clearing search options or use Clear search.</div><button type="button" class="load-more" data-clear-search>Clear search</button></div>';
    sectionsEl.querySelector('[data-clear-search]')?.addEventListener('click', () => {
      clearSearch();
      input.focus();
    });
    return;
  }
  const highlightPattern = hasFilter ? buildHighlightPattern() : null;
  const frag = document.createDocumentFragment();
  for (const section of sections) {
    frag.appendChild(buildSection(section, hasFilter, highlightPattern));
  }
  sectionsEl.appendChild(frag);
  const firstItem = sectionsEl.querySelector('[role="treeitem"]');
  const restoredSelection = selectedNodeId
    ? Array.from(sectionsEl.querySelectorAll('[role="treeitem"]')).find((item) => item.dataset.nodeId === selectedNodeId)
    : undefined;
  if (restoredSelection) restoredSelection.tabIndex = 0;
  else if (firstItem) firstItem.tabIndex = 0;
  if (savedScrollTop > 0) {
    window.scrollTo(0, savedScrollTop);
    savedScrollTop = 0;
  }
}

function countNodes(nodes, predicate) {
  let count = 0;
  for (const node of nodes || []) {
    if (predicate(node)) count += 1;
    count += countNodes(node.children, predicate);
  }
  return count;
}

function collectSearchResults(nodes, ancestors, results) {
  for (const node of nodes || []) {
    const nextAncestors = [...ancestors, node.label];
    const hasChildren = node.children && node.children.length > 0;
    if (!hasChildren || node.classId || node.kind === 'file' || node.kind === 'operation' || node.kind === 'field') {
      results.push({ node, context: ancestors.join(' › ') });
    }
    if (hasChildren) collectSearchResults(node.children, nextAncestors, results);
  }
}

function activateSearchResult(node, sectionId) {
  if (sectionId === 'frontend' && node.file) {
    vscode.postMessage({ type: 'open', file: node.file, line: node.line });
  } else if (node.classId) {
    vscode.postMessage({ type: 'preview', classId: node.classId });
  } else if (node.file) {
    vscode.postMessage({ type: 'open', file: node.file, line: node.line });
  }
}

function buildSearchResults(section, highlightPattern) {
  const all = [];
  collectSearchResults(section.children, [], all);
  const limit = visibleSearchLimitBySection[section.id] || 100;
  const list = document.createElement('div');
  list.className = 'search-results';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', section.label + ' search results');
  for (const result of all.slice(0, limit)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-result';
    row.innerHTML =
      '<span class="icon codicon codicon-' + (codiconByKind[result.node.icon] || 'circle-large-outline') + '" aria-hidden="true"></span>' +
      '<span class="result-main">' + highlightedHtml(result.node.label, highlightPattern) + '</span>' +
      (result.context ? '<span class="result-context">' + escapeHtml(result.context) + '</span>' : '');
    row.addEventListener('click', () => activateSearchResult(result.node, section.id));
    list.appendChild(row);
  }
  if (all.length > limit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'load-more result-more';
    more.textContent = 'Show 100 more (' + (all.length - limit) + ' remaining)';
    more.addEventListener('click', () => {
      visibleSearchLimitBySection[section.id] = limit + 100;
      renderSections(lastSections, true);
      sectionsEl.querySelector('.result-more')?.focus();
    });
    list.appendChild(more);
  }
  if (all.length === 0) list.innerHTML = '<div class="section-empty"><strong>No matching schema items</strong><div>Try clearing search options or use Clear search.</div><button type="button" class="load-more" data-clear-search>Clear search</button></div>';
  list.querySelector('[data-clear-search]')?.addEventListener('click', () => {
    clearSearch();
    input.focus();
  });
  return list;
}

function buildSection(section, hasFilter, highlightPattern) {
  const details = document.createElement('details');
  details.className = 'accordion';
  const remembered = Object.prototype.hasOwnProperty.call(sectionState, section.id)
    ? sectionState[section.id]
    : !!section.openByDefault;
  details.open = remembered;
  details.dataset.sectionId = section.id;

  const summary = document.createElement('summary');
  summary.innerHTML =
    '<div class="section-left">' +
    '<span class="section-chevron">▸</span>' +
    '<span class="section-label">' + escapeHtml(section.label) + '</span>' +
    '</div>' +
    '<span class="section-desc">' + escapeHtml(section.desc || '') + '</span>';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'section-body';
  if (!section.children || section.children.length === 0) {
    body.innerHTML = '<div class="section-empty">' + escapeHtml(section.emptyMessage || 'No items found') + '</div>';
  } else if (hasFilter) {
    body.appendChild(buildSearchResults(section, highlightPattern));
  } else {
    const tree = document.createElement('div');
    tree.className = 'tree';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', section.label + ' schema items');
    const treeLimit = visibleTreeLimitBySection[section.id] || 299;
    for (const node of section.children.slice(0, treeLimit)) {
      tree.appendChild(buildNode(node, 0, hasFilter, section.id, highlightPattern));
    }
    body.appendChild(tree);
    if (section.children.length > treeLimit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'load-more result-more';
      more.textContent = 'Show 100 more (' + (section.children.length - treeLimit) + ' remaining)';
      more.addEventListener('click', () => {
        visibleTreeLimitBySection[section.id] = treeLimit + 100;
        persistUiState();
        renderSections(lastSections, false);
        sectionsEl.querySelector('.result-more')?.focus();
      });
      body.appendChild(more);
    }
  }
  details.appendChild(body);

  details.addEventListener('toggle', () => {
    sectionState[section.id] = details.open;
    persistUiState();
  });

  return details;
}

function buildNode(node, depth, autoExpand, sectionId, highlightPattern) {
  const wrapper = document.createElement('div');
  const hasChildren = node.children && node.children.length > 0;

  // Row
  const row = document.createElement('div');
  row.className = 'node';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.tabIndex = -1;
  row.dataset.nodeId = node.classId || (node.file ? node.file + ':' + (node.line || 0) : sectionId + ':' + node.kind + ':' + node.label + ':' + depth);

  const indent = document.createElement('span');
  indent.className = 'indent';
  indent.style.width = (depth * 16 + 4) + 'px';
  row.appendChild(indent);

  const twistie = document.createElement('span');
  twistie.className = 'twistie' + (hasChildren ? '' : ' hidden');
  twistie.textContent = '▸';
  row.appendChild(twistie);

  const icon = document.createElement('span');
  icon.className = 'icon codicon codicon-' + (codiconByKind[node.icon] || 'circle-large-outline');
  icon.setAttribute('aria-hidden', 'true');
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'label';
  label.innerHTML = highlightedHtml(node.label, highlightPattern);
  row.appendChild(label);

  if (node.desc) {
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.innerHTML = highlightedHtml(node.desc, highlightPattern);
    row.appendChild(desc);
  }

  wrapper.appendChild(row);

  // Children container
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'children';

    if (shouldStartOpen(depth, autoExpand)) {
      childrenEl.classList.add('open');
      twistie.textContent = '▾';
      for (const child of node.children) {
        childrenEl.appendChild(buildNode(child, depth + 1, autoExpand, sectionId, highlightPattern));
      }
    }

    wrapper.appendChild(childrenEl);
    childrenEl.setAttribute('role', 'group');
    row.setAttribute('aria-expanded', childrenEl.classList.contains('open') ? 'true' : 'false');
  }

  function toggleChildren() {
    if (!hasChildren || !childrenEl) return;
    const isOpen = childrenEl.classList.toggle('open');
    twistie.textContent = isOpen ? '▾' : '▸';
    row.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && childrenEl.children.length === 0) {
      for (const child of node.children) {
        childrenEl.appendChild(buildNode(child, depth + 1, false, sectionId, highlightPattern));
      }
    }
  }

  function activate() {
    if (sectionId === 'frontend' && node.file && (node.kind === 'file' || node.kind === 'operation')) {
      vscode.postMessage({ type: 'open', file: node.file, line: node.line });
      return;
    }
    if (node.classId) {
      vscode.postMessage({ type: 'preview', classId: node.classId });
    }
    if (hasChildren && (sectionId !== 'frontend' || node.kind === 'folder')) {
      toggleChildren();
    }
  }

  row.addEventListener('click', activate);
  row.addEventListener('focus', () => {
    const tree = row.closest('[role="tree"]');
    if (!tree) return;
    tree.querySelectorAll('[role="treeitem"]').forEach((item) => { item.tabIndex = -1; item.classList.remove('selected'); });
    row.tabIndex = 0;
    row.classList.add('selected');
    selectedNodeId = row.dataset.nodeId || '';
    persistUiState();
  });
  row.addEventListener('keydown', (e) => {
    const tree = row.closest('[role="tree"]');
    const visible = tree ? Array.from(tree.querySelectorAll('[role="treeitem"]')).filter((item) => item.offsetParent !== null) : [];
    const index = visible.indexOf(row);
    const move = (next) => { if (next) next.focus(); };
    if (e.key === 'ArrowDown') { move(visible[index + 1]); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(visible[index - 1]); e.preventDefault(); }
    else if (e.key === 'Home') { move(visible[0]); e.preventDefault(); }
    else if (e.key === 'End') { move(visible[visible.length - 1]); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && hasChildren) { if (!childrenEl.classList.contains('open')) toggleChildren(); else move(childrenEl.querySelector('[role="treeitem"]')); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && hasChildren && childrenEl.classList.contains('open')) { toggleChildren(); e.preventDefault(); }
    else if (e.key === ' ' && hasChildren) { toggleChildren(); e.preventDefault(); }
    else if (e.key === 'Enter') { activate(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && node.file) { vscode.postMessage({ type: 'open', file: node.file, line: node.line }); e.preventDefault(); }
  });
  row.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (node.file) {
      vscode.postMessage({ type: 'open', file: node.file, line: node.line });
    }
  });

  return wrapper;
}

// ── Messages from extension ──
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'status' && msg.status) {
    const nextStatus = msg.status;
    statusEl.hidden = false;
    statusEl.textContent = nextStatus.message || '';
    const busy = nextStatus.kind === 'loading';
    sectionsEl.setAttribute('aria-busy', String(busy));
    setDataControlsDisabled(busy && !nextStatus.hasStaleData);
    if (nextStatus.kind === 'error') statusEl.setAttribute('role', 'alert');
    else statusEl.setAttribute('role', 'status');
    if (nextStatus.kind === 'error' && nextStatus.retryable) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'load-more';
      retry.textContent = 'Try Again';
      retry.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      statusEl.appendChild(document.createTextNode(' '));
      statusEl.appendChild(retry);
    }
    return;
  }
  if (msg.type === 'tree') {
    lastSections = msg.sections;
    lastHasFilter = msg.hasFilter;
    if (msg.filterError) {
      input.setAttribute('aria-invalid', 'true');
      searchErrorEl.textContent = msg.filterError;
      statusEl.hidden = false;
      statusEl.textContent = msg.filterError;
      sectionsEl.setAttribute('aria-busy', 'false');
      return;
    }
    input.removeAttribute('aria-invalid');
    searchErrorEl.textContent = '';
    renderSections(msg.sections, msg.hasFilter);
    setDataControlsDisabled(false);
    const backend = msg.sections.find((section) => section.id === 'backend');
    const frontend = msg.sections.find((section) => section.id === 'frontend');
    const typeCount = countNodes(backend?.children, (node) => !!node.classId);
    const fileCount = countNodes(frontend?.children, (node) => node.kind === 'file');
    if (!statusEl.textContent || statusEl.textContent === 'Scanning workspace…') {
      statusEl.hidden = false;
      statusEl.textContent = Number(typeCount).toLocaleString() + ' types · ' + Number(fileCount).toLocaleString() + ' GraphQL files';
    }
  }
});
window.addEventListener('scroll', () => {
  if (scrollPersistTimer) return;
  scrollPersistTimer = setTimeout(() => {
    scrollPersistTimer = 0;
    persistUiState();
  }, 150);
}, { passive: true });
setDataControlsDisabled(true);
vscode.postMessage({ type: 'ready', surface: 'explorer' });
</script>
</body>
</html>`;
  }
}
