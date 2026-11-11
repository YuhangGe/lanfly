import tailwindcss from '@tailwindcss/vite';
import { jingeVitePlugin } from 'jinge-compiler';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { ServerActionPlugin } from './script/vite-plugin.ts';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const commonEntry = fileURLToPath(new URL('../common/src/index.ts', import.meta.url));
const actionStub = fileURLToPath(new URL('./src/service/action/server.ts', import.meta.url));

export default defineConfig({
  plugins: [
    ServerActionPlugin(),
    jingeVitePlugin({ intl: { dropDefaultText: false } }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': srcDir,
      '@lanfly/common': commonEntry,
      // 依赖扫描不认识 ServerActionPlugin 的改写，给 @server 一个可解析的本地入口。
      '@server': actionStub,
    },
    dedupe: ['jinge'],
  },
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
    proxy: {
      '/__rpc': 'http://127.0.0.1:8087',
      '/events': 'http://127.0.0.1:8087',
      '/api': 'http://127.0.0.1:8087',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
