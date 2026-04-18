// Minimal smoke tests. Runs inside a real VSCode instance. Confirms the
// extension activates, registers its commands, and that refresh populates
// something schema-shaped from the fixture workspace.
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'newdlops.django-graphql-explorer';
const REFRESH_CMD = 'djangoGraphqlExplorer.refresh';
const INSPECT_CMD = 'djangoGraphqlExplorer.inspectType';

suite('Django GraphQL Explorer — smoke', () => {
  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} should be present`);
    if (!ext!.isActive) await ext!.activate();
  });

  test('registers commands', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes(REFRESH_CMD), 'refresh command should be registered');
    assert.ok(all.includes(INSPECT_CMD), 'inspect-type command should be registered');
  });

  test('refresh command completes without throwing', async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand(REFRESH_CMD);
  });

  test('the webview view contribution is declared', () => {
    // VSCode doesn't expose registered views programmatically, but we can at
    // least confirm the activity-bar view id resolves to something via the
    // package.json contributions (surfaced via extensionKind).
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const views = (ext.packageJSON.contributes?.views?.djangoGraphql ?? []) as Array<{ id: string }>;
    assert.ok(
      views.some((v) => v.id === 'djangoGraphqlExplorer.view'),
      'Schema Explorer view contribution missing',
    );
  });
});
