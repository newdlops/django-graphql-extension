import * as vscode from 'vscode';
import { GraphqlViewProvider } from './webview/graphqlViewProvider';
import { GqlCodeLensProvider } from './codelens/gqlCodeLensProvider';
import { ParseCache } from './scanner/parseCache';
import { detectProjects } from './scanner/djangoDetector';
import { parseGrapheneSchemas } from './scanner/grapheneParser';
import { parseStrawberrySchemas } from './scanner/strawberryParser';
import { parseAriadneSchemas } from './scanner/ariadneParser';
import { parseGraphQLFiles } from './scanner/graphqlFileParser';
import { SchemaInfo, ClassInfo } from './types';
import { log } from './logger';

export function activate(context: vscode.ExtensionContext) {
  const parseCache = new ParseCache(context.globalState);
  parseCache.load();

  const viewProvider = new GraphqlViewProvider();
  const codeLensProvider = new GqlCodeLensProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphqlViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'typescript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'javascript', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
      ],
      codeLensProvider,
    ),
    vscode.languages.registerHoverProvider(
      [
        { language: 'typescript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'javascript', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
      ],
      codeLensProvider,
    ),
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
    (typeName: string, used: string[], missing: { name: string; type: string }[]) => {
      const panel = vscode.window.createWebviewPanel(
        'missingFields', `Missing fields — ${typeName}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      );
      const usedHtml = used.map((n) => `<div class="field used">${n}</div>`).join('');
      const missingHtml = missing.map((f) =>
        `<div class="field missing">${f.name}<span class="type">${f.type}</span></div>`
      ).join('');
      panel.webview.html = [
        '<!DOCTYPE html><html><head><style>',
        'body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 16px; }',
        'h2 { font-size: 14px; margin: 0 0 8px; color: var(--vscode-foreground); }',
        '.summary { margin-bottom: 16px; color: var(--vscode-descriptionForeground); }',
        '.section { margin-bottom: 16px; }',
        '.section-title { font-weight: bold; margin-bottom: 4px; }',
        '.field { padding: 2px 8px; font-family: inherit; }',
        '.used { opacity: 0.5; }',
        '.used::before { content: "✓ "; color: #4ec9b0; }',
        '.missing { }',
        '.missing::before { content: "✗ "; color: #f44747; }',
        '.type { margin-left: 8px; color: var(--vscode-descriptionForeground); }',
        '.type::before { content: ": "; }',
        '</style></head><body>',
        `<h2>${typeName}</h2>`,
        `<div class="summary">${used.length} queried, ${missing.length} available but not queried</div>`,
        `<div class="section"><div class="section-title">Queried (${used.length})</div>${usedHtml}</div>`,
        `<div class="section"><div class="section-title">Not queried (${missing.length})</div>${missingHtml}</div>`,
        '</body></html>',
      ].join('\n');
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
    const allSchemas: SchemaInfo[] = [];

    for (const project of projects) {
      const parsers: Promise<SchemaInfo[]>[] = [];
      for (const framework of project.frameworks) {
        switch (framework) {
          case 'graphene':
            parsers.push(parseGrapheneSchemas(project.rootDir, parseCache));
            break;
          case 'strawberry':
            parsers.push(parseStrawberrySchemas(project.rootDir));
            break;
          case 'ariadne':
            parsers.push(parseAriadneSchemas(project.rootDir));
            break;
          case 'graphql-schema':
            parsers.push(parseGraphQLFiles(project.rootDir));
            break;
        }
      }
      const results = await Promise.all(parsers);
      for (const schemas of results) {
        allSchemas.push(...schemas);
      }
    }

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
  }

  const refreshCommand = vscode.commands.registerCommand(
    'djangoGraphqlExplorer.refresh',
    () => refresh(),
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

  context.subscriptions.push(refreshCommand, openClassCommand, showMissingFieldsCommand, pyWatcher, gqlWatcher);

  // Initial scan
  refresh();
}

export function deactivate() {}
