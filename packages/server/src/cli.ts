import { DEFAULT_PORT } from '@lanfly/common';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { Application } from './app';
import { loadServerConfig, type ServerConfig } from './config';
import { logger, setVerbose } from './logger';
import { VERSION } from './version';

interface CliOptions {
  name?: string;
  roomId?: string;
  port?: number;
  outDir?: string;
  noOpen: boolean;
  noDiscovery: boolean;
  verbose: boolean;
}

const HELP = `lanfly ${VERSION}

在局域网内自动发现其它 lanfly 设备，聊天并传送文件。

用法：
  npx lanfly [ROOM ID] [选项]

ROOM ID 不指定时读取 data.json，首次随机生成 6 位数字并保存；指定时覆盖保存值。

选项：
  -n, --name <名称>     对外显示的设备名称，默认使用本机 hostname
  -p, --port <端口>     本地监听端口，默认 ${DEFAULT_PORT}，被占用时自动顺延
      --out <目录>      接收文件的保存目录，默认为系统下载目录
      --no-open         启动后不自动打开浏览器
      --no-discovery    禁用 UDP 组播（仍可在网页里手动添加 IP）
      --verbose         输出调试日志
  -h, --help            显示帮助
  -v, --version         显示版本
`;

function fail(message: string): never {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

interface ParsedValues {
  name?: string;
  port?: string;
  out?: string;
  'no-open'?: boolean;
  'no-discovery'?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseCli(): CliOptions {
  let values: ParsedValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        name: { type: 'string', short: 'n' },
        port: { type: 'string', short: 'p' },
        out: { type: 'string' },
        'no-open': { type: 'boolean' },
        'no-discovery': { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    fail(`${(error as Error).message}\n\n${HELP}`);
  }

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (
    positionals.length > 1 ||
    (positionals[0] !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(positionals[0]))
  )
    fail('ROOM ID 应为 1–64 位字母、数字、下划线或短横线。');

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      fail(`端口无效：${values.port}`);
    }
  }

  return {
    name: values.name,
    roomId: positionals[0],
    port,
    outDir: values.out,
    noOpen: values['no-open'] ?? false,
    noDiscovery: values['no-discovery'] ?? false,
    verbose: values.verbose ?? false,
  };
}

function openBrowser(url: string): void {
  if (process.env.LANFLY_NO_OPEN === '1') return;
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 打不开浏览器时仍然打印地址，用户可手动访问。
  }
}

async function main(): Promise<void> {
  const options = parseCli();
  setVerbose(options.verbose);

  let config: ServerConfig;
  try {
    config = await loadServerConfig({
      name: options.name,
      roomId: options.roomId,
      port: options.port ?? DEFAULT_PORT,
      outDir: options.outDir,
      noDiscovery: options.noDiscovery,
      verbose: options.verbose,
    });
  } catch (error) {
    logger.error(error);
    fail('无法读取或保存 Room ID，请检查 data.json 的内容和目录权限。');
  }

  const app = new Application(config);
  let port: number;
  try {
    port = await app.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail(`端口 ${config.port} 已被占用，请使用 --port 指定其它端口。`);
    }
    logger.error(error);
    fail('lanfly 启动失败。');
  }

  const self = app.identity;
  console.log('');
  console.log(`  \x1b[36m\x1b[1mlanfly\x1b[0m \x1b[90mv${VERSION}\x1b[0m`);
  console.log(`  设备      ${self.name}`);
  console.log(`  Room ID   ${self.roomId} （其它主机运行 npx lanfly ${self.roomId} 加入）`);
  console.log(`  本地      \x1b[4m${self.url}\x1b[0m`);
  console.log(`  局域网    http://${self.host}:${port} （浏览器接入或手动添加设备）`);
  console.log(`  下载目录  ${self.downloadsDir}`);
  console.log(`  配置文件  ${app.input.store.file}`);
  console.log(`  \x1b[90m按 Ctrl+C 停止；关闭终端后本次聊天记录会丢失。\x1b[0m`);
  console.log('');

  if (!options.noOpen) setTimeout(() => openBrowser(self.url), 250);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n正在停止 lanfly…');
    void app.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (error) => {
    logger.error(error);
  });
}

void main();
