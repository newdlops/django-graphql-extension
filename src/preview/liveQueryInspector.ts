import * as vscode from 'vscode';
import { ClassInfo } from '../types';
import { FieldIndex } from '../codelens/gqlResolver';
import { resolveTemplateAtCursor, TemplateContext } from '../codelens/gqlCursorResolver';
import { buildQueryStructure, buildPartialStructureFromGql, QueryStructure } from '../analysis/queryStructure';
import { renderTemplateStructuresHtml, QUERY_STRUCTURE_JSON_STYLES } from './queryStructureJson';

interface StateSource {
  (): { classMap: Map<string, ClassInfo>; fieldIndex: FieldIndex };
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly readState: StateSource,
  ) {}

  /** Open the panel (or reveal it if already open) and render the current cursor context. */
  open(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'djangoGraphqlLiveInspector',
        'GraphQL Query Graph',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
      );
      this.panel.webview.html = this.shellHtml();
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.lastContextKey = undefined;
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
    const tpl = resolveTemplateAtCursor(doc.getText(), cursorOffset, state);
    if (!tpl) {
      this.postMessage({ type: 'empty', reason: 'Cursor is not inside a gql template.' });
      this.lastContextKey = undefined;
      return;
    }

    const key = templateKey(tpl);
    if (!force && key === this.lastContextKey) return;
    this.lastContextKey = key;

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
        const structure = buildQueryStructure(root.gqlField, root.targetClass, state.classMap, undefined, root.match.field);
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
      structures,
      unresolved,
    });

    const titleBits: string[] = [tpl.operationKind];
    if (tpl.operationName) titleBits.push(tpl.operationName);
    this.panel.title = `Query Structure — ${titleBits.join(' ')}`;
    this.postMessage({
      type: 'render',
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
    this.panel?.webview.postMessage(msg);
  }

  private shellHtml(): string {
    // No external libraries — just a postMessage-driven DOM update. The body
    // HTML comes from renderQueryStructureJsonHtml on every cursor move.
    return /*html*/ `<!DOCTYPE html>
<html><head>
<style>${QUERY_STRUCTURE_JSON_STYLES}</style>
</head><body>
<div id="header" class="header">
  <div class="title">Live Query Structure</div>
  <div class="subtitle">Move the cursor into a gql template to inspect the field under it.</div>
</div>
<div id="content">
  <div class="empty">No gql field under cursor yet.</div>
</div>
<div class="legend">Green ✓ = queried · Red ✗ = available but not queried · Gray italic = type not in the indexed schema · Click <code>▾</code> to collapse a block.</div>
<script>
  const header = document.getElementById('header');
  const content = document.getElementById('content');

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'empty') {
      header.innerHTML =
        '<div class="title">Live Query Structure</div>' +
        '<div class="subtitle">' + escapeHtml(msg.reason || 'Nothing to show.') + '</div>';
      content.innerHTML = '<div class="empty">' + escapeHtml(msg.reason || '') + '</div>';
      return;
    }
    if (msg.type !== 'render') return;
    const s = msg.summary;
    const opLabel = s.operationKind + (s.operationName ? ' ' + s.operationName : '');
    const resolvedLabel = s.resolvedCount + ' / ' + s.rootCount + ' root field' + (s.rootCount === 1 ? '' : 's') + ' resolved';
    header.innerHTML =
      '<div class="title">' + escapeHtml(opLabel) + '</div>' +
      '<div class="subtitle">' + escapeHtml(resolvedLabel) + (s.unresolvedCount > 0 ? ' · ' + s.unresolvedCount + ' unresolved' : '') + '</div>';
    content.innerHTML = msg.body;
  });
</script>
</body></html>`;
  }
}

function templateKey(tpl: TemplateContext): string {
  const names = tpl.roots.map((r) => `${r.gqlField.name}:${r.targetClass?.name ?? '?'}`).join(',');
  return `${tpl.operationKind}:${tpl.operationName ?? ''}@${tpl.bodyStart}[${names}]`;
}
