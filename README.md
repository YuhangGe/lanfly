# LanFly

English | [简体中文](README_ZH.md)

> A lightweight LAN workspace for chat, file transfer, Synergy-style keyboard/mouse sharing, and RustDesk-style remote desktop.

`lanfly` is a small LAN tool: run one command on two devices and they discover each other automatically. Chat, drag files over, or control another Mac directly. No account, cloud service, or central server is required — the browser is the interface.

![lanfly interface](docs/lanfly.png)

## What it does

- **Chat and file transfer**: text, images, archives, and any other file — just drag it into the window.
- **Automatic discovery**: devices on the same Wi-Fi/LAN appear automatically; you can also add an IP manually.
- **Phones and browsers**: open the host's LAN address to join as an independent device for chat and file transfer, or as a remote desktop controller.
- **Keyboard/mouse sharing**: share one keyboard and mouse between two single-display Macs, with edge switching, similar to Synergy.
- **Remote desktop**: view and control another Mac from a Mac, phone, or browser, with fullscreen, sharp Retina capture, and multiple quality levels, similar to RustDesk.
- **Room ID groups**: only hosts with the same Room ID discover and connect to each other.
- **No sign-in, no cloud**: no accounts or cloud storage; closing the terminal clears the current session.

## Quick start

1. On the first host, run:

   ```sh
   npx lanfly
   ```

2. The terminal prints the local address and Room ID. Open the address in a browser; on the other host, run:

   ```sh
   npx lanfly <Room ID shown on the first host>
   ```

3. Select the other device in the left sidebar to start chatting, send files, or open Keyboard & Mouse Sharing / Remote Desktop.

Requirements: Node.js 22 or later; both devices on the same LAN. Keyboard/mouse sharing and remote desktop require macOS 12 or later (remote desktop requires 12.3+).

### Common options

| Option           | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `--name <name>`  | Device name shown to others; defaults to the hostname          |
| `--port <port>`  | Local port, default `8087`; automatically increments if in use |
| `--out <dir>`    | Directory for received files; defaults to the system Downloads |
| `--no-open`      | Do not open the browser automatically                          |
| `--no-discovery` | Disable multicast discovery; you can still add an IP manually  |
| `--verbose`      | Print debug logs                                               |

```sh
npx lanfly --name "Living Room Mac"
npx lanfly 123456
npx lanfly --out ~/Downloads/lanfly
```

## Interface Language

Use the language button in the top-right to switch between **简体中文 / 繁體中文 / English**. The first launch follows your browser language; a manual choice is saved locally and reused next time. The language is never added to the URL.

## Remote Desktop (macOS)

View and control another Mac's desktop. The controller can be another lanfly host, or a browser or phone using the host's LAN address.

### Steps

1. On the controlled Mac, grant **Screen Recording** and **Accessibility** permissions to the terminal or Node process running lanfly in **System Settings → Privacy & Security**.
2. Start both hosts with the same Room ID. On the controller, click **Remote Desktop** in the device view or the top-right.
3. Select the device, choose a quality level if needed, and click **Start Remote Desktop**.
4. The controlled side does not need to click "Accept" — the connection is established automatically. Its local WebUI opens a status window showing who is viewing, with a **Stop Remote Desktop** button.
5. The controller can move the mouse, use the keyboard, and toggle fullscreen. Keyboard and mouse control is enabled together with remote desktop; no separate permission is needed.
6. While connected, either side can click **Minimize** to return to chat or file transfer. The controller restores it by clicking **Remote Desktop** in the current chat; the controlled side restores it from **Sharing screen** in the top bar. If A is already connected and you click Remote Desktop for B, lanfly first asks whether to end the session with A.

### Quality

- Five levels: 2 / 4 / 8 / 16 / 32 Mbps; default 4 Mbps. The choice is remembered per target device and restored next time.
- Captured at Retina physical pixels, up to 3840×2160, 30 FPS by default.
- Use **32 Mbps** for text, code, or design work; 16 or 8 Mbps is steadier for motion or weaker Wi-Fi.
- Only the primary display is captured on multi-display Macs.

### Notes

- Without Screen Recording or Accessibility permission, remote desktop cannot display or control correctly. Grant the permissions first.
- Only one remote desktop session is allowed at a time. Starting remote desktop stops any active Keyboard & Mouse Sharing session to avoid conflicting input.
- Audio, clipboard sync, and cross-screen file dragging are not included.
- Caps Lock is sent as an input-source switch to the controlled Mac. macOS may still switch the controller's own input source first.
- Remote desktop tries to capture browser shortcuts such as Cmd+N/T/W with the Keyboard Lock API. In Safari/Firefox, or when the lock is unavailable, some browser shortcuts may still work.
- The controller uses its own local pointer. Pointer shapes (text cursor, resize cursor, etc.) are not synchronized yet, and mouse movement made locally on the controlled Mac is not reflected in the controller's pointer.
- LAN only; NAT, VLAN, VPN, and the public internet are not supported.

## Keyboard & Mouse Sharing (macOS)

Turn two Macs into one keyboard and mouse setup. Useful when one Mac is connected to a monitor and the other sits beside it.

1. Start both hosts with the same Room ID and open **Keyboard & Mouse Sharing** in the local WebUI.
2. On both sides, grant **Accessibility** and **Input Monitoring** permissions to the terminal or Node process running lanfly, then click **Refresh Permissions**.
3. Select the other device, this device's role, and the client position, then click **Connect**. If one side is the host, the other automatically becomes the client.
4. Move the mouse past the screen edge to switch Macs; move it back past the adjacent edge to return.

Caps Lock is captured natively and sent as an input-source switch. The other Mac selects its own source, while the controller checks and restores its local source. This path does not depend on browser APIs. Physical-key compatibility across two Macs is still being tested; see [BUG.md](BUG.md) for diagnostics.

Press **Ctrl + Option + Command + Esc** on either side or click **Stop Sharing** to stop both sides. Only one device can be connected at a time. Clipboard sync, cross-screen file dragging, and multi-finger gestures are not included. macOS only.

## Phones and Browsers

Open the LAN address printed by the terminal in a phone or another computer's browser, for example `http://192.168.1.10:8087`, to join as an independent device. Node.js is not required.

- Browser devices can chat, transfer files, and act as remote desktop controllers.
- The browser uses a platform-based name by default; click your own name in the left sidebar to rename it.
- The same browser at the same address keeps its identity after a refresh.
- Files sent to a browser device create a download invitation valid for 30 minutes. Keep the sending page open; refreshing, closing the page, or leaving the phone in the background for a long time may interrupt the transfer.
- The browser page represents the browser device only and cannot change host settings or configure Keyboard & Mouse Sharing.

## Discovery

lanfly hosts on the same LAN appear automatically, usually within a few seconds.

If the other device does not appear:

1. Click **Add Device** in the top-right.
2. Enter the other device's IP, for example `192.168.1.23`; if the port is not 8087, use `192.168.1.23:8088`.
3. Make sure both hosts use the same Room ID.

Manually added devices stay in the list and appear gray when offline.

## Sending Files

- Drag files into the chat window;
- click the paperclip to the left of the input;
- or paste a screenshot.

Multi-select, progress, and cancellation are supported. Files stream from the sending page and are not cached on the intermediary host. Name collisions become `file (1).ext` and never overwrite existing files. Files sent to a host are accepted automatically; files sent to a browser require the receiver to click the download invitation. Only use lanfly on a trusted network.

## Room ID

Room IDs isolate groups: only hosts with the same Room ID discover and connect to each other. A phone or browser opening the LAN address joins the host's group directly.

A Room ID is only a grouping identifier, not a password, and does not replace the LAN's own access controls.

## Security

lanfly is designed for trusted LANs, similar to LocalSend. It is not a tool for the public internet.

- Chat and file contents use plaintext HTTP; anyone who can capture traffic on the same network can read them.
- A Room ID is not an access password. Anyone who can open the host's web page can join as a browser device.
- Remote desktop automatically accepts requests from discovered devices in the same Room ID and enables keyboard/mouse control. Use it only on a fully trusted LAN, and click **Stop Remote Desktop** on the controlled side when sharing is no longer needed.
- NAT, VLAN, VPN, and the public internet are not supported.
- Offline messages, resumable transfers, folder transfer, and history are not supported. Closing the terminal clears the current session's devices, messages, and transfer records; files already saved locally remain.

## FAQ

**The other device is not visible.**

Make sure both devices are on the same subnet and allow UDP `53318` and TCP `8087` (or the actual fallback port) through the firewall. If multicast is disabled, use **Add Device** to enter the IP manually.

**The port is already in use.**

lanfly starts at `8087` and automatically tries the next port; the terminal prints the actual address. You can also use `--port`.

**Remote desktop shows no video, or the mouse/keyboard does not work.**

Check Screen Recording and Accessibility permissions on the controlled Mac, then restart the terminal running lanfly. The controlled side's status window shows a hint when permissions are missing.

**Remote desktop is not sharp enough.**

Choose 16 Mbps or 32 Mbps. lanfly captures at Retina physical resolution, up to 3840×2160. If it still looks blurry, check that the controlled Mac is not using a scaled low-resolution display mode.

**Where are received files saved?**

`~/Downloads` by default; `%USERPROFILE%\Downloads` on Windows. If the Downloads folder is redirected (for example by OneDrive), use `--out` to choose a directory.

**Do chats survive a restart?**

No. lanfly keeps only in-memory state for the current run; closing the terminal clears it. Files already downloaded locally are not affected.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development, build, native modules, release process, and implementation details.

## License

MIT
