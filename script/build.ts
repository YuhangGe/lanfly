import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const webui = path.join(root, 'packages/webui');
const server = path.join(root, 'packages/server');
const bunVersion = (process.versions as Record<string, string | undefined>).bun;
const bun = bunVersion ? process.execPath : 'bun';

function run(cwd: string, args: string[]): void {
  execFileSync(bun, args, { cwd, stdio: 'inherit' });
}

async function makeReadable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeReadable(filePath);
    else await chmod(filePath, 0o644).catch(() => undefined);
  }
}

async function totalSize(directory: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) size += await totalSize(filePath);
    else size += (await stat(filePath)).size;
  }
  return size;
}

// 1. 构建前端；2. 类型检查服务端；3. 打包服务端并复制前端到根 dist。
run(webui, ['run', 'build']);
run(server, ['run', 'typecheck']);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(server, 'src/cli.ts')],
  outfile: path.join(dist, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
});

await cp(path.join(webui, 'dist'), path.join(dist, 'public'), { recursive: true });
await makeReadable(dist);
await chmod(path.join(dist, 'cli.js'), 0o755);

const size = await totalSize(dist);
console.log(
  `已生成 ${path.relative(root, dist)}/：dist/cli.js + dist/public（${(size / 1024).toFixed(0)} KiB）`,
);
