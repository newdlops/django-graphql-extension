import * as vscode from 'vscode';
import { SchemaInfo, ClassInfo } from '../types';
import { classToGraphql } from '../preview/schemaPreview';

interface TreeNode {
  label: string;
  desc?: string;
  icon: string;
  file?: string;
  line?: number;
  className?: string;
  children?: TreeNode[];
}

export class GraphqlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'djangoGraphqlExplorer.view';

  private view?: vscode.WebviewView;
  private schemas: SchemaInfo[] = [];
  private classMap = new Map<string, ClassInfo>();
  private filterPattern: RegExp | null = null;
  private sortMode: 'none' | 'asc' | 'desc' = 'none';

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
      } else if (msg.type === 'preview' && msg.className) {
        this.showPreview(msg.className);
      } else if (msg.type === 'sort') {
        this.sortMode = msg.mode;
        this.sendTree();
      }
    });
  }

  updateSchemas(schemas: SchemaInfo[]): void {
    this.schemas = schemas;
    this.classMap.clear();
    for (const schema of schemas) {
      for (const cls of [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types]) {
        this.classMap.set(cls.name, cls);
      }
    }
    this.sendTree();
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

  private buildTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const schema of this.schemas) {
      const categories: TreeNode[] = [];
      const fq = this.filterAndSortClasses(schema.queries);
      if (fq.length > 0) categories.push({ label: 'Queries', desc: `${fq.length}`, icon: 'symbol-namespace', children: fq.map((c) => this.buildClassNode(c)) });
      const fm = this.filterAndSortClasses(schema.mutations);
      if (fm.length > 0) categories.push({ label: 'Mutations', desc: `${fm.length}`, icon: 'symbol-namespace', children: fm.map((c) => this.buildClassNode(c)) });
      const fs = this.filterAndSortClasses(schema.subscriptions);
      if (fs.length > 0) categories.push({ label: 'Subscriptions', desc: `${fs.length}`, icon: 'symbol-namespace', children: fs.map((c) => this.buildClassNode(c)) });
      const ft = this.filterAndSortClasses(schema.types);
      if (ft.length > 0) categories.push({ label: 'Types', desc: `${ft.length}`, icon: 'symbol-namespace', children: ft.map((c) => this.buildClassNode(c)) });

      if (this.filterPattern && categories.length === 0) continue;
      roots.push({ label: schema.name, icon: 'symbol-package', file: schema.filePath, children: categories });
    }
    return roots;
  }

  private buildClassNode(cls: ClassInfo): TreeNode {
    const children: TreeNode[] = cls.fields.map((f) => {
      const hasResolved = f.resolvedType ? this.classMap.has(f.resolvedType) : false;
      const resolvedChildren = hasResolved ? this.buildResolvedChildren(f.resolvedType!) : undefined;
      return {
        label: f.name,
        desc: f.fieldType + (f.resolvedType ? ` → ${f.resolvedType}` : ''),
        icon: 'symbol-field',
        file: f.filePath || cls.filePath,
        line: f.lineNumber,
        children: resolvedChildren,
      };
    });
    return {
      label: cls.name,
      desc: `${cls.fields.length}`,
      icon: 'symbol-class',
      file: cls.filePath,
      line: cls.lineNumber,
      className: cls.name,
      children: children.length > 0 ? children : undefined,
    };
  }

  private buildResolvedChildren(typeName: string): TreeNode[] | undefined {
    const cls = this.classMap.get(typeName);
    if (!cls || cls.fields.length === 0) return undefined;
    return cls.fields.map((f) => ({
      label: f.name,
      desc: f.fieldType,
      icon: 'symbol-field',
      file: f.filePath || cls.filePath,
      line: f.lineNumber,
    }));
  }

  private previewPanel?: vscode.WebviewPanel;

  private showPreview(className: string): void {
    const cls = this.classMap.get(className);
    if (!cls) return;
    const sdl = classToGraphql(cls, this.classMap);

    if (this.previewPanel) {
      this.previewPanel.title = cls.name;
      this.previewPanel.webview.html = this.getPreviewHtml(cls.name, sdl);
      this.previewPanel.reveal(vscode.ViewColumn.One, true);
      return;
    }

    this.previewPanel = vscode.window.createWebviewPanel(
      'graphqlPreview',
      cls.name,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
    );
    this.previewPanel.webview.html = this.getPreviewHtml(cls.name, sdl);
    this.previewPanel.onDidDispose(() => { this.previewPanel = undefined; });
  }

  private getPreviewHtml(_title: string, sdl: string): string {
    const escaped = sdl
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^(type|input|enum|interface|union|scalar|query|mutation|subscription)\b/gm, '<span class="kw">$1</span>')
      .replace(/^(\s*#.*)/gm, '<span class="comment">$1</span>')
      .replace(/:\s*(\[?)(\w+)(]?[!]?)/g, ': $1<span class="type">$2</span>$3');

    return [
      '<!DOCTYPE html><html><head><style>',
      'body { font-family: var(--vscode-editor-font-family, Menlo, Monaco, monospace);',
      '  font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5;',
      '  color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);',
      '  padding: 16px 24px; white-space: pre; }',
      '.kw { color: #c586c0; } .type { color: #4ec9b0; } .comment { color: #6a9955; }',
      '</style></head><body>',
      escaped,
      '</body></html>',
    ].join('\n');
  }

  private sendTree(): void {
    if (!this.view) return;
    const tree = this.buildTree();
    this.view.webview.postMessage({ type: 'tree', data: tree, hasFilter: !!this.filterPattern, sortMode: this.sortMode });
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
  overflow-y: auto;
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

/* ── Tree ── */
.tree { padding: 2px 0; }
.tree-empty {
  padding: 12px 20px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
.node {
  display: flex;
  align-items: center;
  height: 22px;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
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
  margin-left: 6px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
.children { display: none; }
.children.open { display: block; }

/* codicon-like icons via SVG or characters */
.icon-symbol-package::before { content: '📦'; font-size: 12px; }
.icon-symbol-namespace::before { content: '{}'; font-size: 10px; font-weight: bold; color: var(--vscode-symbolIcon-namespaceForeground, #9cdcfe); }
.icon-symbol-class::before { content: 'C'; font-size: 11px; font-weight: bold; color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
.icon-symbol-field::before { content: 'F'; font-size: 11px; font-weight: bold; color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
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
    <button class="toggle" id="sort" title="Sort: click to cycle (none → A-Z → Z-A)">↕</button>
  </div>
</div>
<div id="tree" class="tree"></div>

<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('q');
const caseBtn = document.getElementById('case');
const wordBtn = document.getElementById('word');
const regexBtn = document.getElementById('regex');
const sortBtn = document.getElementById('sort');
const treeEl = document.getElementById('tree');

let searchState = { caseSensitive: false, wholeWord: false, useRegex: false };
const sortCycle = ['none', 'asc', 'desc'];
const sortLabels = { none: '↕', asc: 'A↓', desc: 'Z↓' };
let sortIdx = 0;

function emitSearch() {
  vscode.postMessage({ type: 'search', query: input.value, ...searchState });
}
function toggleBtn(btn, key) {
  searchState[key] = !searchState[key];
  btn.classList.toggle('active', searchState[key]);
  emitSearch();
}

input.addEventListener('input', emitSearch);
caseBtn.addEventListener('click', () => toggleBtn(caseBtn, 'caseSensitive'));
wordBtn.addEventListener('click', () => toggleBtn(wordBtn, 'wholeWord'));
regexBtn.addEventListener('click', () => toggleBtn(regexBtn, 'useRegex'));

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
  if (e.altKey && e.key === 's') { sortBtn.click(); e.preventDefault(); }
});

// ── Tree rendering ──
function renderTree(nodes, hasFilter) {
  if (!nodes || nodes.length === 0) {
    treeEl.innerHTML = '<div class="tree-empty">No items found</div>';
    return;
  }
  treeEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    frag.appendChild(buildNode(node, 0, hasFilter));
  }
  treeEl.appendChild(frag);
}

function buildNode(node, depth, autoExpand) {
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

    // Auto-expand when filtering, or first 2 levels
    if (autoExpand || depth < 1) {
      childrenEl.classList.add('open');
      twistie.textContent = '▾';
      for (const child of node.children) {
        childrenEl.appendChild(buildNode(child, depth + 1, autoExpand));
      }
    }

    wrapper.appendChild(childrenEl);
  }

  // Click: toggle expand. Double-click: open source + preview schema.
  row.addEventListener('click', (e) => {
    if (hasChildren) {
      const isOpen = childrenEl.classList.toggle('open');
      twistie.textContent = isOpen ? '▾' : '▸';
      if (isOpen && childrenEl.children.length === 0) {
        for (const child of node.children) {
          childrenEl.appendChild(buildNode(child, depth + 1, false));
        }
      }
    }
    // Show GraphQL preview for class nodes on single click
    if (node.className) {
      vscode.postMessage({ type: 'preview', className: node.className });
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
    renderTree(msg.data, msg.hasFilter);
  }
});
</script>
</body>
</html>`;
  }
}
