import { mkdir, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(tmpdir(), 'django-graphql-explorer-ui-fixtures');
const originalLoad = Module._load;

Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      Uri: {
        file: (fsPath) => ({ fsPath }),
        joinPath: (...parts) => ({ fsPath: parts.map((part) => typeof part === 'string' ? part : part.fsPath).join('/') }),
      },
      workspace: { getWorkspaceFolder: () => undefined },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { GraphqlViewProvider } = await import(resolve(root, 'out/webview/graphqlViewProvider.js'));
const { renderQueryStructureHtml } = await import(resolve(root, 'out/preview/queryStructureWebview.js'));
const { buildQueryStructure } = await import(resolve(root, 'out/analysis/queryStructure.js'));
const { parseGqlFields } = await import(resolve(root, 'out/codelens/gqlCodeLensProvider.js'));
const { renderTemplateStructuresHtml } = await import(resolve(root, 'out/preview/queryStructureJson.js'));
const { LiveQueryInspector } = await import(resolve(root, 'out/preview/liveQueryInspector.js'));
const provider = new GraphqlViewProvider();
const nonce = 'fixture-nonce';
const sample = {
  type: 'tree',
  hasFilter: false,
  sortMode: 'none',
  sections: [{
    id: 'backend',
    label: 'Backend',
    desc: '8,000 classes',
    emptyMessage: 'No backend schemas loaded yet.',
    openByDefault: true,
    children: Array.from({ length: 8000 }, (_, index) => ({
      label: index === 0 ? 'veryLongSchemaTypeNameForVisualOverflowVerification' : `SyntheticType${index}`,
      desc: index === 0 ? '/workspace/' + 'nested/'.repeat(18) + 'schema.py' : 'Synthetic field set',
      kind: 'class', icon: 'symbol-class', classId: `synthetic-${index}`,
      children: index === 0 ? [{ label: 'veryLongFieldNameForVisualOverflowVerification', desc: 'String', kind: 'field', icon: 'symbol-field' }] : [],
    })),
  }, {
    id: 'frontend',
    label: 'Frontend',
    desc: '1,500 files',
    emptyMessage: 'No frontend gql templates found.',
    openByDefault: true,
    children: Array.from({ length: 1500 }, (_, index) => ({
      label: `synthetic-operation-${index}`, kind: 'file', icon: 'file-code',
      file: `/workspace/operations/${index}.graphql`, line: 0, children: [],
    })),
  }],
};

let html = provider.getHtml();
html = html
  .replace(/nonce="[^"]+"/g, `nonce="${nonce}"`)
  .replace(/'nonce-[^']+'/g, `'nonce-${nonce}'`)
  .replace('const vscode = acquireVsCodeApi();', 'const vscode = { postMessage: () => {} };')
  .replace('</body>', `<script nonce="${nonce}">window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(sample)} }));</script></body>`);

await mkdir(outputDir, { recursive: true });
const fixtureThemes = {
  dark: `:root { --vscode-editor-background:#1e1e1e; --vscode-sideBar-background:#252526; --vscode-editor-foreground:#d4d4d4; --vscode-foreground:#d4d4d4; --vscode-descriptionForeground:#a7a7a7; --vscode-input-background:#3c3c3c; --vscode-input-foreground:#fff; --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#fff; --vscode-widget-border:#454545; --vscode-focusBorder:#007fd4; --vscode-textLink-foreground:#4daafc; }`,
  'high-contrast': `:root { --vscode-editor-background:#000; --vscode-sideBar-background:#000; --vscode-editor-foreground:#fff; --vscode-foreground:#fff; --vscode-descriptionForeground:#fff; --vscode-input-background:#000; --vscode-input-foreground:#fff; --vscode-button-secondaryBackground:#000; --vscode-button-secondaryForeground:#fff; --vscode-widget-border:#fff; --vscode-focusBorder:#ffff00; --vscode-textLink-foreground:#ffff00; --vscode-testing-iconPassed:#00ff00; --vscode-testing-iconFailed:#ff7b7b; }`,
};

function themedHtml(source, css) {
  return source.replace('</head>', `<style nonce="${nonce}">${css}</style></head>`);
}

async function writeSurfaceVariants(name, source) {
  const paths = [resolve(outputDir, `${name}.html`)];
  for (const [theme, css] of Object.entries(fixtureThemes)) {
    const target = resolve(outputDir, `${name}.${theme}.html`);
    await writeFile(target, themedHtml(source, css), 'utf8');
    paths.push(target);
  }
  return paths;
}
const htmlPath = resolve(outputDir, 'schema-explorer.html');
await writeSurfaceVariants('schema-explorer', html);

const inspectorFields = Array.from({ length: 800 }, (_, index) => ({
  name: `field_${index}`,
  displayName: `field${index}`,
  fieldType: 'String',
  args: [],
  filePath: '/workspace/schema.py',
  lineNumber: index,
  origin: index % 3 === 0 ? 'inherited' : 'own',
  queried: index % 5 === 0,
  resolvedTypeExists: false,
}));
const inspectorSample = {
  type: 'inspector',
  data: {
    className: 'LargeQuery', kind: 'query', filePath: '/workspace/schema.py', lineNumber: 11,
    baseClasses: Array.from({ length: 12 }, (_, index) => `BaseType${index}`),
    knownBaseClasses: [], baseClassTargets: {}, fields: inspectorFields,
    queriedCount: 160, totalCount: 800, hasActiveCoverage: true, usedAsFieldType: [], usedAsArgType: [],
    sdl: 'type LargeQuery {\n  field0: String\n}',
  },
};
let inspectorHtml = provider.getInspectorShellHtml();
inspectorHtml = inspectorHtml
  .replace(/nonce="[^"]+"/g, `nonce="${nonce}"`)
  .replace(/'nonce-[^']+'/g, `'nonce-${nonce}'`)
  .replace('const vscode = acquireVsCodeApi();', 'const vscode = { postMessage: () => {}, getState: () => undefined, setState: () => {} };')
  .replace('</body>', `<script nonce="${nonce}">window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(inspectorSample)} }));</script></body>`);
const inspectorPath = resolve(outputDir, 'type-inspector.html');
await writeSurfaceVariants('type-inspector', inspectorHtml);

const coverageType = {
  name: 'ProfileType', kind: 'type', framework: 'graphene', filePath: '/workspace/schema.py', lineNumber: 0,
  baseClasses: [], fields: [
    { name: 'id', fieldType: 'ID', filePath: '/workspace/schema.py', lineNumber: 1 },
    { name: 'display_name', fieldType: 'String', filePath: '/workspace/schema.py', lineNumber: 2 },
    { name: 'email', fieldType: 'String', filePath: '/workspace/schema.py', lineNumber: 3 },
  ],
};
const coverageStructure = buildQueryStructure(parseGqlFields('query { profile { id } }')[0], coverageType, new Map([[coverageType.name, coverageType]]));
let coverageHtml = renderQueryStructureHtml(coverageStructure, '800-field scale fixture');
coverageHtml = coverageHtml
  .replace(/nonce="[^"]+"/g, `nonce="${nonce}"`)
  .replace(/'nonce-[^']+'/g, `'nonce-${nonce}'`)
  .replace('const vscode = typeof acquireVsCodeApi === \'function\' ? acquireVsCodeApi() : { postMessage: () => {} };', 'const vscode = { postMessage: () => {} };');
const coveragePath = resolve(outputDir, 'query-coverage.html');
await writeSurfaceVariants('query-coverage', coverageHtml);

const liveInspector = new LiveQueryInspector({}, () => ({ classMap: new Map(), fieldIndex: new Map() }));
const liveBody = renderTemplateStructuresHtml({
  operationKind: 'query', operationName: 'SyntheticProfile',
  operationVariables: [{ name: 'accountIdentifierWithAnIntentionallyLongName', type: 'ID', required: true, list: false }],
  structures: [{ structure: coverageStructure, note: 'Query.profile → ProfileType' }], unresolved: [],
});
const liveMessage = {
  type: 'render', contextKey: 'fixture-live-query', body: liveBody,
  summary: { operationKind: 'query', operationName: 'SyntheticProfile', rootCount: 1, resolvedCount: 1, unresolvedCount: 0 },
};
let liveHtml = liveInspector.shellHtml();
liveHtml = liveHtml
  .replace(/nonce="[^"]+"/g, `nonce="${nonce}"`)
  .replace(/'nonce-[^']+'/g, `'nonce-${nonce}'`)
  .replace("const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };", 'const vscode = { postMessage: () => {}, getState: () => undefined, setState: () => {} };')
  .replace('</body>', `<script nonce="${nonce}">window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(liveMessage)} }));</script></body>`);
const livePath = resolve(outputDir, 'live-query-inspector.html');
await writeSurfaceVariants('live-query-inspector', liveHtml);
process.stdout.write(`Rendered light, dark, and high-contrast fixtures at ${outputDir}\n`);
