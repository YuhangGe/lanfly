# lanfly

在局域网内自动发现其它运行 lanfly 的设备，直接聊天、拖拽或粘贴文件，不需要账号、云服务或中心服务器。

![lanfly 界面](docs/lanfly.png)

`npx lanfly` 会在本机启动一个只服务当前局域网的小型 HTTP 服务（默认 `8087`），自动打开浏览器界面；关闭终端后设备列表、聊天记录和传输记录全部消失，接收到的文件会保留在系统下载目录。

## 功能

- **自动发现**：UDP 组播公告 + HTTP 校验，同一局域网内无需配置。
- **手动连接**：组播被网络禁用时，在界面里输入对方 IP（或 `IP:端口`）主动建立连接。
- **密码房间**：`--secret` 派生出房间密钥并加密发现公告；只有相同密码的设备能互相看到，公开房间与密码房间双向隔离。
- **聊天**：纯文本消息、多行输入、发送状态、失败重试、未读提示。
- **文件传送**：多选、拖拽、粘贴截图；流式上传、进度、取消；自动保存到系统下载目录，重名自动加序号。
- **内存态**：无数据库、无 Prisma；设备、会话、消息、传输记录都在内存中，退出即清空。
- **跨平台**：macOS、Windows、Linux；默认下载目录统一为 `~/Downloads`。

## 快速开始

已发布到 npm 后：

```sh
npx lanfly
```

从源码运行：

```sh
pnpm install
pnpm build
pnpm start
```

`pnpm build` 会把服务端和 webui 一起打包到仓库根目录的 `dist/`。

构建与开发脚本（`script/build.ts`、`script/dev.ts`、`packages/server/script/bundle.ts`）全部是 TypeScript，并由 **Bun** 执行；`pnpm start` 也用 Bun 启动构建产物。Bun 已作为 devDependency 安装，执行 `pnpm install` 即可，无需全局安装。发布后的 `npx lanfly` 仍使用 Node 运行，bin 的 shebang 保持 `node`。

启动后终端会打印本地地址并自动打开浏览器。另一台电脑运行同样的命令，即可在左侧看到彼此。

### 命令行参数

```text
npx lanfly [选项]

  -n, --name <名称>     对外显示的设备名称，默认使用本机 hostname
  -s, --secret <密码>   密码房间；只有相同密码的设备才能互相发现
  -p, --port <端口>     本地监听端口，默认 8087，被占用时自动顺延
      --out <目录>      接收文件的保存目录，默认为系统下载目录
      --no-open         启动后不自动打开浏览器
      --no-discovery    禁用 UDP 组播（仍可在网页里手动添加 IP）
      --verbose         输出调试日志
  -h, --help            显示帮助
  -v, --version         显示版本
```

示例：

```sh
npx lanfly --name "客厅 Mac"
npx lanfly --secret "correct horse battery staple"
# 或避免 shell 历史：
LANFLY_SECRET="correct horse battery staple" npx lanfly
npx lanfly --port 9000 --out ~/Downloads/lanfly
```

也支持环境变量：`LANFLY_SECRET`（等同 `--secret`）、`LANFLY_NO_OPEN=1`（不打开浏览器）、`LANFLY_DOWNLOAD_DIR`（等同 `--out`）。

### 密码房间的行为

- 不设置 `--secret`：公开房间，能看到同一局域网内所有公开设备。
- 设置 `--secret`：公告用派生密钥加密；非密码设备看不到你，你也看不到它们。
- 双方密码必须完全一致（区分大小写和空格）；密码不同时手动输入 IP 会提示“密码房间不一致”。
- 密码不会明文出现在发现公告或 HTTP 头中；但设备之间的消息和文件内容使用 HTTP 明文传输。**密码只控制发现与访问资格，不提供传输加密。**

## 工作方式

```
设备 A                                          设备 B
┌─────────────────────────────┐                ┌─────────────────────────────┐
│ 浏览器 UI (127.0.0.1:8087)  │                │ 浏览器 UI (127.0.0.1:8087)  │
│        │ typed RPC / SSE    │                │        │ typed RPC / SSE    │
│ 本地 Node 服务 ─────────────┼── HTTP ────────┼→ 本地 Node 服务             │
│   ├─ UDP 组播公告           │                │   ├─ UDP 组播公告           │
│   ├─ 内存 peer/message 状态 │                │   ├─ 内存 peer/message 状态 │
│   └─ 下载目录落盘           │←── 文件流 ─────┼── 文件 offer / PUT         │
└─────────────────────────────┘                └─────────────────────────────┘
```

- 组播地址：`239.255.77.87:53318`，IPv4，TTL 1；每 2 秒公告一次，约 8 秒无心跳标记离线。
- 设备间 HTTP API：`/api/v1/peer/info`、`/hello`、`/messages`、`/transfers`。
- 文件流程：offer → 接收方自动接受并返回一次性令牌 → 发送方流式 PUT → 落盘后完成；双方通过 SSE 实时更新进度。
- 浏览器只和本机服务通信；跨设备请求全部由两个 Node 服务完成，避免浏览器 CORS 和混合内容问题。
- 本地 UI 接口只接受 loopback 访问并校验 Host/Origin，避免局域网内其它机器操作本机下载目录。

## 安全模型与限制

这是面向可信局域网的工具，类似 LocalSend，不是面向公网的安全通信软件。

- 密码房间的发现公告使用 AES-256-GCM 加密，房间标识来自 `scrypt` 派生密钥；HTTP 请求使用 HMAC-SHA256 签名、时间戳和 nonce 防重放。
- 房间标识允许离线猜测密码：弱密码仍可能被暴力破解，请使用足够长的随机密码。
- 设备间 HTTP 是明文：同一网段内能抓包的人可以看到聊天内容和文件内容。不要在不可信 Wi-Fi 上传送敏感数据。
- 公开房间没有访问控制，任何能访问端口的人都可以发消息或投递文件；接收方会自动保存文件。建议在可信网络使用，或设置 `--secret`。
- `--secret` 会出现在本机进程命令行和 shell 历史中；可以用 `LANFLY_SECRET` 环境变量代替命令行参数。
- 只支持 IPv4 组播和同一广播域内的局域网；跨 NAT、跨 VLAN、VPN 或公网不可用。
- 不提供离线消息、断点续传、文件夹传输、历史记录、多用户账号或端到端加密。
- 单文件上限 100 GiB；接收端需要足够的磁盘空间。
- 设备 ID 每次启动随机生成；重启后会显示为新设备，内存中的会话也会清空。
- 浏览器界面只允许从 `127.0.0.1` / `localhost` 访问；终端打印的局域网地址供对方手动添加，不适合直接打开 UI。

## 开发

```sh
pnpm install     # 同时安装本地 Bun 1.4.x

# 同时启动 Vite (127.0.0.1:8080) 和本地服务 (127.0.0.1:8087)
pnpm dev         # bun script/dev.ts

# 生产构建：webui + server → 根目录 dist/（dist/cli.js + dist/public）
pnpm build       # bun script/build.ts

# 运行构建后的 CLI（本机开发时用 Bun）
pnpm start       # bun dist/cli.js

pnpm check       # oxfmt + oxlint + tsc（由 Bun 脚本串联）
pnpm test        # 单元测试 + 双实例集成测试（需要先 pnpm build）
```

测试本身仍是 TypeScript，由 Bun 内置的 `bun test` 执行；集成测试会启动真实 CLI 实例。

`pnpm test` 的集成测试会启动两个真实 CLI 实例，通过手动连接验证文本、文件、重名、路径穿越防护、密码隔离、端口顺延，以及根 `dist/public` 静态页面。当前测试使用 `--port 0` 和 `--no-discovery`，不依赖真实组播环境。

### 目录结构

```
script/build.ts     根级构建脚本：webui + server → dist/（Bun 执行）
script/dev.ts       并行启动 webui 与 server 开发服务（Bun 执行）
dist/               发布产物（构建生成，不提交）
  cli.js              打包后的 Node 可执行入口
  public/             webui 静态资源
packages/
  common/             共享类型、zod schema、常量、文件与格式化工具
  server/
    script/bundle.ts  服务端开发打包器（Bun 执行）
    src/              Node HTTP 服务、组播发现、聊天/文件传输、CLI
  webui/              jinge + Vite + Tailwind 4 浏览器界面
```

服务端与前端共享 `@lanfly/common`；`@server` 只作为类型入口，Vite 插件在构建时把 server action 的导入替换成运行时 RPC 代理，因此前端能获得完整类型而不会打包服务端代码。

### 构建发布包

根 `package.json` 就是发布的 `lanfly` 包，`bin` 指向 `dist/cli.js`；`files` 只保留 `dist` 和 README 使用的截图，`packages/` 等源码不会进入 npm 包。

```sh
pnpm pack:local
# 等价于 pnpm build && pnpm pack
# 产物：lanfly-0.1.0.tgz（仓库根目录）
```

包内包含：

- `dist/cli.js`：esbuild 打包后的可执行入口（包含 zod/superjson，运行时零依赖）
- `dist/public/`：webui 构建产物
- `README.md`、`LICENSE`、`docs/lanfly.png`

可以先检查内容：

```sh
npm pack --dry-run
```

本地验证 tarball：

```sh
npx --yes --package ./lanfly-0.1.0.tgz lanfly --version
```

发布 npm 时直接在仓库根目录执行（`prepublishOnly` 会先跑 `pnpm check && pnpm build`）：

```sh
npm publish
```

GitHub Actions 中的 `ci.yml` 也只做安装、检查、构建和测试；所有构建/开发命令都通过 devDependency 里的 Bun 运行，无需额外安装 Bun。发布步骤需要自行配置 registry token。

## 常见问题

**看不到另一台设备？**

- 确认两台设备在同一网段，且没有开启 AP 隔离/访客网络隔离。
- 防火墙需允许 Node 接收 UDP `53318` 和 TCP `8087`（或实际顺延端口）。
- 组播可能被企业网络禁用；点击右上角“添加设备”，输入对方 IP 和端口。
- 密码房间需要双方 `--secret` 完全一致；公开房间与密码房间互相不可见。

**端口被占用？**

默认会从 8087 开始自动顺延，并在终端打印实际地址。也可以用 `--port` 指定。

**文件保存到哪里？**

默认是 `~/Downloads`（Windows 为 `%USERPROFILE%\Downloads`；如果系统把下载目录重定向到 OneDrive，请用 `--out` 指定实际目录）；可用 `--out` 修改。重名文件会保存为 `name (1).ext`、`name (2).ext`。

**关闭终端后记录还在吗？**

不在。设备、消息、传输记录均在内存中，进程退出即清空；已经接收的文件会保留。

## License

MIT
