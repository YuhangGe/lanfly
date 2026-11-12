# lanfly 开发与实现说明

本文记录 lanfly 的内部结构、关键实现、构建发布和测试方式。面向使用者的操作说明见 [README.md](README.md)（English）和 [README_ZH.md](README_ZH.md)（中文）。

## 仓库结构

```text
packages/common/       共享类型、协议 schema、Room ID / 桌面协议
packages/server/       Node HTTP 服务、信令、聊天、文件、键鼠和桌面服务
packages/webui/        Jinge + Tailwind 浏览器界面
native/                Rust + Neon 原生模块
  src/desktop*.rs      远程桌面、ScreenCaptureKit 桥、VideoToolbox、webrtc-rs
  src/desktop_capture.mm
  src/keyboard.rs      Quartz 键鼠注入、HID/WindowServer 相关逻辑
  src/input_source.rs
platform/              发布用的平台包元数据
script/                构建、发布、原生打包脚本
```

## 运行链路

### 本地页面与主机通信

- Node 服务默认监听 `8087`，本地 WebUI 通过 `/__rpc/*` 调用本机能力。
- 本地页面通过 `/events` SSE 接收消息、文件、键鼠和桌面事件。
- 浏览器设备通过 `/api/v1/browser/*` 加入，独立身份保存在签名 cookie 中。
- 主机之间通过 `/api/v1/peer/*` 通信，使用 `x-lanfly-room` 和 `x-lanfly-id` 绑定来源。
- 发现使用 UDP 组播；手动添加 IP 作为组播不可用时的回退。

### 浏览器设备

- 浏览器加入后在服务端生成独立设备 ID，浏览器自己的 SSE 使用 `/api/v1/browser/events`。
- 主机只交换自己直接接入的浏览器列表，不把第三方主机的浏览器继续转告给其它主机。
- 发给浏览器的文件先创建 30 分钟有效的下载邀请；接收方点击后才开始从发送页面流式上传/转发，不在中间主机落盘。

### 键鼠共享

- 原生模块负责拦截/注入键鼠事件，网页只负责角色、位置和连接状态。
- 服务端使用 HID 层事件拦截和后台光标控制锁定本机鼠标；macOS 后台光标控制依赖动态解析 WindowServer 的非公开接口。锁定失败时停止共享并在 WebUI 提示，避免两端光标同时移动。
- 鼠标越过配置的边缘时切换主机，移回相邻边缘返回。
- 支持键盘、鼠标按钮、滚轮和触控板滚动；不支持剪贴板、文件跨屏拖拽和多指手势。
- 任一端按 `Ctrl + Option + Command + Esc` 或点击停止，会释放按键和鼠标并关闭自动恢复。
- 一次只连接一台设备；角色和位置保存在配置中，正常断网会重试，关闭进程会释放状态。

## 远程桌面实现

### 媒体链路

- macOS `ScreenCaptureKit` 采集主显示器。
- `SCDisplay.width/height` 是逻辑尺寸，实际使用 `CGDisplayModeGetPixelWidth/Height` 取 Retina 物理像素。例如逻辑 1470×956 的屏幕按 2940×1912 采集。
- 采集上限 3840×2160，默认 30 FPS；不会为了适配窗口而把已经采集的像素再缩小。
- `VideoToolbox` 编码 H.264 Constrained Baseline，实时模式，不使用 B 帧。
- Rust `webrtc-rs` 发送 RTP；SDP/ICE 只走现有 Node 信令，编码帧不进入 JavaScript。
- 浏览器使用原生 `RTCPeerConnection` + `HTMLVideoElement` 播放，支持静音自动播放、全屏和自适应窗口。
- 视频不把被控端指针编码进去；控制端显示自己的本地指针，避免本地指针和视频指针重叠、视频指针追赶的延迟感。

### 编码与发送

- 编码队列有界；超过容量时清空旧 GOP 并强制下一个关键帧，避免丢 P 帧破坏 H.264 参考链。
- 发送端等待 PeerConnection 进入 `connected` 后再等关键帧，避免 DTLS 建立前丢掉首个关键帧。
- 帧等待使用异步 `Notify`，不在 WebRTC 的 Tokio worker 上阻塞。
- 码率支持 2/4/8/16/32 Mbps；H.264 level 根据宏块数和码率在 4.0/4.2/5.0/5.1 之间选择，避免高分辨率/高码率仍按 Level 4.0 协商。
- 采集、编码和网络队列都不做无限缓冲，延迟过高时丢弃帧而不是累积。

### 会话与信令

- 每次会话有 `sessionId`、发起设备身份、目标设备和一次性 token。
- SDP、ICE、停止、输入消息都校验来源设备、会话和 token。
- 远程桌面请求按现有 Room ID 和已知设备身份自动接受；被控端本机 WebUI 打开被动状态窗口，可随时停止。
- 鼠标键盘控制随远程桌面开启，不再有单独的仅查看模式。
- 连接远程桌面会先停止键鼠共享，避免两套输入状态冲突。
- 一次只允许一个远程桌面会话，只采集主显示器。
- 仅使用局域网 host ICE candidate；Chrome 的 mDNS host candidate 会额外补一个真实局域网 IP 候选，减少 ICE 建立时间。
- 不支持跨 NAT、VLAN、VPN 或公网，也不使用 STUN/TURN/外部媒体服务器。

### 输入

- 鼠标使用归一化坐标映射到被控端主显示器，浏览器负责处理视频黑边（letterbox）和 DPR。
- 键盘使用 macOS virtual keycode 和修饰键 flags；窗口失焦、停止、断线时释放所有按下的键和鼠标按钮。
- 键鼠事件通过 WebRTC DataChannel（DTLS 加密）发送，不经过 Node 转发。

### macOS 输入源线程与回归

TIS 操作统一在 macOS 主线程执行。该线程需要显式处理 CFRunLoop 的输入源变化通知；只运行 Node/libuv，或只处理一个后台线程的 CFRunLoop，会读到过期的输入源缓存。主线程 NAPI 调用直接执行，Tokio 的输入源动作经 Neon Channel 投递到主线程，完成后继续注入后续按键。Quartz tap 不执行 TIS。

人工回归脚本会暂时切换当前输入源，并在结束时恢复；运行期间暂停正常键鼠操作和应用焦点切换：

```sh
./node_modules/.bin/bun script/test-input-source-guard.ts --both-directions
# 也可经已连接的接收端执行：
LANFLY_REMOTE_TIMEOUT_MS=600000 pnpm remote-test run script/test-input-source-guard.ts --both-directions
```

脚本编译使用正式输入源实现的 Rust fixture，通过另一个进程确认外部切换确实发生，再释放 fixture 执行恢复，最后独立查询结果。它不捕获键盘/鼠标，不能替代物理 Caps 的两机验收；产物默认在 `.tmp/input-source-guard`，远程执行时归入对应任务的产物目录。

## 启动页面检测与刷新

- 服务启动后等待本地页面重连：已使用新版本页面的场景约 1.2 秒，旧版页面首次升级兜底 3.2 秒。
- SSE 的 retry 设为 300ms，页面在 EventSource URL 带 `client=2`，服务端据此记录快速客户端。
- 检测到本地页面则不再自动打开新浏览器；否则打开实际端口地址。
- 启动窗口结束后向本地页面和直接接入本机的浏览器设备广播 `reload`，页面收到后刷新；来源 IP 是其它 npx 主机的不刷新，那些页面由各自的进程通知。
- 关闭服务时会向现有 SSE 客户端补发 `retry: 300`，方便下次启动快速重连。

## 多语言

WebUI 的文案使用 jinge 的 `t()`。首次打开按 `navigator.languages` 选择 `zh-CN` / `zh-TW` / `en`，手动切换后写入 `localStorage` 的 `lanfly.locale`，不改 URL。

```sh
pnpm -C packages/webui intl:extract   # 扫描 src，生成/更新 intl/translate.csv
# 翻译 CSV 的 zh-TW 和 en 列
pnpm -C packages/webui intl:compile   # 生成 src/intl/{zh-CN,zh-TW,en}.tsx
```

`main.tsx` 在 `bootstrap` 前调用 `intlInit`，并通过动态 import 加载语言字典。目录中的生成文件不要手工修改，改源文案后重新 extract/compile。

## 配置与状态

`data.json` 位于运行 `cli.js` 所在目录，默认是 `dist/data.json`；可用 `LANFLY_CONFIG_DIR` 指定目录。它不会提交到 Git，也不会包含在 npm 发布包里。

常见键：

- `roomId`：持久化的 Room ID。
- `input`：键鼠共享的角色、位置、对端地址、自动恢复开关。
- `browser`：浏览器会话的签名密钥。
- `desktopBitrates`：按目标设备名称保存上次选择的远程桌面码率。
- `desktopResolutions`：按主控、受控设备名称组成的有向 pair 保存分辨率偏好；每项包含 `controller`、`controlled` 和 `choice`，后者是 `keep`、`fit` 或 `{ width, height }`。
- `startupFastClient`：已出现过快速重连页面，用于缩短启动检测窗口。

不保存聊天内容、文件名历史或键盘输入。重新构建会保留 `data.json`。

## 开发命令

```sh
pnpm install       # 同时安装本地 Bun
pnpm build:native  # macOS：编译 Rust/Neon 原生模块
pnpm dev           # Vite 8080 + 本地服务 8087
pnpm build         # 构建 dist/cli.js 和 dist/public
pnpm start         # 运行构建产物
pnpm test          # 单元 + 双实例集成测试
```

构建和开发脚本是 TypeScript，由 Bun 执行；发布到 npm 的 `lanfly` 包仍使用 Node 运行。

键鼠和远程桌面实现位于 `native/`（Rust/Neon/Quartz/ScreenCaptureKit/VideoToolbox/webrtc-rs）以及 `packages/server/src/input/`、`packages/server/src/desktop/`。本地开发需要先运行 `pnpm build:native` 生成 `native/index.node`；`pnpm build` 只构建 JS 和 WebUI，不要求其它系统安装 Rust。

本机界面的远程桌面在画面区域获得焦点时，通过本机原生组件捕获键盘；鼠标仍按视频坐标转发。Caps Lock 使用物理按下通知，和普通按键共用有序通道。主控端需要辅助功能和输入监控权限。失焦、最小化、断连会释放捕获；原生层还会在前台进程改变或 750ms 未续约时自动释放。Ctrl + Option + Command + Esc 可紧急释放本机键盘。焦点请求使用页面标识和递增版本，避免延迟请求重新捕获键盘。浏览器设备页面继续使用浏览器键盘事件。

远程桌面双方均可用标题栏的最小化按钮回到聊天和文件传输，点击顶部“屏幕共享中”恢复同一会话；最小化保留视频连接，并释放主控端键盘。

主控画面默认铺满浏览器可用空间，可切回普通窗口或全屏。缩放支持适应窗口、原始像素（考虑本机像素密度）及相对适应尺寸的 125%–300%；放大后可用“拖动画面”或鼠标中键平移，滚轮继续发送给远端。视频实际边界同时用于点击坐标映射。

全屏时隐藏状态栏、底部提示和权限信息，画面占满视口；顶部居中浮动工具栏提供退出全屏、缩放、平移、最小化和停止。鼠标移到顶部展开，移开后收起；工具栏操作不转发给远端。

连接前可选择远端支持的逻辑桌面分辨率，或适配主控屏幕。适配时优先读取主控原生显示器像素尺寸，浏览器设备使用屏幕尺寸乘像素密度；与受控模式的实际 backing 像素比较，避免混用 Retina 逻辑尺寸。原生枚举按实际切换时相同的密度、刷新率优先级选择每个逻辑尺寸的 backing 像素。底部明确显示视频分辨率。

分辨率偏好写入提供主控 RPC 的 lanfly 实例的 `data.json`，按主控、受控设备名称 pair 分别保存，读取时使用当前主控名称筛选；浏览器设备以其设备名称作为主控名称。`fit` 每次按当时屏幕重新计算，固定模式不再受支持时回退为保持当前；不再依赖浏览器 localStorage。原生层在采集开始前切换，会话停止或启动失败时恢复原模式；受控端用户主动选择其他模式后不会被覆盖。分辨率在会话期间固定，最小化保留当前模式。旧原生组件或旧对端不支持枚举时保留原设置。

`pnpm build && node script/test-desktop-display.mjs` 在 macOS Chrome 无界面模式下验证分辨率选项和请求、铺满/全屏、缩放平移及点击坐标，不切换真实显示器、不捕获系统键盘。

## Git hooks

`pnpm install` 会执行 `prepare` 安装 husky。提交前 `.husky/pre-commit` 会依次执行：

1. `lint-staged`：对暂存的 TS/TSX 运行 `oxlint --type-aware --fix` 和 `oxfmt`，对 JS/JSON/Markdown/YAML 运行 `oxfmt`；
2. `cargo fmt --manifest-path native/Cargo.toml -- --check`；
3. `cargo clippy --manifest-path native/Cargo.toml --locked --all-targets -- -D warnings`。

任一步失败都会阻止提交。CI 中设置 `HUSKY=0`，不会安装或执行本地 hook。

## 原生包与发布

- 正式包按平台/架构使用可选的预编译包：`lanfly-input-darwin-arm64` / `lanfly-input-darwin-x64`。
- `.github/workflows/ci.yml` **只支持手动触发**（`workflow_dispatch`），不会在 push 或 PR 后自动发布。
- 手动触发后依次执行：
  1. `verify`：安装、lint、构建（不跑测试）；
  2. `native` matrix：两个 macOS 架构分别编译、smoke test，并直接发布对应的 platform 包（不跑 cargo test）；
  3. `publish`：等待所有 platform 包完成后，构建并发布根包 `lanfly`。
- 两个 platform 包和主包都使用 npm trusted publishing，需要在 npm 上为三个包配置 trusted publisher。
- 已存在的版本会被跳过，重复运行是安全的。
- `.github/workflows/test.yml` 也只支持手动触发，按需运行 lint、构建和测试，不发布，不会在 push / PR 后自动执行。
- 发布新版本前运行 `npm version patch`（或指定版本）。`version` 钩子会同步：
  - `platform/*/package.json` 版本；
  - 根包 `optionalDependencies`；
  - `native/Cargo.toml` 和 `native/Cargo.lock`；
  - `pnpm-lock.yaml` 中的 platform specifier；
  - `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；
  - 并把修改加入 `npm version` 的提交。
- 当前仓库版本若已经发布，需要先递增版本再发布包含新功能的主包。

## 测试

- `pnpm test`：共享类型、协议、浏览器设备、键鼠角色协商、双实例连接、Room ID、远程桌面自动接受/身份校验等。
- 测试使用模拟原生层，不会监听或注入真实键鼠。
- `cargo test --manifest-path native/Cargo.toml --locked`：原生边界逻辑和输入校验。
- `pnpm typecheck`、`pnpm lint` 检查 TypeScript 和代码风格。
- 真实设备验收需要两台已授权的单屏 Mac，覆盖边缘切换、修饰键/鼠标释放、滚动、断网、紧急停止、显示器热插拔和远程桌面权限/画质。

## 两台 Mac 的远程调试

`script/remote-test.ts` 是独立于产品服务的开发工具。接收端只需持续运行一次，控制端可反复发送新脚本、更新指定源码文件，并取回日志和截图。持有令牌即可在接收端执行当前用户权限下的任意脚本，只用于可信局域网，结束时在接收端按 Ctrl+C。

接收端同步源码、安装依赖后，在已经授予辅助功能、输入监控及屏幕录制权限的终端中启动：

```sh
pnpm remote-test serve
```

默认监听所有网卡的 `8098` 端口。终端会显示 `LANFLY_REMOTE_URL=... LANFLY_REMOTE_TOKEN=...`；把这行交给当前调试会话即可。首次生成的随机令牌保存在被 Git 忽略的 `.tmp/remote-test/token`，重启沿用；可通过同名环境变量指定令牌，通过 `LANFLY_REMOTE_PORT` / `LANFLY_REMOTE_HOST` 指定端口与监听地址。首次启动如有系统入站连接提示，需要允许该终端/Bun 接收局域网连接。

控制端设置接收端提供的两个变量后使用：

```sh
export LANFLY_REMOTE_URL=http://192.168.1.20:8098
export LANFLY_REMOTE_TOKEN=接收端输出的令牌

pnpm remote-test status
pnpm remote-test run script/remote-input-probe.ts
pnpm remote-test run script/remote-input-probe.ts --screenshot

# 只同步列出的源码，不执行 git pull、不覆盖整份工作区。
pnpm remote-test push native/src/macos_input_source.rs native/src/input_source_bridge.m

# 本地脚本会以文件内容发送，接收端无需事先拥有同名文件。
# 重建等较长的任务可提高超时上限（最高 600000ms）。
LANFLY_REMOTE_TIMEOUT_MS=600000 pnpm remote-test run .tmp/remote-rebuild.sh
pnpm remote-test cancel 任务ID
pnpm remote-test get 任务ID
```

`remote-input-probe.ts` 是第一份可随时更新的任务脚本，默认只读：记录原生模块权限、输入源、系统与代码版本；`--screenshot` 额外采集屏幕。它不自动启动 lanfly，不注入按键或切换输入法。后续的构建、启动、按键、鼠标测试可写进新的任务脚本再发送。

任务以接收端仓库为工作目录，支持 Bun TypeScript（默认）、`.mjs` 的 Node 和 `.sh` 的 `/bin/sh`。传入脚本的参数原样保留。脚本可通过 `LANFLY_REMOTE_ROOT` 取得仓库目录，通过 `LANFLY_REMOTE_ARTIFACTS` 取得本任务产物目录；把截图等文件直接写到产物目录，控制端会自动下载。任务脚本位于临时目录，导入仓库代码时应从仓库绝对路径加载，不要使用相对任务文件的导入路径。

每次只运行一个任务，任务运行时禁止同步源码；默认超时 120 秒，超时或取消会终止任务及其普通子进程。每路输出保留末尾 1 MiB，单个产物上限 20 MiB。接收端结果位于 `.tmp/remote-test/jobs/任务ID`，控制端下载位于 `.tmp/remote-test/downloads/任务ID`，其中 `result.json` 是执行结果、`artifacts/` 保存截图等产物。

源码同步校验 SHA-256，覆盖前把旧文件备份到 `.tmp/remote-test/backups/备份ID`；新文件也会记在备份清单中。同步仅接受明确指定的相对文件路径，拒绝符号链接、父目录跳转、隐藏目录、`data.json`、构建产物及跨架构的 `.node` 文件。同步后需要通过任务脚本在接收端重新编译 native，并重启使用旧 addon 的 lanfly 进程。接收端自身的协议代码更新仍需重启接收端，普通任务脚本更新无需重启。

## 已知限制

- 聊天和文件是 HTTP 明文；远程桌面媒体使用 WebRTC/DTLS-SRTP，但信令和身份仍依赖局域网内的 Room ID。
- 发现、信令和聊天不支持跨 NAT、VLAN、VPN 或公网。
- 远程桌面只采集主显示器，不包含音频、剪贴板、文件跨屏拖拽；控制端指针形状不同步。
- 键鼠共享仅支持 macOS，不支持多指手势。
- 浏览器文件传输依赖发送页面保持打开；没有离线投递、断点续传、文件夹传输或历史记录。
