import * as vscode from 'vscode';
import { GraphqlViewProvider } from './webview/graphqlViewProvider';
import { GqlCodeLensProvider } from './codelens/gqlCodeLensProvider';
import { GqlInlayHintsProvider } from './codelens/gqlInlayHintsProvider';
import { GqlDiagnosticsManager } from './codelens/gqlDiagnostics';
import { GqlDecorationManager } from './codelens/gqlDecorations';
import { ParseCache } from './scanner/parseCache';
import { detectProjects } from './scanner/djangoDetector';
import { scanProjects } from './scanner/scanAll';
import { ClassInfo } from './types';
import { log } from './logger';
import { prepareDocumentGql } from './analysis/gqlCoverage';
import { buildQueryStructure, buildLazySubtree } from './analysis/queryStructure';
import { renderQueryStructureHtml, renderSubtreeNodesHtml } from './preview/queryStructureWebview';
import { hydrateGqlField, GqlFieldLite } from './codelens/gqlCodeLensProvider';
import { LiveQueryInspector } from './preview/liveQueryInspector';

const GQL_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function activate(context: vscode.ExtensionContext) {
  const parseCache = new ParseCache(context.globalState);
  parseCache.load();

  const viewProvider = new GraphqlViewProvider();
  const codeLensProvider = new GqlCodeLensProvider();
  const inlayHintsProvider = new GqlInlayHintsProvider(() => codeLensProvider.getSharedState());
  const diagnosticsManager = new GqlDiagnosticsManager(() => codeLensProvider.getSharedState());
  const decorationManager = new GqlDecorationManager(() => codeLensProvider.getSharedState());
  const liveInspector = new LiveQueryInspector(context.extensionUri, () => codeLensProvider.getSharedState());

  const GQL_SELECTOR: vscode.DocumentSelector = [
    { language: 'typescript', scheme: 'file' },
    { language: 'typescriptreact', scheme: 'file' },
    { language: 'javascript', scheme: 'file' },
    { language: 'javascriptreact', scheme: 'file' },
  ];

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphqlViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeLensProvider(GQL_SELECTOR, codeLensProvider),
    vscode.languages.registerHoverProvider(GQL_SELECTOR, codeLensProvider),
    vscode.languages.registerInlayHintsProvider(GQL_SELECTOR, inlayHintsProvider),
  );

  // Command to jump to a backend class definition
  const openClassCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.openClass',
    (filePath: string, lineNumber: number) => {
      const uri = vscode.Uri.file(filePath);
      vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(lineNumber, 0, lineNumber, 0),
      });
    },
  );

  const showMissingFieldsCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.showMissingFields',
    (typeName: string, gqlFieldLite: GqlFieldLite, ownerClsName?: string, ownerFieldName?: string) => {
      const { classMap } = codeLensProvider.getSharedState();
      const cls = classMap.get(typeName);
      if (!cls) {
        vscode.window.showInformationMessage(`Django GraphQL: class '${typeName}' not in the current schema index.`);
        return;
      }
      const gf = hydrateGqlField(gqlFieldLite);
      // Look up the backend field that the user clicked so its args render on
      // the root of the Query Structure panel.
      const ownerCls = ownerClsName ? classMap.get(ownerClsName) : undefined;
      const rootFieldInfo = ownerCls && ownerFieldName
        ? ownerCls.fields.find((f) => f.name === ownerFieldName)
        : undefined;
      const structure = buildQueryStructure(gf, cls, classMap, undefined, rootFieldInfo);
      const panel = vscode.window.createWebviewPanel(
        'queryStructure',
        `${gf.name} — ${typeName}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = renderQueryStructureHtml(
        structure,
        `Expand all fields & args on ${typeName}. Red rows are available but not queried — add them to your gql to include the data.`,
      );

      // Lazy expansion: the webview asks for a subtree whenever the user clicks
      // the ▸ marker on a node that wasn't expanded in the initial render
      // (depth cap or cycle guard). We resolve against the CURRENT classMap
      // so the panel reflects any refreshes since it was opened.
      panel.webview.onDidReceiveMessage((msg) => {
        if (!msg || msg.type !== 'expandType') return;
        const { classMap: currentClassMap } = codeLensProvider.getSharedState();
        const target = currentClassMap.get(msg.typeName);
        if (!target) {
          panel.webview.postMessage({
            type: 'subtree',
            nodeId: msg.nodeId,
            error: `Class '${msg.typeName}' is not in the current schema index.`,
          });
          return;
        }
        const ancestry: string[] = Array.isArray(msg.ancestry) ? msg.ancestry : [];
        const nodes = buildLazySubtree(target, currentClassMap, ancestry, 2);
        const html = renderSubtreeNodesHtml(nodes, [...ancestry, msg.typeName]);
        panel.webview.postMessage({ type: 'subtree', nodeId: msg.nodeId, html });
      });
    },
  );

  let refreshing = false;
  let pendingRefresh = false;

  async function refresh(): Promise<void> {
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    try {
      await doRefresh();
    } finally {
      refreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        refresh();
      }
    }
  }

  async function doRefresh(): Promise<void> {
    const projects = await detectProjects();
    const allSchemas = await scanProjects(projects, parseCache);

    log(`[refresh] === SCHEMAS (${allSchemas.length}) ===`);
    for (const schema of allSchemas) {
      log(`[refresh]   ${schema.name}: Q=${schema.queries.length} M=${schema.mutations.length} T=${schema.types.length}`);
    }

    viewProvider.updateSchemas(allSchemas);

    // Build classMap for CodeLens
    const classMap = new Map<string, ClassInfo>();
    for (const schema of allSchemas) {
      for (const cls of [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types]) {
        classMap.set(cls.name, cls);
      }
    }
    codeLensProvider.updateIndex(classMap);
    // After the CodeLens index's debounced rebuild, poke the InlayHints
    // provider so it re-queries getSharedState() and repaints.
    setTimeout(() => inlayHintsProvider.refresh(), 250);
  }

  const refreshCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.refresh',
    () => refresh(),
  );

  // Drops every cached file entry from globalState and re-runs a full scan.
  // Exposed both as a command and via the view title bar so users can force
  // a fresh parse after upgrading the extension, editing outside VS Code,
  // or when a stale result looks suspicious. Reports how many entries were
  // invalidated so the user confirms something actually happened.
  const clearCacheCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.clearCache',
    async () => {
      const previousSize = parseCache.size();
      await parseCache.clearAll();
      vscode.window.showInformationMessage(
        previousSize === 0
          ? 'Django GraphQL: parse cache was already empty. Re-scanning…'
          : `Django GraphQL: cleared ${previousSize} cached file entr${previousSize === 1 ? 'y' : 'ies'}. Re-scanning…`,
      );
      await refresh();
    },
  );

  const openLiveInspectorCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.openLiveInspector',
    () => liveInspector.open(),
  );

  const inspectTypeCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.inspectType',
    async () => {
      const classes = viewProvider.listInspectableClasses();
      if (classes.length === 0) {
        vscode.window.showInformationMessage('Django GraphQL: no schemas loaded yet. Run refresh first.');
        return;
      }
      const sorted = [...classes].sort((a, b) => {
        if (a.kind !== b.kind) {
          const rank = (k: string) => (k === 'query' ? 0 : k === 'mutation' ? 1 : k === 'subscription' ? 2 : 3);
          return rank(a.kind) - rank(b.kind);
        }
        return a.name.localeCompare(b.name);
      });
      const picked = await vscode.window.showQuickPick(
        sorted.map((c) => ({
          label: c.name,
          description: `[${c.kind}] ${c.fieldCount} field${c.fieldCount === 1 ? '' : 's'}`,
          detail: c.filePath,
          className: c.name,
        })),
        { title: 'Inspect GraphQL type', matchOnDescription: true, matchOnDetail: true, placeHolder: 'Type a class name…' },
      );
      if (picked) viewProvider.showInspectorForClass(picked.className);
    },
  );

  // Watch for Python and GraphQL file changes
  const pyWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const gqlWatcher = vscode.workspace.createFileSystemWatcher('**/*.{graphql,gql}');

  let refreshTimeout: NodeJS.Timeout | undefined;
  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => refresh(), 500);
  };

  pyWatcher.onDidChange(debouncedRefresh);
  pyWatcher.onDidCreate(debouncedRefresh);
  pyWatcher.onDidDelete(debouncedRefresh);
  gqlWatcher.onDidChange(debouncedRefresh);
  gqlWatcher.onDidCreate(debouncedRefresh);
  gqlWatcher.onDidDelete(debouncedRefresh);

  // --- Active editor watcher — feeds gql coverage to the Inspector panel
  //     AND schedules diagnostic refresh for the focused document.
  let coverageTimeout: NodeJS.Timeout | undefined;
  const pushCoverage = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !GQL_LANGUAGES.has(editor.document.languageId)) {
      viewProvider.setActiveGqlBodies([]);
      return;
    }
    const { bodies, fragments } = prepareDocumentGql(editor.document.getText());
    viewProvider.setActiveGqlBodies(bodies, fragments);
    diagnosticsManager.scheduleRefresh(editor.document);
    decorationManager.scheduleRefresh(editor);
    liveInspector.scheduleRefresh();
  };
  const debouncedCoverage = () => {
    if (coverageTimeout) clearTimeout(coverageTimeout);
    coverageTimeout = setTimeout(pushCoverage, 250);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => pushCoverage()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const active = vscode.window.activeTextEditor?.document;
      if (active && e.document === active) debouncedCoverage();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) liveInspector.scheduleRefresh();
    }),
    diagnosticsManager,
    decorationManager,
    liveInspector,
  );
  pushCoverage();

  context.subscriptions.push(refreshCommand, clearCacheCommand, inspectTypeCommand, openLiveInspectorCommand, openClassCommand, showMissingFieldsCommand, pyWatcher, gqlWatcher);

  // Initial scan
  refresh();
}

export function deactivate() {}
