import { execFileSync } from 'node:child_process';
import { copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin')
  throw new Error('Native input builds currently support macOS only');
execFileSync(
  'cargo',
  ['build', '--manifest-path', path.join(root, 'native/Cargo.toml'), '--locked', '--release'],
  {
    stdio: 'inherit',
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '12.0' },
  },
);
// Keep the old inode intact if a running server still has the addon mapped.
const output = path.join(root, 'native/index.node');
const temporary = `${output}.${process.pid}.tmp`;
await copyFile(path.join(root, 'native/target/release/liblanfly_input.dylib'), temporary);
await rename(temporary, output);
console.log('已生成 native/index.node');
