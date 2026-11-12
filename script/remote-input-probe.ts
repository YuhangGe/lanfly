// This file is sent to the receiver as a payload. It can be updated independently
// of the long-running receiver; do not use imports relative to its temporary path.
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = process.env.LANFLY_REMOTE_ROOT ?? process.cwd();
const artifacts = process.env.LANFLY_REMOTE_ARTIFACTS ?? path.join(root, '.tmp/remote-test/probe');
await mkdir(artifacts, { recursive: true });

async function command(executable: string, args: string[]) {
  console.log(`$ ${executable} ${args.join(' ')}`);
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      });
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    },
  );
}

const report: Record<string, unknown> = {
  root,
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
  runtime: process.versions,
  capturedAt: new Date().toISOString(),
};

try {
  report.git = await command('git', ['rev-parse', '--short', 'HEAD']);
  report.worktree = await command('git', ['status', '--short']);
  const addon = path.join(root, 'native/index.node');
  report.addonModifiedAt = (await stat(addon)).mtime.toISOString();
  // Use a fresh Node process so this probe exercises the same runtime as lanfly.
  // The parent's job timeout also applies if a macOS permission call blocks.
  report.native = await command('node', [
    '--input-type=module',
    '-e',
    'import {createRequire} from "node:module"; const n=createRequire(process.cwd()+"/package.json")("./native/index.node"); console.log(n.status());',
  ]);
  if (process.platform === 'darwin') {
    const source = path.join(root, 'script/diagnose-input-source.m');
    const executable = path.join(root, '.tmp/remote-test/diagnose-input-source');
    const previous = await stat(executable).catch(() => undefined);
    if (!previous || previous.mtimeMs < (await stat(source)).mtimeMs) {
      const build = await command('xcrun', [
        'clang',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-deprecated-declarations',
        source,
        '-framework',
        'Foundation',
        '-framework',
        'ApplicationServices',
        '-framework',
        'Carbon',
        '-framework',
        'IOKit',
        '-o',
        executable,
      ]);
      if (build.exitCode !== 0) throw new Error('Could not compile input-source probe');
    }
    report.inputSources = await command(executable, ['status']);
    if (process.argv.includes('--screenshot')) {
      report.screenshot = await command('/usr/sbin/screencapture', [
        '-x',
        path.join(artifacts, 'screen.png'),
      ]);
    }
  }
  // Record the exact versions of the code under examination without copying config.
  const require = createRequire(path.join(root, 'package.json'));
  report.version = require('./package.json').version;
  report.captureImplementation = await readFile(
    path.join(root, 'native/src/macos_input_source.rs'),
    'utf8',
  );
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'probe.json'), JSON.stringify(report, null, 2));
  console.log(`Probe saved to ${artifacts}/probe.json`);
}
