# 安装指南

桌面端基于 **Electron**，提供 macOS / Windows / Linux 安装包。`v0.4.3` 起的正式 macOS Release 使用 Developer ID 签名和 notarization；更早版本或临时开发包仍可能需要手动放行。

## 下载

前往 [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon / M 系列) | `Claude-Code-Haha-<版本>-mac-arm64.dmg` |
| macOS (Intel) | `Claude-Code-Haha-<版本>-mac-x64.dmg` |
| Windows (x64) | `Claude-Code-Haha-<版本>-win-x64.exe` |
| Linux (x64) | `Claude-Code-Haha-<版本>-linux-x86_64.AppImage` 或 `...-linux-amd64.deb` |
| Linux (ARM64) | `Claude-Code-Haha-<版本>-linux-arm64.AppImage` 或 `...-linux-arm64.deb` |

> 不确定 Mac 架构？点击左上角  → 关于本机，芯片为「Apple M…」选 arm64，「Intel」选 x64。

## macOS 安装

双击 DMG 把应用拖入 `Applications`。`v0.4.3` 起的正式 Release 正常情况下只会出现 macOS 的标准下载来源确认，不需要执行 `xattr`。

如果安装的是旧版或 unsigned 临时包，首次打开可能提示**"已损坏"**或**"无法验证开发者"**，再在终端执行：

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```

也可以在「系统设置 → 隐私与安全性」里点"仍要打开"。

## Windows 安装

双击 `.exe` 安装。首次运行如果 SmartScreen 弹出 **"Windows 已保护你的电脑"**，点击 **「更多信息」** → **「仍要运行」**。

## Linux 安装

AppImage：

```bash
chmod +x Claude-Code-Haha-<版本>-linux-x86_64.AppImage
./Claude-Code-Haha-<版本>-linux-x86_64.AppImage
```

> 提示缺少 FUSE：Ubuntu 22.04 及更早 `sudo apt install libfuse2`，24.04+ `sudo apt install libfuse2t64`。

deb：

```bash
sudo apt install ./Claude-Code-Haha-<版本>-linux-amd64.deb
```

## Web UI 模式

如果桌面端安装遇到问题，可以直接通过浏览器使用 Web UI。在项目根目录下分别启动服务端和前端：

```bash
# 1. 启动服务端（在项目根目录）
SERVER_PORT=3456 bun run src/server/index.ts

# 2. 启动前端（在 desktop 目录）
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

启动后浏览器访问 `http://127.0.0.1:2024` 即可。

## 常见问题

**Q: 这个版本会自动更新吗？**

`v0.4.3` 起的正式 Release 会通过 GitHub Releases 检查更新，并下载对应平台的更新包。首次迁移到 signed/notarized macOS 版本时，建议先手动下载安装 `v0.4.3`；后续版本可以走应用内更新。覆盖安装不会删除本地配置和会话数据（`~/.claude`）。
