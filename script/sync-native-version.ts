/**
 * npm version bumps the root version, then runs this hook. Keep every platform
 * package, optional dependency, Cargo metadata, lockfile entry and pnpm
 * release-age exclusion on the same version so a manual publish can build and
 * publish the platform packages before the root package.
 *
 * Running this file directly only syncs files; it does not commit or tag.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = path.join(root, 'package.json');
const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};
const version = rootPkg.version;
const outputs = new Map<string, string>();
const platforms: string[] = [];
const platformDir = path.join(root, 'platform');

for (const entry of await readdir(platformDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(platformDir, entry.name, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8')) as { name?: string; version?: string };
  if (!pkg.name?.startsWith('lanfly-input-')) {
    throw new Error(`Unexpected platform package name in ${file}`);
  }
  pkg.version = version;
  platforms.push(pkg.name);
  outputs.set(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
if (platforms.length === 0) throw new Error('No platform packages found');

rootPkg.optionalDependencies ??= {};
for (const name of Object.keys(rootPkg.optionalDependencies)) {
  if (name.startsWith('lanfly-input-') && !platforms.includes(name)) {
    delete rootPkg.optionalDependencies[name];
  }
}
for (const name of platforms) rootPkg.optionalDependencies[name] = version;
rootPkg.optionalDependencies = Object.fromEntries(
  Object.entries(rootPkg.optionalDependencies).sort(([a], [b]) => a.localeCompare(b)),
);
outputs.set(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
const workspaceLines = (await readFile(workspaceFile, 'utf8')).split('\n');
const header = 'minimumReleaseAgeExclude:';
const entries = [...platforms]
  .sort((a, b) => a.localeCompare(b))
  .map((name) => `  - ${name}@${version}`);
const headerIndex = workspaceLines.findIndex((line) => line === header);
if (headerIndex < 0) {
  outputs.set(
    workspaceFile,
    `${workspaceLines.join('\n').trimEnd()}\n${header}\n${entries.join('\n')}\n`,
  );
} else {
  let end = headerIndex + 1;
  while (end < workspaceLines.length && /^\s+\S/.test(workspaceLines[end])) end++;
  const unrelated = workspaceLines
    .slice(headerIndex + 1, end)
    .filter((line) => !/^\s*-\s*['"]?lanfly-input-/.test(line));
  outputs.set(
    workspaceFile,
    [
      ...workspaceLines.slice(0, headerIndex + 1),
      ...unrelated,
      ...entries,
      ...workspaceLines.slice(end),
    ].join('\n'),
  );
}

for (const [name, pattern] of [
  ['native/Cargo.toml', /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m],
  ['native/Cargo.lock', /(\[\[package\]\]\r?\nname = "lanfly-input"\r?\nversion = ")[^"]+(")/],
] as const) {
  const file = path.join(root, name);
  const content = await readFile(file, 'utf8');
  if (!pattern.test(content)) throw new Error(`Cannot find lanfly-input version in ${name}`);
  outputs.set(file, content.replace(pattern, `$1${version}$2`));
}

const lockFile = path.join(root, 'pnpm-lock.yaml');
let lock = await readFile(lockFile, 'utf8');
for (const platform of platforms) {
  const name = platform.replace(/^lanfly-input-/, '');
  const pattern = new RegExp(`(lanfly-input-${name}:\\n\\s+specifier: )[^\\n]+`);
  if (pattern.test(lock)) {
    lock = lock.replace(pattern, (_match, prefix: string) => `${prefix}${version}`);
  }
}
outputs.set(lockFile, lock);

for (const [file, content] of outputs) {
  if ((await readFile(file, 'utf8')) !== content) await writeFile(file, content);
}

if (
  process.env.npm_lifecycle_event === 'version' &&
  process.env.npm_config_git_tag_version !== 'false' &&
  process.env.npm_config_git_tag_version !== ''
) {
  execFileSync(
    'git',
    ['add', '--', ...[...outputs.keys()].map((file) => path.relative(root, file))],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}

console.log(`[lanfly] synced ${platforms.length} platform package(s) to ${version}`);
