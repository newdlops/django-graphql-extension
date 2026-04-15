import * as vscode from 'vscode';
import { SchemaInfo, ClassInfo } from '../types';

interface TreeNode {
  label: string;
  desc?: string;
  icon: string;
  file?: string;
  line?: number;
  children?: TreeNode[];
}

export class GraphqlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'djangoGraphqlExplorer.view';

  private view?: vscode.WebviewView;
  private schemas: SchemaInfo[] = [];
  private classMap = new Map<string, ClassInfo>();
  private filterPattern: RegExp | null = null;

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

  private filterClasses(classes: ClassInfo[]): ClassInfo[] {
    if (!this.filterPattern) return classes;
    return classes.filter(
      (cls) => this.filterPattern!.test(cls.name) || cls.fields.some((f) => this.filterPattern!.test(f.name)),
    );
  }

  private buildTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const schema of this.schemas) {
      const categories: TreeNode[] = [];
      const fq = this.filterClasses(schema.queries);
      if (fq.length > 0) categories.push({ label: 'Queries', desc: `${fq.length}`, icon: 'symbol-namespace', children: fq.map((c) => this.buildClassNode(c)) });
      const fm = this.filterClasses(schema.mutations);
      if (fm.length > 0) categories.push({ label: 'Mutations', desc: `${fm.length}`, icon: 'symbol-namespace', children: fm.map((c) => this.buildClassNode(c)) });
      const fs = this.filterClasses(schema.subscriptions);
      if (fs.length > 0) categories.push({ label: 'Subscriptions', desc: `${fs.length}`, icon: 'symbol-namespace', children: fs.map((c) => this.buildClassNode(c)) });
      const ft = this.filterClasses(schema.types);
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

  private sendTree(): void {
    if (!this.view) return;
    const tree = this.buildTree();
    this.view.webview.postMessage({ type: 'tree', data: tree, hasFilter: !!this.filterPattern });
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
  </div>
</div>
<div id="tree" class="tree"></div>

<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('q');
const caseBtn = document.getElementById('case');
const wordBtn = document.getElementById('word');
const regexBtn = document.getElementById('regex');
const treeEl = document.getElementById('tree');

let searchState = { caseSensitive: false, wholeWord: false, useRegex: false };

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

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'c') { toggleBtn(caseBtn, 'caseSensitive'); e.preventDefault(); }
  if (e.altKey && e.key === 'w') { toggleBtn(wordBtn, 'wholeWord'); e.preventDefault(); }
  if (e.altKey && e.key === 'r') { toggleBtn(regexBtn, 'useRegex'); e.preventDefault(); }
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

  // Click handlers
  row.addEventListener('click', (e) => {
    if (hasChildren) {
      const isOpen = childrenEl.classList.toggle('open');
      twistie.textContent = isOpen ? '▾' : '▸';
      // Lazy render children
      if (isOpen && childrenEl.children.length === 0) {
        for (const child of node.children) {
          childrenEl.appendChild(buildNode(child, depth + 1, false));
        }
      }
    }
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
