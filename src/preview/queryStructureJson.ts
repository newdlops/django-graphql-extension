import { QueryStructure, QueryStructureNode, QueryStructureArg } from '../analysis/queryStructure';

/**
 * Per-render state threaded through `renderRoot` / `renderField` — produces
 * unique DOM ids for lazy-expand placeholders and tracks the ancestry chain
 * of resolved types so deeper lazy requests can reapply the cycle guard.
 */
interface RenderState {
  nextId: number;
  ancestry: string[];
}

/**
 * Render a QueryStructure as beautified JSON-ish HTML: collapsible `{ … }`
 * blocks, per-field ✓/✗ markers, argument lists inline. Intended as the body
 * content pushed into the Live Query Inspector webview on each cursor move —
 * lightweight, no external libraries, uses native <details> for expand/collapse.
 * Fields that hit the depth cap (`hasMoreChildren=true`) render a lazy
 * ▸ expand marker; the shell's JS intercepts the click and posts a message
 * back to the extension to fetch the deeper subtree.
 */
export function renderQueryStructureJsonHtml(structure: QueryStructure): string {
  const summary = `
    <div class="summary">
      <span class="pill pill-q">✓ ${structure.queriedCount} queried</span>
      <span class="pill pill-m">✗ ${structure.totalCount - structure.queriedCount} missing</span>
      <span class="muted">of ${structure.totalCount} total fields</span>
    </div>`;

  const state: RenderState = { nextId: 0, ancestry: [structure.rootTypeName] };
  const body = renderRoot(structure.rootField, state);
  return summary + `<pre class="json-tree">${body}</pre>`;
}

/** Same shape as `OperationVariable` in gqlCursorResolver, re-declared here
 *  so queryStructureJson doesn't take a hard dependency on cursor-resolver. */
export interface TemplateOperationVariable {
  name: string;
  type: string;
  required: boolean;
  list: boolean;
  defaultValue?: string;
}

/**
 * Render every root field of a gql template as a single combined view. The
 * cursor-based Live Inspector uses this so the user sees the entire query
 * (not just one field) with all missing fields visible at every level.
 */
export function renderTemplateStructuresHtml(params: {
  operationKind: string;
  operationName?: string;
  operationVariables?: TemplateOperationVariable[];
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
    </div>${renderOperationVariables(params.operationVariables ?? [])}`;

  const blocks: string[] = [];
  // Per-literal nextId sequence, so each <pre class="json-tree"> block owns
  // its own DOM id space. The upper 16 bits disambiguate blocks from each
  // other in case a lazy response referencing one block lands in the DOM
  // before another block finishes rendering.
  let blockIndex = 0;
  for (const { structure, note } of params.structures) {
    const noteHtml = note ? `<div class="root-note">${escape(note)}</div>` : '';
    const state: RenderState = { nextId: blockIndex << 16, ancestry: [structure.rootTypeName] };
    blocks.push(`${noteHtml}<pre class="json-tree">${renderRoot(structure.rootField, state)}</pre>`);
    blockIndex++;
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

function renderRoot(node: QueryStructureNode, state: RenderState): string {
  // Root: `displayName: TypeLabel { ... }`
  const hasChildren = node.children.length > 0;
  const argBlock = renderArgs(node.args);
  const header = `<span class="key key-root">${escape(node.displayName)}</span>${argBlock}: <span class="type">${escape(node.typeLabel)}</span>`;

  if (!hasChildren) return `<span class="line">${header}</span>`;

  const inner = node.children.map((c) => renderField(c, 1, state)).join(',\n');
  return [
    `<details open class="block block-root">`,
    `<summary><span class="line">${header} <span class="brace">{</span></span></summary>`,
    inner,
    `<span class="line indent-0"><span class="brace">}</span></span>`,
    `</details>`,
  ].join('\n');
}

function renderField(node: QueryStructureNode, depth: number, state: RenderState): string {
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
  const isList = /^\[/.test(node.typeLabel);
  const hasChildren = node.children.length > 0;
  const isLazy = !hasChildren && node.hasMoreChildren && !!node.resolvedType;

  // Leaf field: no children to expand AND no lazy handle.
  if (!hasChildren && !isLazy) {
    return `<span class="line ${node.queried ? 'line-q' : 'line-m'}">${keyLine}<span class="${typeClass}">${escape(node.typeLabel)}</span></span>`;
  }

  // Object/list field — collapsible. List types are surfaced with [] brackets.
  const open = isList ? '<span class="brace">[{</span>' : '<span class="brace">{</span>';
  const close = isList ? '<span class="brace">}]</span>' : '<span class="brace">}</span>';

  const typeTag = node.resolvedType
    ? `<span class="${typeClass}">${escape(stripBrackets(node.typeLabel))}</span>`
    : `<span class="${typeClass}">${escape(node.typeLabel)}</span>`;

  // Lazy block: same `<details>` shape as a fully-expanded block, but starts
  // closed and carries `data-lazy-*` attributes that the shell's toggle
  // listener uses to fetch the inner subtree on first open. Keeping the
  // structure identical to the expanded case is what makes the lazy-loaded
  // content align (indent + line spacing) with the surrounding tree.
  if (isLazy) {
    const nodeId = state.nextId++;
    const ancestryAttr = escape(state.ancestry.join(','));
    return [
      `<details class="block block-lazy ${node.queried ? 'block-q' : 'block-m'}" data-node-id="${nodeId}" data-lazy-type="${escape(node.resolvedType!)}" data-ancestry="${ancestryAttr}" data-depth="${depth}">`,
      `<summary><span class="line">${keyLine}${typeTag} ${open}</span></summary>`,
      `<div class="lazy-content"></div>`,
      `<span class="line">${indentSpan(depth)}${close}</span>`,
      `</details>`,
    ].join('\n');
  }

  // Push the resolved class onto the ancestry chain so any deeper lazy
  // markers emitted inside the children carry the full cycle-guard context.
  if (node.resolvedType) state.ancestry.push(node.resolvedType);
  const inner = node.children.map((c) => renderField(c, depth + 1, state)).join(',\n');
  if (node.resolvedType) state.ancestry.pop();

  return [
    `<details open class="block ${node.queried ? 'block-q' : 'block-m'}">`,
    `<summary><span class="line">${keyLine}${typeTag} ${open}</span></summary>`,
    inner,
    `<span class="line">${indentSpan(depth)}${close}</span>`,
    `</details>`,
  ].join('\n');
}

/**
 * Render the response to a lazy-expand request as an HTML fragment that the
 * shell JS drops into a `.lazy-content` slot inside the already-rendered
 * `<details class="block-lazy">` wrapper. `startDepth` is the *child* indent
 * level — i.e., one deeper than the clicked field's own depth — so the new
 * lines align with siblings they'd have had if they were rendered eagerly.
 */
export function renderJsonSubtreeHtml(
  nodes: QueryStructureNode[],
  ancestry: string[],
  startDepth: number,
): string {
  // Use a unique-ish starting id so these nodes don't collide with the
  // initial render's ids in the same document. Collision would make
  // `document.querySelector` pick the wrong row on further expansion.
  const state: RenderState = { nextId: Date.now() & 0xffffff, ancestry: [...ancestry] };
  return nodes.map((n) => renderField(n, startDepth, state)).join(',\n');
}

/**
 * Render the operation-level variables block that appears at the top of the
 * Live Inspector. Surfaces the exact same signature the user wrote, so they
 * can verify at a glance what the gql operation accepts — e.g.
 *     query RtccEmailList(
 *       $companyId: ID!
 *       $rightToConsentOrConsultId: ID!
 *       $page: Int
 *       $perPage: Int
 *     )
 * This complements the per-field arg list rendered next to each root field.
 */
function renderOperationVariables(vars: TemplateOperationVariable[]): string {
  if (vars.length === 0) return '';
  const rows = vars
    .map((v) => {
      const reqMark = v.required ? '!' : '';
      const typeText = v.list ? `[${escape(v.type)}]${reqMark}` : `${escape(v.type)}${reqMark}`;
      const def = v.defaultValue ? ` <span class="opvar-default">= ${escape(v.defaultValue)}</span>` : '';
      return `    <span class="opvar"><span class="opvar-name">$${escape(v.name)}</span>: <span class="opvar-type">${typeText}</span>${def}</span>`;
    })
    .join(',\n');
  return `
    <div class="op-variables">
      <div class="op-variables-title">Variables (${vars.length})</div>
      <pre class="op-variables-body">(\n${rows}\n)</pre>
    </div>`;
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

/* Lazy <details> wrapper — starts collapsed; the summary's ▸ chevron doubles
   as the affordance. Tint the chevron so users notice it triggers a load on
   the first open. */
details.block-lazy > summary:before { color: var(--vscode-textLink-foreground, #3794ff); }
details.block-lazy > summary:hover:before { color: var(--vscode-editor-foreground); }
.lazy-content { display: block; }
.lazy-error { color: #f44747; font-size: 0.82em; margin-left: 6px; }

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
.op-variables { margin: 8px 14px 0; padding: 6px 10px; border: 1px dashed rgba(128,128,128,0.3); border-radius: 4px; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.05)); }
.op-variables-title { font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.op-variables-body { margin: 0; font-family: var(--vscode-editor-font-family, Menlo, monospace); font-size: 0.9em; white-space: pre; color: var(--vscode-editor-foreground); }
.opvar { display: inline; }
.opvar-name { color: var(--vscode-symbolIcon-variableForeground, #e06c75); font-weight: 500; }
.opvar-type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }
.opvar-default { color: var(--vscode-descriptionForeground); font-style: italic; }
.root-note { padding: 4px 14px 0; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.unresolved-section { margin: 14px 14px 0; padding: 8px 12px; border: 1px dashed rgba(128,128,128,0.35); border-radius: 4px; }
.unresolved-title { font-size: 0.8em; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.unresolved-row { font-size: 0.85em; }
`;
