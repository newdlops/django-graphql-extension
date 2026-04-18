// Mocha runner loaded inside the VSCode-under-test process.
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  const testsRoot = __dirname;
  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
