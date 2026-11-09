import type { PluginOption } from 'vite';

const Reg = /import\s*\{([^}]+)\}\s*from\s*['"]@server['"]/g;

/**
 * `@server` 只是类型入口：构建时把 server action 的导入替换成运行时 RPC 代理。
 * 前端因此能拿到服务端 action 的入参/出参类型，但不会把服务端代码打进浏览器。
 */
export function ServerActionPlugin(): PluginOption {
  return {
    name: 'lanfly-server-action',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.tsx?$/.test(id) || !code.includes('@server')) return;
      return code.replace(Reg, (_match, names: string) => {
        const imports = names
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value && !value.startsWith('type '))
          .join(',');
        if (!imports) return '';
        return `import { rootProxy } from '@/service/action';const {${imports}} = rootProxy`;
      });
    },
  };
}
