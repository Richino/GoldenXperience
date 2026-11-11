import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/server.ts'],
  outfile: path.join(output, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  sourcemap: 'external',
  keepNames: true,
  logLevel: 'info',
});
// Model loaders resolve data relative to import.meta.url. The bundled server
// remains one directory below api-server, like src/server.ts, and needs these
// artifacts beside it. Recording and cwd-based research paths keep their depth.
await cp(path.join(root, 'src/data'), path.join(output, 'data'), { recursive: true });
