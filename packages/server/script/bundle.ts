import { build, context, type BuildOptions } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const isDev = process.argv.includes('--dev');

const options: BuildOptions = {
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile: path.join(dist, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
};

let child: ChildProcess | undefined;
let timer: NodeJS.Timeout | undefined;

async function stopServer(): Promise<void> {
  const current = child;
  child = undefined;
  if (!current || current.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const killer = setTimeout(() => {
      current.kill('SIGKILL');
      resolve();
    }, 1_500);
    current.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    current.kill('SIGTERM');
  });
}

async function startServer(): Promise<void> {
  // 先等旧进程退出，避免新进程因端口仍被占用而顺延到 8088。
  await stopServer();
  const next = spawn(process.execPath, [path.join(dist, 'cli.js'), '--no-open'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  child = next;
  next.on('exit', (code, signal) => {
    if (child === next) child = undefined;
    if (!isDev && code !== 0) process.exitCode = code ?? 1;
    if (signal) process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  if (!isDev) {
    await build(options);
    await chmod(path.join(dist, 'cli.js'), 0o755);
    return;
  }

  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'lanfly-dev-restart',
        setup(buildContext) {
          buildContext.onEnd((result) => {
            if (result.errors.length) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              console.log('[lanfly] 重新启动服务…');
              startServer().catch((error) => console.error(error));
            }, 250);
          });
        },
      },
    ],
  });
  await ctx.watch();

  const stop = (): void => {
    if (timer) clearTimeout(timer);
    stopServer()
      .then(() => ctx.dispose())
      .catch((error) => console.error(error))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
