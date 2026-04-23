# 安装指南

## 下载

前往 [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `Claude.Code.Haha_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Claude.Code.Haha_x.x.x_x64.dmg` |
| Windows (x64) | `Claude.Code.Haha_x.x.x_x64-setup.exe` |

> 不确定 Mac 架构？点击左上角  → 关于本机，芯片为 Apple M 开头选 aarch64，Intel 选 x64。

## macOS 安装

1. 双击 `.dmg` 文件，将应用拖入 `Applications` 文件夹
2. 首次打开如果提示**"已损坏，无法打开"**，在终端执行：

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```

> 由于应用暂未进行 Apple 开发者签名，macOS 会阻止首次运行，执行上述命令移除隔离属性后即可正常使用。

## Windows 安装

1. 双击 `.exe` 安装程序，按向导完成安装
2. 首次运行如果 SmartScreen 弹出警告，点击 **「更多信息」** → **「仍要运行」**

> 应用暂未进行 Windows 代码签名，仅首次运行需要此操作。

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

**Q: macOS 提示"来自身份不明的开发者"？**

右键点击应用 → 选择「打开」→ 在弹窗中点击「打开」，仅需操作一次。

**Q: Windows 提示缺少 WebView2？**

从 [Microsoft 官方](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) 下载安装 WebView2 运行时。
