// Spawns a disposable VSCode instance, installs the built extension, and runs
// the mocha suite inside it. `npm run test:e2e` is the entry.
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  // Fixture lives in the SOURCE tree, not under out-e2e (tsc doesn't copy
  // non-TS files and the .py schema + .ts fragments must be in their
  // original spot for scanners to find them).
  const workspacePath = path.resolve(__dirname, '..', 'test-e2e', 'fixtures', 'django-basic');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',     // no interference from unrelated user extensions
        '--disable-gpu',
        '--no-sandbox',
      ],
    });
  } catch (err) {
    console.error('[e2e] runner failed:', err);
    process.exit(1);
  }
}

main();
