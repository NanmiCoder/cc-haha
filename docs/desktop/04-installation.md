# 安装、升级与 Web UI

Claude Code Haha Desktop 提供 macOS、Windows 和 Linux 安装包。普通用户应优先使用 GitHub Release，而不是从源码启动。

## 下载正确的安装包

前往 [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) 下载最新正式版本：

| 平台 | 安装文件 |
|------|----------|
| macOS Apple Silicon（M 系列） | `Claude-Code-Haha-<版本>-mac-arm64.dmg` |
| macOS Intel | `Claude-Code-Haha-<版本>-mac-x64.dmg` |
| Windows x64 | `Claude-Code-Haha-<版本>-win-x64.exe` |
| Windows ARM64 | `Claude-Code-Haha-<版本>-win-arm64.exe` |
| Linux x64 | `Claude-Code-Haha-<版本>-linux-x86_64.AppImage` 或 `...-linux-amd64.deb` |
| Linux ARM64 | `Claude-Code-Haha-<版本>-linux-arm64.AppImage` 或 `...-linux-arm64.deb` |

macOS 可从「关于本机」查看芯片；Windows 可在「设置 → 系统 → 系统信息」查看系统类型。不要仅凭设备品牌猜测架构。

## macOS

1. 打开 DMG。
2. 把 Claude Code Haha 拖到「应用程序」。
3. 从「应用程序」打开。

正式 macOS Release 使用 Developer ID 签名和公证，通常只会显示标准的下载来源确认。

只有旧版或明确标注为 unsigned 的临时构建才可能需要手动放行。确认安装包确实来自本仓库后，可以在「系统设置 → 隐私与安全性」选择仍要打开。不要对来源不明的应用运行解除隔离命令。

## Windows

1. 完全退出正在运行的旧版 Claude Code Haha。
2. 直接双击 `.exe`，以当前用户安装。
3. 不要主动选择「以管理员身份运行」。

未签名构建可能触发 SmartScreen。确认文件来自本仓库 Release 后，可选择「更多信息 → 仍要运行」。

覆盖升级时，安装器会检查相关进程和旧安装目录中的用户数据。它会在可以确认来源与用户身份时恢复历史数据；遇到进程占用、来源歧义或复制失败时会停止安装，而不是猜测迁移。

如果安装器提示程序仍在运行：

1. 退出主窗口和托盘中的应用。
2. 等待几秒，让 sidecar 和 adapter 退出。
3. 仍失败时，在任务管理器中检查 Claude Code Haha 相关进程。
4. 重新运行安装器，不要先删除旧数据目录。

若你曾把重要资料放进安装目录，升级前仍建议单独备份。安装器的恢复保护不是通用备份方案。

## Linux

### AppImage

```bash
chmod +x Claude-Code-Haha-<版本>-linux-x86_64.AppImage
./Claude-Code-Haha-<版本>-linux-x86_64.AppImage
```

ARM64 机器请换用 `linux-arm64.AppImage`。

Ubuntu 22.04 及更早版本缺少 FUSE 时可安装 `libfuse2`；Ubuntu 24.04 及更新版本通常使用 `libfuse2t64`。

### deb

```bash
sudo apt install ./Claude-Code-Haha-<版本>-linux-amd64.deb
```

ARM64 机器请换用对应的 `linux-arm64.deb`。

## 首次启动检查

安装完成后，按这个顺序验证：

1. 打开「设置 → 服务商」，完成官方登录或 API Provider 配置。
2. 新建会话并选择一个可读写的测试项目。
3. 使用「询问权限」发送一个只读任务。
4. 确认回复、工具调用和停止按钮正常。
5. 再测试文件修改、Diff 和权限拒绝。

不要把 H5、Auto、跳过权限、Computer Use 和 IM 一次全部打开。逐项启用更容易判断故障位于模型、桌面服务还是外部入口。

## 应用内更新

正式安装包会通过 GitHub Releases 检查更新，并下载当前平台的更新资产。

更新前：

- 保存项目中的未提交工作。
- 等待或停止正在运行的会话、定时任务和 SubAgent。
- 完全退出应用后再安装。

覆盖安装和应用内更新不应删除正常用户目录中的会话、Provider、Skills、Agents、记忆和自定义宠物。若升级后列表暂时为空，先不要删除配置；打开「设置 → 诊断」检查本地索引状态，必要时只重建派生索引。

Windows 与 Linux 的真实安装行为依赖对应 Release 产物；其他平台上的本地构建通过不等于当前平台已经完成安装验证。

## 从源码运行同源 Web UI

服务端可以直接提供构建后的 Web UI。这样页面、REST API 和 WebSocket 使用同一个 `3456` 端口，最接近 H5 与发布版的同源路径。

```bash
# 项目根目录
bun install

# 构建 Web UI
cd desktop
bun install
bun run build
cd ..

# 只允许本机访问
SERVER_HOST=127.0.0.1 SERVER_PORT=3456 bun run src/server/index.ts
```

打开：

```text
http://127.0.0.1:3456/
```

本机回环访问不需要开启 H5，也不需要 H5 Token。这个豁免只适用于真正的本地访问，不会自动扩展到局域网地址或反向代理。

如果服务不是从项目根目录启动，设置 `CLAUDE_H5_DIST_DIR` 指向 `desktop/dist` 的绝对路径。缺少构建产物时 API 仍可能启动，但浏览器根路径会返回 404。

## 前端热更新开发模式

需要修改 React 页面时，可以把前端开发服务器和后端分开运行：

```bash
# 终端 1：项目根目录
SERVER_HOST=127.0.0.1 SERVER_PORT=3456 bun run src/server/index.ts

# 终端 2
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

打开：

```text
http://127.0.0.1:2024/?serverUrl=http%3A%2F%2F127.0.0.1%3A3456
```

这条双端口路径只用于开发热更新。手机访问、反向代理和部署排查应优先使用构建后的 `3456` 同源路径，减少 CORS 与 WebSocket 配置变量。

## 无桌面环境的 Linux 主机

最安全的个人访问方式是 SSH 端口转发：

```bash
# 服务器：按上一节构建后，只监听回环地址
SERVER_HOST=127.0.0.1 SERVER_PORT=3456 bun run src/server/index.ts

# 自己的电脑
ssh -L 3456:127.0.0.1:3456 user@example.com
```

随后在自己的电脑打开 `http://127.0.0.1:3456/`。因为服务没有暴露到局域网，这条路径不需要 H5 Token。

需要让手机或反向代理直接访问时，必须显式启用 H5、生成 Token，并理解公网暴露边界。参见[H5 访问](./06-h5-access.md)。

## 安装后仍无法启动

按以下顺序排查：

1. 确认下载的平台和 CPU 架构正确。
2. 确认旧版本进程已经退出。
3. 重新启动应用，而不是反复覆盖安装。
4. 打开「设置 → 诊断」复制错误摘要或导出诊断包。
5. 查看[常见问题](./05-FAQ.md)，再携带版本、系统、复现步骤和脱敏诊断信息求助。
