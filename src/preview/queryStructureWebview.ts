import { QueryStructure, QueryStructureNode, QueryStructureArg } from '../analysis/queryStructure';

/**
 * Render state threaded through recursive rendering: produces unique DOM ids
 * for every node so the client can find and replace placeholders on lazy
 * expand responses, and tracks the ancestry chain of resolved types so the
 * server-side cycle guard can be reapplied on further expansions.
 */
interface RenderState {
  nextId: number;
  ancestry: string[];
}

/**
 * Render the Query Structure webview HTML. Shows the full target-type tree
 * with color-coded queried vs missing fields so the developer can see at a
 * glance what else they could add to an existing gql query. Nodes whose type
 * was not expanded (depth cap or cycle guard) render a collapsed lazy-load
 * twistie that fetches the deeper subtree from the extension on demand.
 */
export function renderQueryStructureHtml(structure: QueryStructure, subtitle?: string): string {
  const rootArgsHtml = renderHeaderArgs(structure.rootField.args);
  const frontendOnlyPill = structure.frontendOnlyCount > 0
    ? `<span class="pill pill-frontend-only">+ ${structure.frontendOnlyCount} frontend-only</span>`
    : '';
  // Walk the tree once to figure out how many distinct fragments fed the
  // selection — shown as a summary pill so the user immediately sees that
  // "this much of my query came via fragments".
  const fragNames = new Set<string>();
  let fragCount = 0;
  const walk = (n: QueryStructureNode) => {
    for (const c of n.children) {
      if (c.fromFragment && c.queried && !c.frontendOnly) {
        fragNames.add(c.fromFragment);
        fragCount++;
      }
      walk(c);
    }
  };
  walk(structure.rootField);
  const fragmentPill = fragCount > 0
    ? `<span class="pill pill-fragment" title="${[...fragNames].join(', ')}">◇ ${fragCount} via ${fragNames.size} fragment${fragNames.size === 1 ? '' : 's'}</span>`
    : '';
  const header = `
    <div class="header">
      <div class="title">${escape(structure.rootField.displayName)}${rootArgsHtml}
        <span class="type-chip">${escape(structure.rootTypeName)}</span>
      </div>
      ${subtitle ? `<div class="subtitle">${escape(subtitle)}</div>` : ''}
      <div class="summary">
        <span class="pill pill-queried">✓ ${structure.queriedCount} queried</span>
        <span class="pill pill-missing">✗ ${structure.totalCount - structure.queriedCount} missing</span>
        ${frontendOnlyPill}
        ${fragmentPill}
        <span class="muted">of ${structure.totalCount} total fields</span>
      </div>
    </div>`;

  const state: RenderState = { nextId: 0, ancestry: [structure.rootTypeName] };
  const body = renderNode(structure.rootField, 0, true, state);

  return /*html*/ `<!DOCTYPE html><html><head><style>
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-editor-font-family, Menlo, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  margin: 0; padding: 0;
}
.header {
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
  position: sticky; top: 0;
  background: var(--vscode-editor-background);
  z-index: 5;
}
.header .title { font-size: 1.3em; font-weight: 600; line-height: 1.45; }
.header-args {
  display: inline-block;
  margin-left: 4px;
  padding: 2px 6px;
  font-family: var(--vscode-editor-font-family, Menlo, monospace);
  font-size: 0.72em;
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
  border-radius: 3px;
  vertical-align: middle;
  max-width: 100%;
  word-break: break-word;
  white-space: normal;
}
.header .subtitle { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.header .summary { margin-top: 8px; display: flex; gap: 6px; align-items: center; font-size: 0.85em; }
.type-chip {
  display: inline-block; margin-left: 8px;
  padding: 1px 7px; border-radius: 3px; font-size: 0.7em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  vertical-align: middle;
}
.pill {
  display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85em;
}
.pill-queried { background: rgba(76, 175, 80, 0.18); color: #4caf50; }
.pill-missing { background: rgba(244, 67, 54, 0.18); color: #f44747; }
.pill-frontend-only { background: rgba(55, 148, 255, 0.18); color: #3794ff; }
.pill-fragment { background: rgba(198, 120, 221, 0.18); color: #c678dd; }
.muted { color: var(--vscode-descriptionForeground); }

.tree { padding: 8px 12px 24px; }
.row {
  display: block;
  padding: 4px 4px 4px 0;
  border-left: 2px solid transparent;
  margin-left: 2px;
  line-height: 1.55;
}
.row.queried { border-left-color: #4caf50; background: rgba(76, 175, 80, 0.06); }
.row.missing { border-left-color: #f44747; background: rgba(244, 67, 54, 0.07); }
.row.frontend-only { border-left-color: #3794ff; background: rgba(55, 148, 255, 0.08); }
.row.fragment { border-left-color: #c678dd; background: rgba(198, 120, 221, 0.08); }
.row.unknown-type { opacity: 0.7; font-style: italic; }
.row.frontend-only.unknown-type { opacity: 1; font-style: normal; }
.row:hover { background: var(--vscode-list-hoverBackground); }

.marker {
  display: inline-block; width: 22px; text-align: center;
  font-weight: bold; font-size: 1.15em; line-height: 1;
  vertical-align: middle;
}
.marker.queried { color: #4caf50; }
.marker.missing { color: #f44747; }
.marker.frontend-only { color: #3794ff; }
.marker.fragment { color: #c678dd; }
.marker.unknown { color: var(--vscode-descriptionForeground); }

.field-name { font-weight: 500; }
.field-name.missing { color: #f44747; }
.field-name.frontend-only { color: #3794ff; }
.field-name.fragment { color: #c678dd; }
.fragment-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(198, 120, 221, 0.18);
  color: #c678dd;
  font-size: 0.72em;
  font-weight: 500;
  vertical-align: middle;
  line-height: 1.5;
}
.snake { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }
.type.clickable { cursor: pointer; text-decoration: underline dashed; }
.type.frontend-only { color: #3794ff; }

.args {
  display: inline-block; margin-left: 6px; padding: 0 4px;
  color: var(--vscode-descriptionForeground); font-size: 0.88em;
}
.arg { white-space: nowrap; }
.arg.required { color: var(--vscode-symbolIcon-variableForeground, #e06c75); font-weight: 500; }
.arg.frontend-only { color: #3794ff; }
.arg-type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }
.arg-type.frontend-only { color: #3794ff; }

.children { margin-left: 22px; border-left: 1px dashed rgba(128,128,128,0.25); padding-left: 6px; }
.hidden { display: none; }

.twistie {
  display: inline-block; width: 18px; text-align: center;
  cursor: pointer; user-select: none;
  color: var(--vscode-descriptionForeground);
  font-size: 1.1em; line-height: 1;
  vertical-align: middle;
}
.twistie:hover { color: var(--vscode-editor-foreground); }
.twistie.empty { visibility: hidden; }
.twistie.lazy { color: var(--vscode-textLink-foreground, #3794ff); font-weight: 600; }
.twistie.loading { opacity: 0.5; }
.lazy-hint { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-style: italic; margin-left: 4px; }
.lazy-error { color: #f44747; font-size: 0.82em; margin-left: 4px; }

.legend { padding: 8px 20px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); color: var(--vscode-descriptionForeground); font-size: 0.8em; }
</style></head><body>
${header}
<div class="tree">${body}</div>
<div class="legend">Green = queried directly · <span style="color:#c678dd">Purple</span> = queried via a named fragment · Red = available on the backend but missing from your gql · Gray italic = type not in the indexed schema · <span class="lazy-hint">▸</span> = click to load deeper fields lazily</div>
<script>
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };

  function bindTwisties(root) {
    root.querySelectorAll('.twistie:not(.empty)').forEach((el) => {
      if (el.dataset.bound === '1') return;
      el.dataset.bound = '1';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.classList.contains('lazy') && el.dataset.loaded !== '1') {
          requestLazyExpand(el);
          return;
        }
        const target = el.parentElement && el.parentElement.nextElementSibling;
        if (target && target.classList.contains('children')) {
          const hidden = target.classList.toggle('hidden');
          el.textContent = hidden ? '▸' : '▾';
        }
      });
    });
  }

  function requestLazyExpand(twistie) {
    const row = twistie.closest('.row');
    if (!row) return;
    const nodeId = row.dataset.nodeId;
    const typeName = row.dataset.lazyType;
    const ancestry = row.dataset.ancestry || '';
    if (!typeName) return;
    twistie.classList.add('loading');
    vscode.postMessage({
      type: 'expandType',
      nodeId,
      typeName,
      ancestry: ancestry.split(',').filter(Boolean),
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'subtree') return;
    const row = document.querySelector('[data-node-id="' + msg.nodeId + '"]');
    if (!row) return;
    const twistie = row.querySelector('.twistie');
    if (twistie) {
      twistie.classList.remove('loading');
      twistie.classList.remove('lazy');
      twistie.dataset.loaded = '1';
      twistie.textContent = '▾';
    }
    // Remove the "click to load" hint once we have real content.
    const hint = row.querySelector('.lazy-hint');
    if (hint) hint.remove();
    if (msg.error) {
      const err = document.createElement('span');
      err.className = 'lazy-error';
      err.textContent = msg.error;
      row.appendChild(err);
      return;
    }
    const container = document.createElement('div');
    container.className = 'children';
    container.innerHTML = msg.html || '';
    row.insertAdjacentElement('afterend', container);
    bindTwisties(container);
  });

  bindTwisties(document);
})();
</script>
</body></html>`;
}

function renderNode(node: QueryStructureNode, depth: number, isRoot: boolean, state: RenderState): string {
  if (isRoot) {
    // For the root (the field the user clicked), show only its children — the
    // header already describes the root itself.
    if (node.children.length === 0 && !node.hasMoreChildren) {
      return '<div class="muted">No fields to show.</div>';
    }
    return node.children.map((c) => renderNode(c, 0, false, state)).join('');
  }

  const hasChildren = node.children.length > 0;
  const isLazy = !hasChildren && node.hasMoreChildren;
  const viaFragment = !!node.fromFragment && node.queried && !node.frontendOnly;
  const rowClasses = ['row'];
  if (node.frontendOnly) rowClasses.push('frontend-only');
  else if (viaFragment) rowClasses.push('fragment');
  else if (node.queried) rowClasses.push('queried');
  else rowClasses.push('missing');
  if (node.resolvedType && !node.resolvedTypeKnown) rowClasses.push('unknown-type');

  const marker = node.frontendOnly
    ? '<span class="marker frontend-only">+</span>'
    : viaFragment
      ? '<span class="marker fragment">◇</span>'
      : node.queried
        ? '<span class="marker queried">✓</span>'
        : '<span class="marker missing">✗</span>';
  let twistie: string;
  if (hasChildren) {
    twistie = '<span class="twistie">▾</span>';
  } else if (isLazy) {
    twistie = '<span class="twistie lazy" title="Expand to inspect deeper fields">▸</span>';
  } else {
    twistie = '<span class="twistie empty">·</span>';
  }

  const displaySnake = node.name !== node.displayName
    ? ` <span class="snake">(${escape(node.name)})</span>`
    : '';

  const typeClass = node.frontendOnly
    ? 'type frontend-only'
    : node.resolvedTypeKnown ? 'type clickable' : 'type';
  const typeLabel = escape(node.typeLabel);

  const args = renderArgs(node.args);

  const nodeId = state.nextId++;

  // Lazy nodes need their type name + ancestry so the extension can rebuild a
  // cycle-safe subtree on demand.
  const lazyAttrs = isLazy && node.resolvedType
    ? ` data-lazy-type="${escape(node.resolvedType)}" data-ancestry="${escape(state.ancestry.join(','))}"`
    : '';
  const lazyHint = isLazy ? ' <span class="lazy-hint">click ▸ to load</span>' : '';

  let children = '';
  if (hasChildren) {
    // Push the resolved type onto the ancestry chain so any deeper lazy nodes
    // know which classes are already in view when requesting expansion.
    if (node.resolvedType) state.ancestry.push(node.resolvedType);
    children = `<div class="children">${node.children.map((c) => renderNode(c, depth + 1, false, state)).join('')}</div>`;
    if (node.resolvedType) state.ancestry.pop();
  }

  const fieldClass = node.frontendOnly
    ? 'field-name frontend-only'
    : viaFragment
      ? 'field-name fragment'
      : node.queried ? 'field-name' : 'field-name missing';

  const fragmentBadge = viaFragment
    ? ` <span class="fragment-badge" title="Queried via \`...${escape(node.fromFragment!)}\` spread">${escape(node.fromFragment!)}</span>`
    : '';

  return `<div class="${rowClasses.join(' ')}" data-node-id="${nodeId}"${lazyAttrs}>
    ${twistie}${marker}<span class="${fieldClass}">${escape(node.displayName)}</span>${displaySnake}:
    <span class="${typeClass}">${typeLabel}</span>${fragmentBadge}${args}${lazyHint}
  </div>${children}`;
}

/**
 * Render a list of sibling nodes as HTML — used by the extension to answer a
 * lazy-expand request. Reuses the same markup as the initial render so the
 * client can just `insertAdjacentElement` the resulting fragment.
 */
export function renderSubtreeNodesHtml(nodes: QueryStructureNode[], ancestry: string[]): string {
  const state: RenderState = { nextId: Date.now() & 0xffff, ancestry: [...ancestry] };
  return nodes.map((n) => renderNode(n, 0, false, state)).join('');
}

function renderArgs(args: QueryStructureArg[]): string {
  if (args.length === 0) return '';
  const parts = args.map((a) => {
    const cls = a.frontendOnly ? 'arg frontend-only' : a.required ? 'arg required' : 'arg';
    const req = a.required ? '!' : '';
    const typeCls = a.frontendOnly ? 'arg-type frontend-only' : 'arg-type';
    return `<span class="${cls}">${escape(a.displayName)}: <span class="${typeCls}">${escape(a.type)}${req}</span></span>`;
  });
  return `<span class="args">(${parts.join(', ')})</span>`;
}

/**
 * Args on the root row live in the header title, so they get a bit more
 * breathing room (inline-block, wrapping allowed). Same visual language as
 * the inline arg pills on regular rows but laid out to survive long lists
 * like `rtccEmailList(companyId: ID!, rightToConsentOrConsultId: ID!, page: Int, perPage: Int)`.
 */
function renderHeaderArgs(args: QueryStructureArg[]): string {
  if (args.length === 0) return '';
  const parts = args.map((a) => {
    const cls = a.frontendOnly ? 'arg frontend-only' : a.required ? 'arg required' : 'arg';
    const req = a.required ? '!' : '';
    const typeCls = a.frontendOnly ? 'arg-type frontend-only' : 'arg-type';
    return `<span class="${cls}">${escape(a.displayName)}: <span class="${typeCls}">${escape(a.type)}${req}</span></span>`;
  });
  return `<span class="header-args">(${parts.join(', ')})</span>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
