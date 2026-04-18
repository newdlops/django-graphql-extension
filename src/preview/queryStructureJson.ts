import { QueryStructure, QueryStructureNode, QueryStructureArg } from '../analysis/queryStructure';

/**
 * Render a QueryStructure as beautified JSON-ish HTML: collapsible `{ … }`
 * blocks, per-field ✓/✗ markers, argument lists inline. Intended as the body
 * content pushed into the Live Query Inspector webview on each cursor move —
 * lightweight, no external libraries, uses native <details> for expand/collapse.
 */
export function renderQueryStructureJsonHtml(structure: QueryStructure): string {
  const summary = `
    <div class="summary">
      <span class="pill pill-q">✓ ${structure.queriedCount} queried</span>
      <span class="pill pill-m">✗ ${structure.totalCount - structure.queriedCount} missing</span>
      <span class="muted">of ${structure.totalCount} total fields</span>
    </div>`;

  const body = renderRoot(structure.rootField);
  return summary + `<pre class="json-tree">${body}</pre>`;
}

/**
 * Render every root field of a gql template as a single combined view. The
 * cursor-based Live Inspector uses this so the user sees the entire query
 * (not just one field) with all missing fields visible at every level.
 */
export function renderTemplateStructuresHtml(params: {
  operationKind: string;
  operationName?: string;
  structures: Array<{ structure: QueryStructure; note?: string }>;
  unresolved: Array<{ name: string; reason: string }>;
}): string {
  const aggQueried = params.structures.reduce((a, s) => a + s.structure.queriedCount, 0);
  const aggTotal = params.structures.reduce((a, s) => a + s.structure.totalCount, 0);

  const opLabel = `${params.operationKind}${params.operationName ? ' ' + escape(params.operationName) : ''}`;

  const summary = `
    <div class="summary">
      <span class="op-label">${escape(opLabel)}</span>
      <span class="pill pill-q">✓ ${aggQueried} queried</span>
      <span class="pill pill-m">✗ ${aggTotal - aggQueried} missing</span>
      <span class="muted">across ${params.structures.length} root field${params.structures.length === 1 ? '' : 's'}</span>
    </div>`;

  const blocks: string[] = [];
  for (const { structure, note } of params.structures) {
    const noteHtml = note ? `<div class="root-note">${escape(note)}</div>` : '';
    blocks.push(`${noteHtml}<pre class="json-tree">${renderRoot(structure.rootField)}</pre>`);
  }
  if (params.unresolved.length > 0) {
    blocks.push(`<div class="unresolved-section">`);
    blocks.push(`<div class="unresolved-title">Unresolved root fields</div>`);
    for (const u of params.unresolved) {
      blocks.push(`<div class="unresolved-row"><code>${escape(u.name)}</code> <span class="muted">— ${escape(u.reason)}</span></div>`);
    }
    blocks.push(`</div>`);
  }

  return summary + blocks.join('\n');
}

function renderRoot(node: QueryStructureNode): string {
  // Root: `displayName: TypeLabel { ... }`
  const hasChildren = node.children.length > 0;
  const argBlock = renderArgs(node.args);
  const header = `<span class="key key-root">${escape(node.displayName)}</span>${argBlock}: <span class="type">${escape(node.typeLabel)}</span>`;

  if (!hasChildren) return `<span class="line">${header}</span>`;

  const inner = node.children.map((c) => renderField(c, 1)).join(',\n');
  return [
    `<details open class="block block-root">`,
    `<summary><span class="line">${header} <span class="brace">{</span></span></summary>`,
    inner,
    `<span class="line indent-0"><span class="brace">}</span></span>`,
    `</details>`,
  ].join('\n');
}

function renderField(node: QueryStructureNode, depth: number): string {
  const marker = node.queried
    ? '<span class="mark mark-q">✓</span>'
    : '<span class="mark mark-m">✗</span>';
  const keyClass = node.queried ? 'key key-queried' : 'key key-missing';
  const isUnknownType =
    (node.resolvedType && !node.resolvedTypeKnown) ||
    node.typeLabel === '?' ||
    node.typeLabel.startsWith('?');
  const typeClass = isUnknownType ? 'type type-unknown' : 'type';
  const indent = indentSpan(depth);
  const argBlock = renderArgs(node.args);

  const keyLine = `${indent}${marker}<span class="${keyClass}">${escape(node.displayName)}</span>${argBlock}: `;

  // Leaf field: no children to expand.
  if (node.children.length === 0) {
    return `<span class="line ${node.queried ? 'line-q' : 'line-m'}">${keyLine}<span class="${typeClass}">${escape(node.typeLabel)}</span></span>`;
  }

  // Object/list field — collapsible. List types are surfaced with [] brackets.
  const isList = /^\[/.test(node.typeLabel);
  const open = isList ? '<span class="brace">[{</span>' : '<span class="brace">{</span>';
  const close = isList ? '<span class="brace">}]</span>' : '<span class="brace">}</span>';

  const typeTag = node.resolvedType
    ? `<span class="${typeClass}">${escape(stripBrackets(node.typeLabel))}</span>`
    : `<span class="${typeClass}">${escape(node.typeLabel)}</span>`;

  const inner = node.children.map((c) => renderField(c, depth + 1)).join(',\n');

  return [
    `<details open class="block ${node.queried ? 'block-q' : 'block-m'}">`,
    `<summary><span class="line">${keyLine}${typeTag} ${open}</span></summary>`,
    inner,
    `<span class="line">${indentSpan(depth)}${close}</span>`,
    `</details>`,
  ].join('\n');
}

function renderArgs(args: QueryStructureArg[]): string {
  if (args.length === 0) return '';
  const parts = args.map((a) => {
    const cls = a.required ? 'arg arg-req' : 'arg';
    const req = a.required ? '!' : '';
    return `<span class="${cls}">${escape(a.displayName)}: <span class="arg-type">${escape(a.type)}${req}</span></span>`;
  });
  return `<span class="args">(${parts.join(', ')})</span>`;
}

function indentSpan(depth: number): string {
  return `<span class="indent indent-${depth}">${'  '.repeat(depth)}</span>`;
}

function stripBrackets(s: string): string {
  return s.replace(/^\[/, '').replace(/\]$/, '');
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Styles shared by the live inspector webview shell. Kept as a string so the
 * shell HTML can embed them directly without any build-step magic.
 */
export const QUERY_STRUCTURE_JSON_STYLES = `
body { margin: 0; padding: 0; font-family: var(--vscode-editor-font-family, Menlo, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
.header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 5; }
.header .title { font-weight: 600; font-size: 1.05em; }
.header .subtitle { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.summary { padding: 8px 14px 4px; border-bottom: 1px dashed rgba(128,128,128,0.15); }
.pill { display: inline-block; padding: 1px 8px; margin-right: 6px; border-radius: 10px; font-size: 0.85em; }
.pill-q { background: rgba(76, 175, 80, 0.18); color: #4caf50; }
.pill-m { background: rgba(244, 67, 54, 0.18); color: #f44747; }
.muted { color: var(--vscode-descriptionForeground); }

.json-tree { margin: 0; padding: 12px 18px 22px; white-space: pre; line-height: 1.55; overflow: auto; }
.line { display: block; white-space: pre; }
.line-q { }
.line-m { opacity: 0.95; }

.indent { white-space: pre; color: transparent; user-select: none; }

.mark {
  display: inline-block; width: 20px; text-align: center;
  font-weight: bold; font-size: 1.15em; line-height: 1;
  vertical-align: middle;
}
.mark-q { color: #4caf50; }
.mark-m { color: #f44747; }

.key { font-weight: 500; }
.key-root { color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
.key-queried { color: var(--vscode-symbolIcon-propertyForeground, #75beff); }
.key-missing { color: #f44747; text-decoration: underline dotted rgba(244, 67, 54, 0.5); }

.type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }
.type-unknown { color: var(--vscode-descriptionForeground); font-style: italic; text-decoration: underline dotted; }

.args { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0 2px; }
.arg-req { color: var(--vscode-symbolIcon-variableForeground, #e06c75); font-weight: 500; }
.arg-type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }

.brace { color: var(--vscode-descriptionForeground); font-weight: 600; }

details.block { padding: 0; margin: 0; }
details.block > summary { cursor: pointer; list-style: none; display: block; }
details.block > summary::-webkit-details-marker { display: none; }
details.block > summary:before {
  content: '▾'; display: inline-block;
  width: 14px; margin-left: -16px; text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 1em; line-height: 1; vertical-align: middle;
}
details.block:not([open]) > summary:before { content: '▸'; }
details.block > summary:hover { background: var(--vscode-list-hoverBackground); }
details.block > summary:hover:before { color: var(--vscode-editor-foreground); }
details.block-m > summary .key-missing,
details.block-q > summary .key-queried { /* keep existing colors */ }

.empty { padding: 24px; color: var(--vscode-descriptionForeground); font-style: italic; text-align: center; }
.legend { padding: 8px 14px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); color: var(--vscode-descriptionForeground); font-size: 0.78em; }

.op-label { display: inline-block; padding: 1px 8px; margin-right: 8px; border-radius: 3px; font-size: 0.85em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.root-note { padding: 4px 14px 0; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.unresolved-section { margin: 14px 14px 0; padding: 8px 12px; border: 1px dashed rgba(128,128,128,0.35); border-radius: 4px; }
.unresolved-title { font-size: 0.8em; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.unresolved-row { font-size: 0.85em; }
`;
