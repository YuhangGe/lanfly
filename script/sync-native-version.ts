import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
  version: string;
  optionalDependencies: Record<string, string>;
};
for (const platform of ['darwin-arm64', 'darwin-x64']) {
  const name = `lanfly-input-${platform}`;
  pkg.optionalDependencies[name] = pkg.version;
  const file = new URL(`platform/${platform}/package.json`, root);
  const native = JSON.parse(await readFile(file, 'utf8')) as { version: string };
  native.version = pkg.version;
  await writeFile(file, JSON.stringify(native, null, 2) + '\n');
}
await writeFile(new URL('package.json', root), JSON.stringify(pkg, null, 2) + '\n');
const cargoFile = new URL('native/Cargo.toml', root);
const cargo = await readFile(cargoFile, 'utf8');
await writeFile(cargoFile, cargo.replace(/^version = ".*"/m, `version = "${pkg.version}"`));
// The lockfile's local package entry must match before CI uses --locked.
const lockFile = new URL('native/Cargo.lock', root);
const lock = await readFile(lockFile, 'utf8');
await writeFile(
  lockFile,
  lock.replace(
    /(name = "lanfly-input"\nversion = ")[^"]+/,
    (_match, prefix: string) => prefix + pkg.version,
  ),
);
const pnpmFile = new URL('pnpm-lock.yaml', root);
let pnpm = await readFile(pnpmFile, 'utf8');
for (const platform of ['darwin-arm64', 'darwin-x64']) {
  pnpm = pnpm.replace(
    new RegExp(`(lanfly-input-${platform}:\\n\\s+specifier: )[^\\n]+`),
    (_match, prefix: string) => prefix + pkg.version,
  );
}
await writeFile(pnpmFile, pnpm);
