import { cp, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('monaco-editor/package.json'));
const destination = fileURLToPath(new URL('../public/monaco/', import.meta.url));
await mkdir(destination, { recursive: true });
await cp(join(source, 'min/vs'), join(destination, 'vs'), { recursive: true });
await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE'));
console.log('Prepared local Monaco assets.');
