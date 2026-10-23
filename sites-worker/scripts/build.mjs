import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist');
const source = await readFile(path.join(root, 'worker/index.js'), 'utf8');
const spec = await readFile(path.join(root, 'openapi.json'), 'utf8');
const marker = 'const OPENAPI_SPEC_JSON = "__OPENAPI_SPEC_JSON__";';
if (!source.includes(marker)) throw new Error('OpenAPI injection marker is missing.');
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'server'), { recursive: true });
await mkdir(path.join(output, '.openai'), { recursive: true });
await cp(path.join(root, '.openai/hosting.json'), path.join(output, '.openai/hosting.json'));
await build({
  stdin: {
    contents: source.replace(marker, `const OPENAPI_SPEC_JSON = ${JSON.stringify(spec)};`),
    resolveDir: path.join(root, 'worker'),
    sourcefile: 'index.js',
    loader: 'js',
  },
  outfile: path.join(output, 'server/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  treeShaking: true,
  legalComments: 'none',
});
console.log('Built bundled Sites Worker.');
