# 常见问题与求助

## 遇到问题时，怎样最快获得帮助？

先确认正在使用 [GitHub Releases Latest](https://github.com/NanmiCoder/cc-haha/releases/latest)，并重试一次能稳定复现问题的最短步骤。

如果 Desktop 仍能打开：

1. 进入 **设置 → 诊断**。
2. 点击 **复制 Issue 报告**。
3. 在 [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues) 搜索相同问题；没有重复 Issue 时再新建。
4. 粘贴报告，并补充复现步骤、预期结果和实际结果。

如果仅凭报告无法定位，可以再点击 **导出诊断包**。Issue 报告和诊断包会尽力省略聊天内容、文件内容、完整环境变量和 API Key，但仍可能含有路径、Provider 主机名等私密元数据；**分享前必须自行检查**。

建议同时提供：

- Claude Code Haha 版本
- 操作系统、CPU 架构和安装包类型
- 使用的 Provider 类型与 API 格式，不要提供 API Key
- 最短复现步骤和完整错误文字
- 问题发生在 Desktop、H5 还是 CLI

如果应用无法启动，提供安装包版本、系统错误截图和启动前最后一个可见操作即可。不要为了排错直接删除或覆盖 `~/.claude`。

## Provider 与 OAuth

### 我一定要安装 LiteLLM 才能用 OpenAI 兼容服务吗？

不需要。Desktop 的 Custom Provider 支持：

- Anthropic Messages（原生）
- OpenAI Chat Completions（本地代理转换）
- OpenAI Responses API（本地代理转换）

只有当上游服务使用了应用尚未支持的协议或特殊字段时，才需要考虑 LiteLLM 等外部网关。

### 自定义 Provider 返回 401 或 API Key invalid

在 **设置 → 服务商** 中编辑该 Provider，依次检查：

1. Base URL 是否是服务商要求的 API 根地址，没有多写或漏写路径。
2. API 格式是否与服务商真实接口一致。
3. 认证方式是否正确：部分 Anthropic 兼容服务使用 Bearer Token，官方 Anthropic API 使用 `x-api-key`。
4. 主模型 ID 是否真实存在，并且当前 Key 有权访问。
5. 点击 **测试连接**，先处理第一步连通失败；OpenAI 格式还会显示第二步代理转换结果。

不要同时在截图、Issue 或诊断附件中公开 Base URL 查询参数、Token 或 API Key。

### Claude、ChatGPT 或 Grok 官方登录没有完成

- 保持 Claude Code Haha 正在运行，不要提前关闭登录页面或应用。
- 允许系统浏览器打开授权页，并完成同一个账号的授权。
- 检查系统时间是否正确，并确认代理、防火墙或浏览器扩展没有阻止服务商页面和本机 OAuth 回调。
- 如果浏览器显示授权成功但应用没有更新，回到 **设置 → 服务商** 重新发起登录。

仍然失败时，复制 Issue 报告，并注明卡在“未打开浏览器”“授权页报错”还是“授权后未回到应用”。不要分享 OAuth code、access token 或浏览器 Cookie。

### 测试连接成功，聊天仍然失败

确认当前任务实际选择了刚配置的 Provider 和模型，而不只是把 Provider 保存到了列表中。再检查主模型和角色模型映射是否受该账号支持。

用新任务发送一条最短纯文本消息复测；如果仍失败，在诊断页复制 Issue 报告。连接测试证明接口、认证和基础转换可用，不等于所有模型能力、工具调用和长上下文组合都已验证。

## 安装与更新

### macOS 提示无法验证、已损坏或打不开

优先确认安装包来自 [官方 Latest Release](https://github.com/NanmiCoder/cc-haha/releases/latest)，并选择了正确的 Intel 或 Apple Silicon 架构。正式签名和公证的版本通常只显示标准的下载来源确认。

旧版、draft 或临时 unsigned 包可能需要额外放行，见 [Desktop 安装指南](/desktop/04-installation#macos)。不要从不明镜像下载后绕过系统安全提示。

### Windows 出现 SmartScreen

确认安装包来自官方 Release。未签名的 Windows 安装包可能显示 SmartScreen，可以展开“更多信息”核对发布者和文件名后再决定是否运行。

覆盖升级前先完全退出 Claude Code Haha。如果安装器提示进程仍在运行，关闭对应窗口和后台进程后重试，不要先删除用户配置目录。

### Linux AppImage 无法启动

先赋予执行权限：

```bash
chmod +x Claude-Code-Haha-<版本>-linux-<架构>.AppImage
```

部分发行版还需要 FUSE。不同发行版的安装方式见 [Desktop 安装指南](/desktop/04-installation#linux)。

## H5 访问

### 手机或另一台电脑无法连接 H5

依次确认：

1. Desktop 的 **H5 访问**已经开启。
2. 使用设置页当前显示或二维码生成的 Server URL，不要复用旧局域网 IP。
3. 客户端填写了当前 H5 Token。
4. 两台设备位于可互通的网络，系统防火墙允许当前端口。
5. 经过反向代理时，已正确转发 HTTP 和 WebSocket，并配置允许的来源。

H5 是当前 Desktop 服务的远程入口，不等同于完整 Desktop。终端、原生预览、宠物窗口和部分系统能力只能在桌面应用中使用。

详细部署与安全边界见 [H5 访问](/desktop/06-h5-access)。

## Git 分支与 Worktree

### 创建隔离 Worktree 失败

常见原因包括：

- 所选目录不是 Git 仓库
- 分支不存在，或已被另一个 Worktree 占用
- 当前工作树有未提交修改，无法安全执行预期操作
- 目标 Worktree 路径已存在或不可写

先阅读界面显示的具体错误。可以改用当前工作树、选择其他分支，或在 Git 中安全处理已有改动后重试。不要为了创建 Worktree 自动删除现有目录或丢弃未提交修改。

### 当前工作树和隔离 Worktree 应该选哪个？

- **当前工作树**：适合继续处理当前目录里已经存在的修改。
- **隔离 Worktree**：适合并行任务、独立分支，或希望与当前目录改动分开的工作。

如果不确定且当前目录已有重要的未提交修改，先查看 Git 状态并备份，再决定使用哪条路径。

## Computer Use

### Computer Use 不可用或无法控制应用

先打开 **设置 → Computer Use**，检查：

- 全局开关已经开启
- Python 环境和依赖检查通过
- macOS 或 Windows 所需的系统权限已经授予
- 目标应用已在允许控制的应用列表中
- 当前会话的权限请求已经明确批准

授予系统权限后，通常需要重新打开 Claude Code Haha 或目标应用。Linux 当前不支持 Computer Use；请不要把 Desktop 安装成功当成 Computer Use 已配置完成。

如果设置页仍显示错误，复制 Issue 报告，并附上设置页状态；不要上传包含其他应用内容的完整屏幕截图。

## CLI

### `bun install` 或 CLI 启动失败

确认已经进入仓库根目录，并使用项目支持的 Bun 版本：

```bash
bun --version
bun install
./bin/claude-haha --help
```

如果提示缺少 `bun:bundle` 等 Bun 内置模块，先升级 Bun。完整安装路径见 [3 分钟上手](./quick-start.md#路径二从源码运行-cli)，参数说明见 [CLI 参考](./cli-reference.md)。
