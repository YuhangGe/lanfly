# Caps Lock 没有切换受控端输入法

- **状态**：未解决，后续处理
- **记录日期**：2026-11-11
- **影响版本**：lanfly 0.3.x
- **影响场景**：键鼠共享、远程桌面
- **平台**：macOS

## 现象

在两台 Mac 之间启用键鼠共享，把光标移到受控端后按 Caps Lock：

- 主控端自己的输入法被切换；
- 受控端输入法没有切换；
- 远程桌面也有同样现象。

期望行为：

- 主控端输入法保持不变；
- 受控端切换到自己的另一个输入源（例如中文/英文）。

## 复现步骤

1. 两台 Mac 运行同一 Room ID 的 lanfly。
2. 建立键鼠共享，鼠标从主控端移入受控端。
3. 在主控端按 Caps Lock。
4. 观察主控端输入法变化，以及受控端输入法是否切换。
5. 在远程桌面中重复按键，现象相同。

## 当前实现

### 键鼠共享

- `native/src/keyboard.rs` 的 `InputSourceKey` 把 Caps Lock 的 `flagsChanged` 当作输入源切换，并做 300ms 去抖。
- `native/src/macos.rs` 在远端状态下把 Caps Lock 转为 `input-source` 事件，并调用 `macos_input_source::capture()` 尝试恢复主控端输入源。
- 受控端收到 `input-source` 后：
  1. 优先调用 `native/src/hid.rs` 的 `post_caps_lock()`，通过 `IOHIDPostEvent` 的 `NX_FLAGSCHANGED` 注入 Caps Lock；
  2. 失败时回退到 `macos_input_source::toggle()`。

### 远程桌面

- 浏览器端 `packages/webui/src/service/desktop-input.ts` 尝试拦截 Caps Lock，并发送 `{ t: 'source' }`。
- 原生 `native/src/desktop_input.rs` 收到 `source` 后走同一 HID/TIS 路径。

### 已尝试

- `keydown` 捕获、`preventDefault()`、`stopImmediatePropagation()`；
- Keyboard Lock API；
- 把 Caps Lock 识别为 `input-source` 并让受控端切换输入源；
- 按 Deskflow 的方式使用 `IOHIDPostEvent` 注入 Caps Lock；
- 主控端通过 `macos_input_source::capture()` 恢复输入源。

以上均未解决问题。

## 初步分析

1. macOS 的“使用大写锁定键切换输入法”是系统级快捷行为，可能在应用事件到达前就已切换主控端输入源。
2. 主控端事件可能没有以预期的 `flagsChanged(key=57, AlphaShift)` 形式到达，或到达时输入源已经被系统改掉。
3. `TISSelectInputSource()` 对第三方输入法（如搜狗、Rime）可能返回成功但实际不切换，或被 Secure Input 阻止。
4. `IOHIDPostEvent` 注入的 Caps Lock 是否等同于物理按键、是否需要额外的 event flags/权限，尚未确认。
5. Deskflow 主要把 Caps Lock 当修饰键转发，并另有语言同步机制；它并没有简单地把 Caps Lock 当作输入源切换，直接照搬不一定适用。

## 后续排查

- [ ] 在真实按键时记录原生事件 tap 的 `type/keyCode/flags`，确认 Caps Lock 的实际事件形态。
- [ ] 记录主控端 `macos_input_source::capture()` 的快照、当前源、`TISSelectInputSource()` 返回值。
- [ ] 在受控端记录 `IOHIDPostEvent` 返回值，并分别验证：
  - 只发 Caps Lock key down；
  - 发 flagsChanged down/up；
  - 设置 AlphaShift 标志；
  - 对比 TIS 直接切换。
- [ ] 检查受控端是否启用了 Secure Input，以及第三方输入法是否允许程序化选择。
- [ ] 对比 Deskflow 的 language sync/group 方案，评估是否改为显式语言同步而不是依赖 Caps Lock。
- [ ] 如果系统层无法拦截，考虑文档说明关闭“使用大写锁定键切换输入法”，或提供可配置的远端输入法快捷键。

## 验收标准

- 键鼠共享中按 Caps Lock，主控端输入源不变，受控端在两个已启用输入源之间切换。
- 远程桌面中行为一致；浏览器无法拦截系统快捷键时，至少不误切换主控端输入源。
- 至少覆盖 macOS 自带拼音/英文输入源和一种第三方输入法。

## 相关文件

- `native/src/keyboard.rs`
- `native/src/macos.rs`
- `native/src/macos_input_source.rs`
- `native/src/hid.rs`
- `native/src/desktop_input.rs`
- `packages/webui/src/service/desktop-input.ts`

## 2026-11-12 排查结果

结论：需要把“主控端截获”“消息送达”“受控端实际切换”分别验证。目前已有数个可由代码确认的问题，但还没有两台 Mac 的物理按键记录，不能标记为已修复。此次增加独立诊断工具，不改正式输入路径。

### 代码可确认的问题

| 环节             | 发现                                                                                                                                                               | 影响与处理方向                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受控端回退       | `macos.rs::inject()` 使用 `post_caps_lock()                                                                                                                        |                                                                                                                                                                                  | toggle()`；`desktop_input.rs` 等价。HID 成功仅表示调用返回 0，没有检查输入源 | HID 注入成功但输入法未变时，TIS 永远不会执行。不能仅反转两者顺序：TIS 也可能返回成功但未完成切换 |
| TIS 线程         | `desktop.rs::on_data_channel()` 在 `runtime.spawn()` 内直接调用 `desktop_input::handle()`，会进入 TIS 回退；`macos_input_source.rs` 的“只在 JS 线程调用”注释不成立 | Apple `TextInputSources.h` 明确声明 API 非线程安全：UI 应用须主线程调用，非 UI 工具不得多线程并发调用。当前缺少跨路径串行化；Tokio 任务也不保证固定线程                          |
| 输入源记忆       | `SOURCES` 是 `thread_local!`                                                                                                                                       | Tokio 回调换工作线程时不共享 `non_ascii` 记忆；即使各线程的 RefCell 安全，也不能保证 TIS 调用之间安全                                                                            |
| Caps 识别        | key=57 按时间去抖，key=255 则独立按 flags 边沿识别                                                                                                                 | 如果一次按键同时产生 57 和 255，会发送两次切换；57 通知相隔超过 300ms 也会发送两次，300ms 内的第二次真实按键则可能丢失。实际事件序列需要采集，不能用现有单元测试证明物理按键正确 |
| 本机恢复         | `capture()` 只在识别出 `input-source` 后启动 500ms 恢复窗口                                                                                                        | 没收到或没识别出通知时不会恢复；`restore()` 又只看 TIS 返回值。快照捕获和系统切换的先后也需要实测。延长恢复窗口不能解决截获层级问题                                              |
| HID 状态         | 当前固定发送 AlphaShift → 0，并指定 `kIOHIDSetGlobalEventFlags`                                                                                                    | 这是全局修饰状态写入，不是通用的物理 Caps 按下/松开模拟；没有保留已按下的其他修饰键。`OnceLock` 还会永久缓存首次打开驱动失败的 0                                                 |
| 浏览器焦点       | `DesktopControl.#caps()` 在 window 捕获阶段工作，不检查 stage 是否拥有焦点                                                                                         | 控制对象 attach 期间，在页面其他输入框按 Caps 也可能发送远端切换并吞掉 DOM 事件，应该加焦点/控制权约束                                                                           |
| 浏览器本机输入源 | 浏览器路径没有调用原生 `capture()`                                                                                                                                 | 页面 `preventDefault()` 和事件传播控制不能撤销已发生的系统输入源切换。Keyboard Lock 也不保证截获所有系统行为，当前验收标准中的“不误切换主控端”不能由纯网页保证                   |

另一个时序风险：TIS 与键盘注入不在同一个系统事件队列。即使切换最终成功，紧随其后的字符也可能仍被旧输入法处理。远程桌面还存在 JS 调用与 WebRTC 工作线程两条输入入口，调整线程模型时需要一起考虑顺序。

### 开源实现对照

以下核对的是排查当天上游分支内容，后续可能变化；这些实现提供设计依据，不代表已经验证 lanfly 的故障原因。

- [Deskflow OSXKeyState.cpp](https://github.com/deskflow/deskflow/blob/master/src/lib/platform/OSXKeyState.cpp)：`postHIDVirtualKey()` 确实使用 `NX_FLAGSCHANGED`，但 flags 来自完整的修饰键状态；语言 group 另走 `setGroup()` / TIS，并用 `g_tisMutex` 串行化。源码还说明 TIS 与 CG 队列独立，切换后留了约 10ms。它不能证明“注入 Caps = 输入源切换”。
- [Karabiner 开发说明](https://github.com/pqrs-org/Karabiner-Elements/blob/main/DEVELOPMENT.md)：CGEventTap 观察到的是 macOS 处理后的 Caps 状态，非物理按下/松开；真正的设备截获与虚拟 HID 键盘是另一层。Secure Event Input 会阻止 tap 接收键盘事件，因此它首先是捕获侧检查项，不能直接归因成 TIS 选择被阻止。
- [Karabiner 输入源切换文档](https://karabiner-elements.pqrs.org/docs/json/complex-modifications-manipulator-definition/to/select-input-source/)：明确记录带 input_mode_id 的中日韩越输入源可能选择失败，建议发送输入源切换快捷键（如 Control-Space）。因此第三方与自带拼音都需要验证，不能只测 ABC。
- [RustDesk input_service.rs](https://github.com/rustdesk/rustdesk/blob/master/src/server/input_service.rs)：macOS 的 `handle_key()` 投递到主队列；Caps 通过 `VirtualInputState.capslock_down` 与按下/松开函数维护，另有输入时序处理。这是锁定状态同步，不是通用的输入法切换动作。
- [Keyboard Lock 规范](https://wicg.github.io/keyboard-lock/#handling-keyboard-events)：接口受安全上下文限制，系统键处理与全屏相关，并且是尽力而为；成功返回不证明系统 Caps 输入源快捷行为已被拦截。通过局域网 HTTP 打开的页面还应检查 `window.isSecureContext` 与 `navigator.keyboard`。

### 已做的本机验证

- 独立探针使用系统头文件直接构造 `NXEventData`，在本机以 `-Wall -Wextra -Werror` 编译通过。
- 只读检查得到 `sizeof(NXEventData)=48`、`offsetof(key.keyCode)=8`。因此当前 Rust 注入中 keyCode 的偏移 8 正确，不应把它当首要嫌疑。
- 现有 `keyboard.rs` 的 5 项单元测试通过；另用当前实现输入 57 → 255、间隔 350ms 的两个 57 通知，均确认产生两次切换动作。这验证了状态机的行为，不证明物理键盘一定产生这些序列。
- 沙箱内查询出现 `hiservices-xpcservice` 连接失败，仅返回 ABC，权限也显示不可用；沙箱外同一只读命令能读到 ABC 和已启用的第三方输入模式，监听/注入权限可用、Secure Input 为 false。说明诊断必须在真实 GUI 用户会话内执行，不能把沙箱结果当真实配置。
- 没有自动注入按键、切换当前输入源或修改系统偏好。尚未验证两机真实按键、HID/TIS 的实际切换结果以及自带拼音兼容性。

### 独立探针与实验步骤

工具：`script/diagnose-input-source.m`。JSONL 输出带时间、源 ID / mode ID、Secure Input、tap 层级和 HID/TIS 返回码；只记录 Caps/255，不记录普通字符。所有 TIS 调用在探针主线程执行，不依赖 lanfly 的线程和网络路径。

```sh
mkdir -p .tmp
xcrun clang -fobjc-arc -Wall -Wextra -Werror -Wno-deprecated-declarations \
  script/diagnose-input-source.m -framework Foundation \
  -framework ApplicationServices -framework Carbon -framework IOKit \
  -o .tmp/diagnose-input-source
.tmp/diagnose-input-source status
.tmp/diagnose-input-source watch > .tmp/caps-watch.jsonl
```

`watch` 同时监听 HID 和 session tap，运行 30 秒后退出，不吞事件。先退出 lanfly/其他改键软件采集基线，再开启 lanfly 重复采集；另一个 head-insert tap 可能先吞事件，所以“没日志”本身不能证明硬件没有发出事件。分别测试短按、长按、快速连按及 Caps 切输入源开关的两种配置。

以下是主动实验，按需逐项执行。探针不请求权限弹窗；需要运行它的终端已有辅助功能/输入监控权限。不要使用 sudo，必须在当前 GUI 用户会话内运行。

```sh
# 主控端：30 秒内吞掉 Caps/255，观察输入源是否仍先发生变化。
.tmp/diagnose-input-source suppress

# 受控端：先关闭 lanfly 和其他事件过滤器，各项执行前确认当前源不同于目标源。
# 注入模式预留 3 秒切焦点到普通文本编辑器；测试时松开其他修饰键。
.tmp/diagnose-input-source hid-alpha
.tmp/diagnose-input-source hid-stateless
.tmp/diagnose-input-source hid-key
.tmp/diagnose-input-source shortcut
.tmp/diagnose-input-source tis com.apple.keylayout.ABC
# 反向切到 status 列出的可选择中文源 ID，再比较返回码和后续 source 记录。
```

| 实验                                    | 判读                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `suppress` 吞事件后本机源仍变化         | 当前 CGEventTap 层无法在这组系统配置下阻止切换；恢复策略与更低层截获需要分开评估                                                    |
| `hid-alpha` 返回 0，但 1 秒内源始终未变 | 直接确认当前“成功即完成”的判断不足；还要看是否只改变了 Caps 状态/LED                                                                |
| `hid-stateless` 成功而 alpha 失败       | stateless flags 是后续候选，仍需双向、连续按键与真实应用验证；该实验还引入了 80ms 间隔，不能单凭一次结果归因给 flags                |
| `hid-key` 成功                          | 普通 NX_KEYDOWN/UP 路径值得继续验证；它与 flagsChanged 路径不等价                                                                   |
| `tis` 返回 0 但源未变                   | 用不同输入源复测，并比较 mode ID；不能只凭 OSStatus 宣称成功，也不能立即补发第二种切换造成双切                                      |
| `shortcut` 成功、TIS 失败               | 优先评估发送受控端配置的输入源快捷键。当前探针固定 Control-Space，须先确认该绑定存在且启用；正式实现应读取/允许配置，不能假设默认值 |
| 独立探针成功，lanfly 失败               | 回查正式路径的线程、权限归属、消息送达和注入顺序，避免继续改 HID flags                                                              |

输入源记录最多能验证系统报告的源，不能证明第三方输入法内部中英文状态及实际组字成功。每项还需要在编辑器输入文字，观察候选框/大小写；至少覆盖 ABC ↔ 自带拼音、ABC ↔ 一种第三方输入法，以及连续切换后立即打字。

### 建议的处理顺序

1. 用探针确认捕获侧实际事件形态和接收侧有效切换方式；在正式路径补上“识别 → 发送 → 接收 → 尝试 → 延迟观察”的关联日志。不要在 tap 回调中执行 TIS 或阻塞等待。
2. 把 TIS 访问集中到符合 Apple 线程要求的执行入口，并集中保存控制器状态；维护输入流顺序，处理异步切换期间紧随的字符。单独加互斥锁不能修复线程局部记忆问题。
3. 按物理事件证据调整 57/255 识别与去重，修复浏览器焦点约束；避免用 300ms 时间窗代替物理按键状态。
4. 如果实测支持快捷键切换，优先提供受控端输入源快捷键配置。若继续 TIS，加入有限时间的结果观察；若继续 HID，保留完整修饰状态并区分“已提交”和“已观察到切换”。
5. 对纯浏览器场景明确能力边界，提供显式的远端切换操作。若验收必须保证物理 Caps 完全不改变主控端，需要另行设计原生捕获/辅助程序或设备层方案，并验证；网页端代码无法单独承诺这一点。
