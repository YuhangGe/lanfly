import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bunVersion = (process.versions as Record<string, string | undefined>).bun;
const bun = bunVersion ? process.execPath : 'bun';

const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  console.log('\n正在停止开发服务…');
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 2_000);
  force.unref();
  void Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) resolve();
          else child.once('exit', () => resolve());
        }),
    ),
  ).then(() => process.exit(code));
}

for (const directory of [path.join(root, 'packages/webui'), path.join(root, 'packages/server')]) {
  const child = spawn(bun, ['run', 'dev'], {
    cwd: directory,
    stdio: 'inherit',
    env: process.env,
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    stop(code ?? (signal ? 1 : 0));
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
