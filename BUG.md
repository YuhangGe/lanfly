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
