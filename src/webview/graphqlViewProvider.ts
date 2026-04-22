import * as vscode from 'vscode';
import * as path from 'path';
import { SchemaInfo, ClassInfo } from '../types';
import { buildInspectorData } from '../preview/inspector';
import { buildReverseIndex } from '../scanner/reverseIndex';
import { computeQueryCoverage, CoverageMap } from '../analysis/gqlCoverage';
import { FrontendGqlFileUsage } from '../analysis/frontendGqlUsage';
import { FragmentDef } from '../codelens/gqlCodeLensProvider';

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

function classIdFor(cls: ClassInfo): string {
  return `${cls.filePath}:${cls.lineNumber}:${cls.kind}:${cls.name}`;
}

export class GraphqlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'djangoGraphqlExplorer.view';

  private view?: vscode.WebviewView;
  private schemas: SchemaInfo[] = [];
  private classContexts = new Map<string, { cls: ClassInfo; schemaClassMap: Map<string, ClassInfo> }>();
  private classIdsByName = new Map<string, string[]>();
  private classMap = new Map<string, ClassInfo>();
  private coverage: CoverageMap = new Map();
  private frontendUsages: FrontendGqlFileUsage[] = [];
  private filterPattern: RegExp | null = null;
  private sortMode: 'none' | 'asc' | 'desc' = 'none';

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
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendTree();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'search') {
        this.applyFilter(msg);
      } else if (msg.type === 'open' && msg.file) {
        const uri = vscode.Uri.file(msg.file);
        const line = msg.line ?? 0;
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(line, 0, line, 0),
        });
      } else if (msg.type === 'preview' && (msg.classId || msg.className)) {
        this.showPreview(msg.classId ?? msg.className);
      } else if (msg.type === 'sort') {
        this.sortMode = msg.mode;
        this.sendTree();
      }
    });
  }

  updateSchemas(schemas: SchemaInfo[], frontendUsages: FrontendGqlFileUsage[] = this.frontendUsages): void {
    this.schemas = schemas;
    this.frontendUsages = frontendUsages;
    this.classContexts.clear();
    this.classIdsByName.clear();
    this.classMap.clear();
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
    if (!msg.query) {
      this.filterPattern = null;
    } else {
      const flags = msg.caseSensitive ? '' : 'i';
      let source = msg.useRegex ? msg.query : msg.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (msg.wholeWord) source = `\\b${source}\\b`;
      try {
        this.filterPattern = new RegExp(source, flags);
      } catch {
        this.filterPattern = new RegExp(msg.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      }
    }
    this.sendTree();
  }

  private filterAndSortClasses(classes: ClassInfo[]): ClassInfo[] {
    let result = this.filterPattern
      ? classes.filter((cls) => this.filterPattern!.test(cls.name) || cls.fields.some((f) => this.filterPattern!.test(f.name)))
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
    for (const schema of this.schemas) {
      const schemaClassMap = new Map<string, ClassInfo>();
      for (const cls of [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types]) {
        schemaClassMap.set(cls.name, cls);
      }
      const categories: TreeNode[] = [];
      const fq = this.filterAndSortClasses(schema.queries);
      if (fq.length > 0) categories.push({ label: 'Queries', desc: `${fq.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fq, schemaClassMap) });
      const fm = this.filterAndSortClasses(schema.mutations);
      if (fm.length > 0) categories.push({ label: 'Mutations', desc: `${fm.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fm, schemaClassMap) });
      const fs = this.filterAndSortClasses(schema.subscriptions);
      if (fs.length > 0) categories.push({ label: 'Subscriptions', desc: `${fs.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(fs, schemaClassMap) });
      const ft = this.filterAndSortClasses(schema.types);
      if (ft.length > 0) categories.push({ label: 'Types', desc: `${ft.length}`, kind: 'category', icon: 'symbol-namespace', children: this.buildClassPathTree(ft, schemaClassMap) });

      if (this.filterPattern && categories.length === 0) continue;
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

    const roots: TreeNode[] = [];
    for (const usage of usages) {
      const segments = usage.relativePath.split('/').filter(Boolean);
      if (segments.length === 0) continue;

      let cursor = roots;
      for (const segment of segments.slice(0, -1)) {
        let folder = cursor.find((node) => node.icon === 'folder' && node.label === segment);
        if (!folder) {
          folder = { label: segment, kind: 'folder', icon: 'folder', children: [] };
          cursor.push(folder);
        }
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

    const visible = this.filterPattern ? this.filterTreeNodes(roots) : roots;
    this.decorateFrontendFolderCounts(visible);
    return visible;
  }

  private buildSections(): TreeSection[] {
    const backendTree = this.buildBackendTree();
    const frontendTree = this.buildFrontendTree();
    const backendCount = this.countNodesByIcon(backendTree, 'symbol-class');
    const frontendCount = this.countNodesByIcon(frontendTree, 'file-code');

    return [
      {
        id: 'backend',
        label: 'Backend',
        desc: `${backendCount} ${backendCount === 1 ? 'class' : 'classes'}`,
        emptyMessage: this.filterPattern
          ? 'No backend schema items matched the current filter.'
          : 'No backend schemas loaded yet.',
        openByDefault: true,
        children: backendTree,
      },
      {
        id: 'frontend',
        label: 'Frontend',
        desc: `${frontendCount} ${frontendCount === 1 ? 'file' : 'files'}`,
        emptyMessage: this.filterPattern
          ? 'No frontend gql files matched the current filter.'
          : 'No frontend gql templates found.',
        openByDefault: true,
        children: frontendTree,
      },
    ];
  }

  private buildClassNode(cls: ClassInfo, schemaClassMap: Map<string, ClassInfo>): TreeNode {
    const children: TreeNode[] = cls.fields.map((f) => {
      const resolvedClass = f.resolvedType ? schemaClassMap.get(f.resolvedType) : undefined;
      const resolvedChildren = resolvedClass ? this.buildResolvedChildren(resolvedClass) : undefined;
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

  private buildClassPathTree(classes: ClassInfo[], schemaClassMap: Map<string, ClassInfo>): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const cls of classes) {
      const classNode = this.buildClassNode(cls, schemaClassMap);
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
        let node = cursor.find((child) => child.label === segment && child.kind === (isFile ? 'file' : 'folder'));
        if (!node) {
          node = {
            label: segment,
            kind: isFile ? 'file' : 'folder',
            icon: isFile ? 'file-code' : 'folder',
            file: isFile ? cls.filePath : undefined,
            line: isFile ? cls.lineNumber : undefined,
            children: [],
          };
          cursor.push(node);
        }
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
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!folder) return filePath;
    const relative = path.relative(folder.uri.fsPath, filePath);
    return relative || path.basename(filePath);
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

  private filterTreeNodes(nodes: TreeNode[]): TreeNode[] {
    if (!this.filterPattern) return nodes;
    const out: TreeNode[] = [];
    for (const node of nodes) {
      const ownMatch = this.matchesFilter(node.label) || this.matchesFilter(node.desc);
      if (ownMatch) {
        out.push({ ...node });
        continue;
      }

      const children = node.children ? this.filterTreeNodes(node.children) : undefined;
      if (children && children.length > 0) {
        out.push({ ...node, children });
      }
    }
    return out;
  }

  private matchesFilter(value?: string): boolean {
    return !!(value && this.filterPattern && this.filterPattern.test(value));
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
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.previewPanel.webview.html = this.getInspectorShellHtml();
      this.previewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'navigate' && (msg.classId || msg.className)) {
          this.renderInspector(msg.classId ?? msg.className);
        } else if (msg.type === 'open' && msg.file) {
          const uri = vscode.Uri.file(msg.file);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
          });
        }
      });
      this.previewPanel.onDidDispose(() => {
        this.previewPanel = undefined;
        this.currentInspectorClassId = undefined;
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
    const payload = buildInspectorData(
      ctx.cls.name,
      ctx.schemaClassMap,
      reverseIndex,
      coverageForClass,
      (candidate) => classIdFor(candidate),
    );
    if (!payload) return;
    this.currentInspectorClassId = classId;
    this.previewPanel.title = ctx.cls.name;
    this.previewPanel.webview.postMessage({ type: 'inspector', data: payload });
  }

  private getInspectorShellHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; }
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
.header .title { font-size: 1.4em; font-weight: 600; }
.header .kind {
  display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 3px;
  font-size: 0.7em; text-transform: uppercase; vertical-align: middle;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.header .path {
  display: block; margin-top: 4px; color: var(--vscode-textLink-foreground);
  cursor: pointer; font-family: var(--vscode-editor-font-family); font-size: 0.85em;
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
.chip.unknown { opacity: 0.55; font-style: italic; }
.fields-table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
.fields-table th, .fields-table td { text-align: left; padding: 4px 8px; vertical-align: top; }
.fields-table th { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 0.85em; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
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
.fields-table .name-snake { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.fields-table .arg-row { font-size: 0.85em; margin-top: 2px; color: var(--vscode-descriptionForeground); }
.fields-table .arg-row .chip { font-size: 0.85em; padding: 1px 6px; }
.ref-item {
  padding: 3px 0; font-family: var(--vscode-editor-font-family); font-size: 0.9em; cursor: pointer;
}
.ref-item:hover { text-decoration: underline; }
.ref-item .via { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 6px; }
.empty { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
details.sdl { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
details.sdl summary { cursor: pointer; padding: 4px 0; color: var(--vscode-descriptionForeground); }
details.sdl pre { margin: 6px 0 0; padding: 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08)); border-radius: 3px; overflow-x: auto; }
details.sdl .kw { color: #c586c0; } details.sdl .type { color: #4ec9b0; } details.sdl .comment { color: #6a9955; }
</style></head><body>
<div id="root"><div class="empty" style="padding:20px">Loading…</div></div>
<script>
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

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
  const cls = targetId ? 'chip clickable' : 'chip unknown';
  const attrs = targetId ? ' data-nav="' + escapeHtml(targetId) + '"' : '';
  return '<span class="' + cls + '"' + attrs + '">' + escapeHtml(typeName) + '</span>';
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
  const kindBadge = '<span class="kind">' + escapeHtml(data.kind) + '</span>';
  const path = escapeHtml(data.filePath) + ':' + (data.lineNumber + 1);

  const baseChips = data.baseClasses.length === 0
    ? '<span class="empty">—</span>'
    : '<div class="chips">' + data.baseClasses.map(b =>
        typeChip(b, data.baseClassTargets[b])
      ).join('') + '</div>';

  const coveragePill = data.totalCount === 0
    ? ''
    : '<span class="coverage-pill' + (data.queriedCount === 0 ? ' zero' : '') + '">' +
      '✓ ' + data.queriedCount + ' / ' + data.totalCount + ' queried</span>';

  const fieldRows = data.fields.length === 0
    ? '<div class="empty">No fields</div>'
    : '<table class="fields-table"><thead><tr><th>Field</th><th>Type</th></tr></thead><tbody>' +
      data.fields.map(r => {
        const rowClasses = ['field-row'];
        if (r.origin === 'inherited') rowClasses.push('inherited');
        if (r.queried) rowClasses.push('queried');
        const resolved = r.resolvedType ? ' → ' + typeChip(r.resolvedType, r.resolvedTypeId) : '';
        return '<tr class="' + rowClasses.join(' ') + '" data-file="' + escapeHtml(r.filePath) + '" data-line="' + r.lineNumber + '">' +
          '<td><span class="name">' + escapeHtml(r.displayName) + '</span>' +
          (r.name !== r.displayName ? ' <span class="name-snake">(' + escapeHtml(r.name) + ')</span>' : '') +
          '</td><td>' +
          '<span class="muted">' + escapeHtml(r.fieldType) + '</span>' + resolved +
          argsFragment(r.args) +
          '</td></tr>';
      }).join('') + '</tbody></table>';

  const refItems = (refs, via) => refs.length === 0
    ? '<div class="empty">—</div>'
    : refs.map(r =>
        '<div class="ref-item"' + (r.fromClassId ? ' data-nav="' + escapeHtml(r.fromClassId) + '"' : '') + '>' +
        escapeHtml(r.fromClass) + '.<span class="muted">' + escapeHtml(r.fromField) + '</span>' +
        '<span class="via">(' + via + (r.label !== r.fromField ? ': ' + escapeHtml(r.label) : '') + ')</span>' +
        '</div>'
      ).join('');

  root.innerHTML =
    '<div class="header"><div><span class="title">' + escapeHtml(data.className) + '</span>' + kindBadge + '</div>' +
    '<a class="path" data-file="' + escapeHtml(data.filePath) + '" data-line="' + data.lineNumber + '">' + path + '</a></div>' +

    '<div class="section"><h3>Base classes</h3>' + baseChips + '</div>' +

    '<div class="section"><h3>Fields (' + data.fields.length + ')' + coveragePill + '</h3>' + fieldRows + '</div>' +

    '<div class="section"><h3>Used as field type (' + data.usedAsFieldType.length + ')</h3>' + refItems(data.usedAsFieldType, 'field') + '</div>' +

    '<div class="section"><h3>Used as argument type (' + data.usedAsArgType.length + ')</h3>' + refItems(data.usedAsArgType, 'arg') + '</div>' +

    '<div class="section"><details class="sdl"><summary>GraphQL SDL preview</summary><pre>' + renderSdl(data.sdl) + '</pre></details></div>';

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
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'inspector') render(msg.data);
});
</script>
</body></html>`;
  }

  private sendTree(): void {
    if (!this.view) return;
    const sections = this.buildSections();
    this.view.webview.postMessage({ type: 'tree', sections, hasFilter: !!this.filterPattern, sortMode: this.sortMode });
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html>
<head>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  overflow: auto;
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
  gap: 1px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  border-radius: 2px;
  padding: 0 2px;
}
.search-row:focus-within {
  border-color: var(--vscode-focusBorder);
}
.search-row input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  padding: 3px 4px;
  font-family: inherit;
  font-size: inherit;
  color: var(--vscode-input-foreground);
  background: transparent;
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
  margin: 8px;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-sideBar-background);
}
.accordion[open] {
  background: var(--vscode-editor-background);
}
.accordion summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 8px 10px;
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
}
.section-body {
  padding: 4px 0 8px;
  overflow-x: auto;
}
.section-empty {
  padding: 10px 14px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* ── Tree ── */
.tree {
  display: inline-block;
  min-width: 100%;
  width: max-content;
  padding: 2px 0;
}
.tree-empty {
  padding: 12px 20px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
.node {
  display: flex;
  align-items: center;
  height: 22px;
  min-width: 100%;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  width: max-content;
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
.node .label { flex-shrink: 0; }
.node .desc {
  flex-shrink: 0;
  margin-left: 6px;
  color: var(--vscode-descriptionForeground);
  overflow: visible;
  text-overflow: clip;
}
.children { display: none; }
.children.open { display: block; }

/* codicon-like icons via SVG or characters */
.icon-symbol-package::before { content: '📦'; font-size: 12px; }
.icon-symbol-namespace::before { content: '{}'; font-size: 10px; font-weight: bold; color: var(--vscode-symbolIcon-namespaceForeground, #9cdcfe); }
.icon-symbol-class::before { content: 'C'; font-size: 11px; font-weight: bold; color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
.icon-symbol-field::before { content: 'F'; font-size: 11px; font-weight: bold; color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
.icon-folder::before { content: 'D'; font-size: 11px; font-weight: 700; color: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
.icon-file-code::before { content: 'JS'; font-size: 8px; font-weight: 700; color: var(--vscode-symbolIcon-fileForeground, #cccccc); }
.icon-symbol-event::before { content: 'G'; font-size: 11px; font-weight: 700; color: var(--vscode-symbolIcon-eventForeground, #4ec9b0); }
</style>
</head>
<body>
<div class="search-bar">
  <div class="search-row">
    <input id="q" type="text" placeholder="Search..." spellcheck="false" />
    <button class="toggle" id="case" title="Match Case (Alt+C)">Aa</button>
    <button class="toggle" id="word" title="Match Whole Word (Alt+W)"><b>ab</b>|</button>
    <button class="toggle" id="regex" title="Use Regular Expression (Alt+R)">.*</button>
    <span class="sep"></span>
    <button class="toggle" id="expand" title="Tree: Expand all (Alt+E)">▾▾</button>
    <button class="toggle" id="sort" title="Sort: click to cycle (none → A-Z → Z-A)">↕</button>
  </div>
</div>
<div id="sections" class="sections"></div>

<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('q');
const caseBtn = document.getElementById('case');
const wordBtn = document.getElementById('word');
const regexBtn = document.getElementById('regex');
const expandBtn = document.getElementById('expand');
const sortBtn = document.getElementById('sort');
const sectionsEl = document.getElementById('sections');

let searchState = { caseSensitive: false, wholeWord: false, useRegex: false };
const sortCycle = ['none', 'asc', 'desc'];
const sortLabels = { none: '↕', asc: 'A↓', desc: 'Z↓' };
let sortIdx = 0;
const sectionState = { backend: true, frontend: true };
let expandMode = 'default';
let lastSections = [];
let lastHasFilter = false;

function emitSearch() {
  vscode.postMessage({ type: 'search', query: input.value, ...searchState });
}
function toggleBtn(btn, key) {
  searchState[key] = !searchState[key];
  btn.classList.toggle('active', searchState[key]);
  emitSearch();
}

function syncExpandButton() {
  const expandAll = expandMode === 'expand-all';
  expandBtn.textContent = expandAll ? '▸▸' : '▾▾';
  expandBtn.title = expandAll ? 'Tree: Collapse all (Alt+E)' : 'Tree: Expand all (Alt+E)';
  expandBtn.classList.toggle('active', expandAll);
}

function shouldStartOpen(depth, autoExpand) {
  if (expandMode === 'expand-all') return true;
  if (expandMode === 'collapse-all') return false;
  return autoExpand || depth < 1;
}

function rerenderTree() {
  renderSections(lastSections, lastHasFilter);
}

input.addEventListener('input', emitSearch);
caseBtn.addEventListener('click', () => toggleBtn(caseBtn, 'caseSensitive'));
wordBtn.addEventListener('click', () => toggleBtn(wordBtn, 'wholeWord'));
regexBtn.addEventListener('click', () => toggleBtn(regexBtn, 'useRegex'));
expandBtn.addEventListener('click', () => {
  expandMode = expandMode === 'expand-all' ? 'collapse-all' : 'expand-all';
  syncExpandButton();
  rerenderTree();
});

sortBtn.addEventListener('click', () => {
  sortIdx = (sortIdx + 1) % sortCycle.length;
  const mode = sortCycle[sortIdx];
  sortBtn.textContent = sortLabels[mode];
  sortBtn.classList.toggle('active', mode !== 'none');
  sortBtn.title = 'Sort: ' + (mode === 'none' ? 'none' : mode === 'asc' ? 'A → Z' : 'Z → A');
  vscode.postMessage({ type: 'sort', mode: mode });
});

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'c') { toggleBtn(caseBtn, 'caseSensitive'); e.preventDefault(); }
  if (e.altKey && e.key === 'w') { toggleBtn(wordBtn, 'wholeWord'); e.preventDefault(); }
  if (e.altKey && e.key === 'r') { toggleBtn(regexBtn, 'useRegex'); e.preventDefault(); }
  if (e.altKey && e.key === 'e') { expandBtn.click(); e.preventDefault(); }
  if (e.altKey && e.key === 's') { sortBtn.click(); e.preventDefault(); }
});
syncExpandButton();

// ── Section + tree rendering ──
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSections(sections, hasFilter) {
  sectionsEl.innerHTML = '';
  if (!sections || sections.length === 0) {
    sectionsEl.innerHTML = '<div class="tree-empty">No items found</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const section of sections) {
    frag.appendChild(buildSection(section, hasFilter));
  }
  sectionsEl.appendChild(frag);
}

function buildSection(section, hasFilter) {
  const details = document.createElement('details');
  details.className = 'accordion';
  const remembered = Object.prototype.hasOwnProperty.call(sectionState, section.id)
    ? sectionState[section.id]
    : !!section.openByDefault;
  details.open = hasFilter ? true : remembered;
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
  } else {
    const tree = document.createElement('div');
    tree.className = 'tree';
    for (const node of section.children) {
      tree.appendChild(buildNode(node, 0, hasFilter, section.id));
    }
    body.appendChild(tree);
  }
  details.appendChild(body);

  details.addEventListener('toggle', () => {
    sectionState[section.id] = details.open;
  });

  return details;
}

function buildNode(node, depth, autoExpand, sectionId) {
  const wrapper = document.createElement('div');
  const hasChildren = node.children && node.children.length > 0;

  // Row
  const row = document.createElement('div');
  row.className = 'node';

  const indent = document.createElement('span');
  indent.className = 'indent';
  indent.style.width = (depth * 16 + 4) + 'px';
  row.appendChild(indent);

  const twistie = document.createElement('span');
  twistie.className = 'twistie' + (hasChildren ? '' : ' hidden');
  twistie.textContent = '▸';
  row.appendChild(twistie);

  const icon = document.createElement('span');
  icon.className = 'icon icon-' + node.icon;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = node.label;
  row.appendChild(label);

  if (node.desc) {
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = node.desc;
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
        childrenEl.appendChild(buildNode(child, depth + 1, autoExpand, sectionId));
      }
    }

    wrapper.appendChild(childrenEl);
  }

  function toggleChildren() {
    if (!hasChildren || !childrenEl) return;
    const isOpen = childrenEl.classList.toggle('open');
    twistie.textContent = isOpen ? '▾' : '▸';
    if (isOpen && childrenEl.children.length === 0) {
      for (const child of node.children) {
        childrenEl.appendChild(buildNode(child, depth + 1, false, sectionId));
      }
    }
  }

  if (hasChildren) {
    twistie.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChildren();
    });
  }

  row.addEventListener('click', () => {
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
  if (msg.type === 'tree') {
    lastSections = msg.sections;
    lastHasFilter = msg.hasFilter;
    renderSections(msg.sections, msg.hasFilter);
  }
});
</script>
</body>
</html>`;
  }
}
