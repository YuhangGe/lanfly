// Manual macOS regression test. Changes the global source temporarily, then restores it.
// No keyboard/mouse capture; suitable for the remote test receiver.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.LANFLY_REMOTE_ROOT ?? process.cwd();
const directory = process.env.LANFLY_REMOTE_ARTIFACTS ?? path.join(root, '.tmp/input-source-guard');
await mkdir(directory, { recursive: true });
const probe = path.join(directory, 'input-source-probe');
const guard = path.join(root, 'native/target/debug/examples/input_source_guard');

async function command(executable: string, args: string[], log = true) {
  if (log) console.log('$', executable, ...args);
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '12.0', LANFLY_INPUT_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (log) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (log) process.stderr.write(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}: ${stderr}`)),
    );
  });
  return stdout;
}

interface Source {
  id: string;
  mode: string;
  ascii: boolean;
  selectable: boolean;
}
const identity = (source: Source) => `${source.id}/${source.mode}`;
async function inspect() {
  const records = (await command(probe, ['status'], false))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; current: Source; list: Source[] });
  return {
    current: records.find((record) => record.kind === 'source')!.current,
    sources: records.find((record) => record.kind === 'sources')!.list,
  };
}

await command('xcrun', [
  'clang',
  '-fobjc-arc',
  '-Wno-deprecated-declarations',
  path.join(root, 'script/diagnose-input-source.m'),
  '-framework',
  'Foundation',
  '-framework',
  'ApplicationServices',
  '-framework',
  'Carbon',
  '-framework',
  'IOKit',
  '-o',
  probe,
]);
await command('cargo', [
  'build',
  '--manifest-path',
  'native/Cargo.toml',
  '--locked',
  '--example',
  'input_source_guard',
]);
const initial = await inspect();
const original = initial.current;
const opposite = initial.sources.find(
  (source) => source.selectable && source.ascii !== original.ascii,
);
assert(opposite, 'Need an ASCII and non-ASCII input source');
const report: Record<string, unknown> = { original, cycles: [] };
let active: ReturnType<typeof spawn> | undefined;

async function cycle(index: number, baseline: Source, changed: Source) {
  if (identity((await inspect()).current) !== identity(baseline)) {
    await command(probe, ['tis', baseline.id, '--no-delay']);
  }
  assert.equal(
    identity((await inspect()).current),
    identity(baseline),
    'Could not establish initial source',
  );
  const release = path.join(directory, `release-${index}-${randomUUID()}`);
  const child = spawn(guard, ['2', release], {
    cwd: root,
    env: { ...process.env, LANFLY_INPUT_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active = child;
  let output = '';
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Guard exited ${code}`)),
    );
  });
  // Attach a rejection handler immediately; readiness and close are awaited separately.
  void closed.catch(() => undefined);
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
      if (output.includes('CAPTURE_READY')) resolve();
    });
    child.once('error', reject);
    child.once('close', () => reject(new Error('Guard exited before readiness')));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    process.stderr.write(chunk);
  });
  try {
    await ready;
    await command(probe, ['tis', changed.id, '--no-delay']);
    const perturbation = (await inspect()).current;
    assert.equal(
      identity(perturbation),
      identity(changed),
      'Independent observer did not see the external source change',
    );
    console.log('External change confirmed:', identity(baseline), '->', identity(perturbation));
    await writeFile(release, 'resume');
    await closed;
    const restored = (await inspect()).current;
    assert.equal(identity(restored), identity(baseline), 'Guard did not restore the global source');
    (report.cycles as unknown[]).push({ baseline, perturbation, restored, output });
    console.log('Restoration confirmed by independent process:', identity(restored));
  } finally {
    if (child.exitCode === null) child.kill();
    await closed.catch(() => undefined);
    active = undefined;
  }
}

try {
  await cycle(0, original, opposite);
  if (process.argv.includes('--both-directions')) await cycle(1, opposite, original);
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  active?.kill();
  if (identity((await inspect()).current) !== identity(original)) {
    await command(probe, ['tis', original.id, '--no-delay']);
  }
  report.final = (await inspect()).current;
  await writeFile(path.join(directory, 'guard-test.json'), JSON.stringify(report, null, 2));
  assert.equal(
    identity(report.final as Source),
    identity(original),
    'Original source was not restored',
  );
}
