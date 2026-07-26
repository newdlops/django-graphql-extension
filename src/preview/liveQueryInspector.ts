import * as vscode from 'vscode';
import { ClassInfo } from '../types';
import { FieldIndex, ResolutionContext } from '../codelens/gqlResolver';
import { resolveTemplateAtCursor, TemplateContext } from '../codelens/gqlCursorResolver';
import { buildQueryStructure, buildPartialStructureFromGql, buildLazySubtree, QueryStructure } from '../analysis/queryStructure';
import { renderTemplateStructuresHtml, renderJsonSubtreeHtml, QUERY_STRUCTURE_JSON_STYLES } from './queryStructureJson';
import { FragmentDef } from '../codelens/gqlCodeLensProvider';
import { isLazyExpandMessage } from '../webview/protocol';

interface StateSource {
  (): {
    classMap: Map<string, ClassInfo>;
    fieldIndex: FieldIndex;
    workspaceFragments?: Map<string, FragmentDef>;
    workspaceConstBodies?: Map<string, string>;
    resolutionContexts?: ResolutionContext[];
  };
}

/**
 * Owns the side-by-side "Live Query Inspector" webview panel. Opened via the
 * extension command, it stays open and auto-refreshes as the user moves the
 * cursor inside any gql template. Each update renders a Mermaid flowchart
 * depicting the target type's full field tree with queried/missing coloring.
 */
export class LiveQueryInspector {
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastContextKey: string | undefined;
  private lastResolutionContextId: string | undefined;
  private panelReady = false;
  private pendingMessage: unknown | undefined;
  private hasRenderedResult = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly readState: StateSource,
  ) {}

  /** Open the panel (or reveal it if already open) and render the current cursor context. */
  open(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'djangoGraphqlLiveInspector',
        'Live Query Inspector',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
      );
      this.panelReady = false;
      this.panel.webview.html = this.shellHtml();
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.panelReady = false;
        this.pendingMessage = undefined;
        this.lastContextKey = undefined;
        this.lastResolutionContextId = undefined;
        this.hasRenderedResult = false;
      });
      // Lazy expansion: the webview asks for a class's fields when the user
      // clicks the ▸ marker on a truncated subtree. We resolve against the
      // LIVE classMap so the response reflects any refreshes that happened
      // since the panel was opened.
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
        if (msg.type === 'ready' && msg.surface === 'live-query-inspector') {
          this.panelReady = true;
          if (this.pendingMessage) this.panel?.webview.postMessage(this.pendingMessage);
          return;
        }
        if (!isLazyExpandMessage(msg)) return;
        const state = this.readState();
        const classMap = state.resolutionContexts?.find(
          (ctx) => ctx.id === this.lastResolutionContextId,
        )?.classMap ?? state.classMap;
        const target = classMap.get(msg.typeName);
        if (!target) {
          this.postMessage({
            type: 'jsonSubtree',
            nodeId: msg.nodeId,
            requestId: msg.requestId,
            error: `Class '${msg.typeName}' is not in the current schema index.`,
          });
          return;
        }
        const ancestry: string[] = Array.isArray(msg.ancestry) ? msg.ancestry : [];
        // The clicked <details>'s own depth comes from data-depth. Its
        // children live one level deeper — so we start subtree rendering at
        // `depth + 1` to line up visually with siblings that would have been
        // rendered eagerly at the same level.
        const parentDepth = typeof msg.depth === 'number' ? msg.depth : 0;
        const nodes = buildLazySubtree(target, classMap, ancestry, 2);
        const html = renderJsonSubtreeHtml(nodes, [...ancestry, msg.typeName], parentDepth + 1);
        this.postMessage({ type: 'jsonSubtree', nodeId: msg.nodeId, requestId: msg.requestId, html });
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    this.refreshFromActiveEditor(true);
  }

  /** Schedule a debounced refresh triggered by a cursor or document change. */
  scheduleRefresh(): void {
    if (!this.panel) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshFromActiveEditor(false), 150);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
  }

  /** True if the side panel is currently visible — extension.ts can gate cursor events on this. */
  isOpen(): boolean {
    return this.panel !== undefined;
  }

  private refreshFromActiveEditor(force: boolean): void {
    if (!this.panel) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const cursorOffset = doc.offsetAt(editor.selection.active);
    const state = this.readState();
    const tpl = resolveTemplateAtCursor(doc.getText(), cursorOffset, {
      ...state,
      documentPath: doc.fileName,
    });
    if (!tpl) {
      this.postMessage(this.hasRenderedResult
        ? { type: 'stale', reason: 'Cursor is outside a GraphQL operation.' }
        : { type: 'empty', reason: 'Place the cursor inside a GraphQL operation to inspect its query structure.' });
      this.lastContextKey = undefined;
      this.lastResolutionContextId = undefined;
      return;
    }

    const key = templateKey(tpl);
    if (!force && key === this.lastContextKey) return;
    this.lastContextKey = key;
    this.lastResolutionContextId = tpl.resolutionContextId;

    const structures: Array<{ structure: QueryStructure; note?: string }> = [];
    const unresolved: Array<{ name: string; reason: string }> = [];
    for (const root of tpl.roots) {
      if (!root.match) {
        // No matching root field in the schema at all — keep it in the
        // unresolved bucket so the user sees they've typed something the
        // backend doesn't expose.
        unresolved.push({
          name: root.gqlField.name,
          reason: 'no matching root field in the schema',
        });
        continue;
      }

      if (root.targetClass) {
        // Best case: backend type is indexed — full expansion with missing fields.
        // Pass match.field so the root node carries its backend args.
        const structure = buildQueryStructure(root.gqlField, root.targetClass, tpl.classMap, undefined, root.match.field);
        const note = `${root.match.cls.name}.${root.match.field.name} → ${root.targetClass.name}`;
        structures.push({ structure, note });
      } else {
        // Fallback: backend type isn't in the class index (dynamic factory,
        // excluded file, etc.). Show the user's gql selection itself so the
        // panel still gives a 1:1 view; tag type labels as `?` to make the
        // uncertainty visible without hiding the query shape.
        const resolvedName = root.match.field.resolvedType;
        const structure = buildPartialStructureFromGql(root.gqlField, {
          className: root.match.cls.name,
          fieldName: root.match.field.name,
          filePath: root.match.cls.filePath,
          lineNumber: root.match.cls.lineNumber,
          resolvedTypeName: resolvedName,
          args: root.match.field.args,
        });
        const typeDesc = resolvedName ? `'${resolvedName}'` : 'unknown type';
        const note = `${root.match.cls.name}.${root.match.field.name} → ${typeDesc} — type not indexed; showing queried fields only (no missing-field analysis available).`;
        structures.push({ structure, note });
      }
    }

    const body = renderTemplateStructuresHtml({
      operationKind: tpl.operationKind,
      operationName: tpl.operationName,
      operationVariables: tpl.operationVariables,
      structures,
      unresolved,
    });

    const titleBits: string[] = [tpl.operationKind];
    if (tpl.operationName) titleBits.push(tpl.operationName);
    this.panel.title = `Live Query Inspector — ${titleBits.join(' ')}`;
    this.hasRenderedResult = true;
    this.postMessage({
      type: 'render',
      contextKey: key,
      body,
      summary: {
        operationKind: tpl.operationKind,
        operationName: tpl.operationName ?? '',
        rootCount: tpl.roots.length,
        resolvedCount: structures.length,
        unresolvedCount: unresolved.length,
      },
    });
  }

 private postMessage(msg: unknown): void {
    this.pendingMessage = msg;
    if (this.panelReady) this.panel?.webview.postMessage(msg);
 }

  private shellHtml(): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    // No external libraries — just a postMessage-driven DOM update. The body
    // HTML comes from renderQueryStructureJsonHtml on every cursor move.
    return /*html*/ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Live Query Inspector</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${QUERY_STRUCTURE_JSON_STYLES}</style>
</head><body>
<div id="header" class="header">
  <div class="title">Live Query Inspector</div>
  <div class="subtitle">Place the cursor inside a GraphQL operation to inspect its query structure.</div>
</div>
<div id="status" class="sr-only" role="status" aria-live="polite"></div>
<div class="live-tools"><button id="wrap-code" type="button" aria-pressed="false">Wrap code</button></div>
<div id="content">
  <div class="empty" role="status">No GraphQL operation under cursor yet.</div>
</div>
<details class="legend"><summary>Status key</summary><p>✓ Queried · ✗ Missing from this query · + Frontend-only · ◇ Fragment-sourced. Gray italic means the type is not in the indexed schema. Open a lazy disclosure to load deeper fields.</p></details>
<script nonce="${nonce}">
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
  const header = document.getElementById('header');
  const content = document.getElementById('content');
  const status = document.getElementById('status');
  const wrapCodeButton = document.getElementById('wrap-code');
  const savedState = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
  let wrapCode = !!savedState?.wrapCode;
  let currentContextKey = '';

  function syncWrapCode() {
    content.classList.toggle('wrap-code', wrapCode);
    wrapCodeButton.setAttribute('aria-pressed', String(wrapCode));
    if (typeof vscode.setState === 'function') vscode.setState({ wrapCode });
  }
  wrapCodeButton.addEventListener('click', () => { wrapCode = !wrapCode; syncWrapCode(); });
  syncWrapCode();

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Fire a lazy request the first time a block-lazy <details> opens. The
  // 'toggle' event doesn't bubble, so capture=true is required for delegated
  // handling across lazily-inserted descendants. Subsequent open/close cycles
  // are handled natively by <details> — no reload needed.
  content.addEventListener('toggle', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (!el.classList.contains('block-lazy') || !el.open) return;
    if (el.dataset.loaded === '1' || el.dataset.loading === '1') return;
    el.dataset.loading = '1';
    el.setAttribute('aria-busy', 'true');
    const requestId = 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    el.dataset.requestId = requestId;
    const slot = el.querySelector(':scope > .lazy-content');
    if (slot) slot.innerHTML = '<span class="line muted">  loading…</span>';
    vscode.postMessage({
      type: 'expandType',
      requestId,
      nodeId: el.dataset.nodeId,
      typeName: el.dataset.lazyType,
      ancestry: (el.dataset.ancestry || '').split(',').filter(Boolean),
      depth: Number(el.dataset.depth || '0'),
    });
  }, true);

  content.addEventListener('click', (e) => {
    const retry = e.target instanceof Element ? e.target.closest('[data-retry-lazy]') : null;
    if (!retry) return;
    const block = retry.closest('.block-lazy');
    if (!block) return;
    block.dataset.loaded = '0';
    block.dataset.loading = '0';
    block.open = false;
    block.open = true;
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'empty') {
      header.innerHTML =
        '<div class="title">Live Query Inspector</div>' +
        '<div class="subtitle">' + escapeHtml(msg.reason || 'Nothing to show.') + '</div>';
      content.innerHTML = '<div class="empty">' + escapeHtml(msg.reason || '') + '</div>';
      status.textContent = msg.reason || 'Nothing to show.';
      currentContextKey = '';
      return;
    }
    if (msg.type === 'stale') {
      header.innerHTML =
        '<div class="title">Live Query Inspector</div>' +
        '<div class="subtitle" role="status">' + escapeHtml(msg.reason || 'Showing the last query structure.') + '</div>';
      status.textContent = msg.reason || 'Showing the last query structure.';
      return;
    }
    if (msg.type === 'jsonSubtree') {
      const el = content.querySelector('[data-node-id="' + msg.nodeId + '"]');
      if (!el) return;
      const slot = el.querySelector(':scope > .lazy-content');
      if (!slot) return;
      if (msg.requestId && el.dataset.requestId !== msg.requestId) return;
      if (msg.error) {
        slot.innerHTML = '<span class="line lazy-error">  ' + escapeHtml(msg.error) + ' <button type="button" data-retry-lazy>Retry</button></span>';
        el.dataset.loading = '0';
        el.dataset.loaded = '0';
        delete el.dataset.requestId;
      } else {
        slot.innerHTML = msg.html || '';
        delete el.dataset.requestId;
      }
      el.removeAttribute('aria-busy');
      el.dataset.loaded = '1';
      el.dataset.loading = '0';
      return;
    }
    if (msg.type !== 'render') return;
    const openStates = msg.contextKey === currentContextKey
      ? Array.from(content.querySelectorAll('details')).map((detail) => detail.open)
      : [];
    content.setAttribute('aria-busy', 'true');
    const s = msg.summary;
    const opLabel = s.operationKind + (s.operationName ? ' ' + s.operationName : '');
    const resolvedLabel = s.resolvedCount + ' / ' + s.rootCount + ' root field' + (s.rootCount === 1 ? '' : 's') + ' resolved';
    header.innerHTML =
      '<div class="title">' + escapeHtml(opLabel) + '</div>' +
      '<div class="subtitle">' + escapeHtml(resolvedLabel) + (s.unresolvedCount > 0 ? ' · ' + s.unresolvedCount + ' unresolved' : '') + '</div>';
    content.innerHTML = msg.body;
    if (openStates.length > 0) {
      content.querySelectorAll('details').forEach((detail, index) => {
        if (index < openStates.length) detail.open = openStates[index];
      });
    }
    currentContextKey = msg.contextKey || '';
    content.setAttribute('aria-busy', 'false');
    status.textContent = 'Updated ' + opLabel + '.';
  });
  vscode.postMessage({ type: 'ready', surface: 'live-query-inspector' });
</script>
</body></html>`;
  }
}

function templateKey(tpl: TemplateContext): string {
  const names = tpl.roots.map((r) => `${r.gqlField.name}:${r.targetClass?.name ?? '?'}`).join(',');
  return `${tpl.resolutionContextId ?? '?'}:${tpl.operationKind}:${tpl.operationName ?? ''}@${tpl.bodyStart}[${names}]`;
}
