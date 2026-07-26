import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/@vscode/codicons/dist');
const destination = resolve(root, 'media/codicons');

await mkdir(destination, { recursive: true });
await cp(resolve(source, 'codicon.css'), resolve(destination, 'codicon.css'));
await cp(resolve(source, 'codicon.ttf'), resolve(destination, 'codicon.ttf'));
