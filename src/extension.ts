import * as vscode from 'vscode';
import { GraphqlViewProvider } from './webview/graphqlViewProvider';
import { ParseCache } from './scanner/parseCache';
import { detectProjects } from './scanner/djangoDetector';
import { parseGrapheneSchemas } from './scanner/grapheneParser';
import { parseStrawberrySchemas } from './scanner/strawberryParser';
import { parseAriadneSchemas } from './scanner/ariadneParser';
import { parseGraphQLFiles } from './scanner/graphqlFileParser';
import { SchemaInfo } from './types';
import { log } from './logger';

export function activate(context: vscode.ExtensionContext) {
  const parseCache = new ParseCache(context.globalState);
  parseCache.load();

  const viewProvider = new GraphqlViewProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphqlViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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

  context.subscriptions.push(refreshCommand, pyWatcher, gqlWatcher);

  // Initial scan
  refresh();
}

export function deactivate() {}
