# 3 分钟上手

Claude Code Haha 有两种使用方式。日常开发推荐安装 **Desktop**；只有在需要终端交互、脚本调用或参与源码开发时，才需要从源码运行 **CLI**。

| 方式 | 适合谁 | 需要准备 |
|------|--------|----------|
| **Desktop（推荐）** | 想直接管理项目、会话、Worktree、代码 Diff 和权限审批 | 下载对应系统的安装包；**不需要安装 Bun** |
| **CLI** | 偏好终端、需要 `--print` 自动化或准备参与开发 | Git、Bun 和一个模型服务 |

## 路径一：安装 Desktop

### 1. 下载当前稳定版

打开 [GitHub Releases Latest](https://github.com/NanmiCoder/cc-haha/releases/latest)，按系统和 CPU 架构选择安装包：

- macOS Apple Silicon（M 系列）：`mac-arm64.dmg`
- macOS Intel：`mac-x64.dmg`
- Windows：`win-x64.exe` 或 `win-arm64.exe`
- Linux：对应架构的 `.AppImage` 或 `.deb`

安装细节和系统提示处理见 [Desktop 安装指南](/desktop/04-installation)。

### 2. 首次配置模型服务

启动应用，打开 **设置 → 服务商**。

最快的方式是选择一个官方入口，并按界面提示完成连接或登录：

- **Claude 官方**
- **ChatGPT 官方**：使用 ChatGPT 账号完成 OAuth
- **Grok 官方**：使用 xAI 账号完成 OAuth

这些官方入口不要求手工填写 API Key。也可以点击 **添加服务商**，选择内置预设或 Custom，填写 API Key、接口地址、API 格式和模型映射。

自定义服务商保存前先点击 **测试连接**；测试通过后，将它 **设为默认**。OpenAI Chat Completions 和 OpenAI Responses API 可以由应用内置的本地代理转换，不必默认再安装 LiteLLM。

更多配置解释见 [第三方模型与自定义服务商](./third-party-models.md)。

### 3. 新建第一个任务

点击侧边栏的 `+`：

1. 选择本地项目目录。
2. 如果目录是 Git 仓库，选择要使用的分支。
3. 决定在当前工作树中运行，还是创建隔离 Worktree。

当前工作树会直接看到目录里已有的未提交修改；隔离 Worktree 更适合并行任务或不希望影响当前工作目录的改动。

### 4. 确认模型和权限

发送第一条消息前，确认当前 Provider、模型和 effort。第一次使用建议保留默认的 **询问权限（Default）**：应用会在执行敏感工具或命令前请求确认。

只有明确理解影响时再使用自动接受或绕过权限模式。权限模式的区别见 [Desktop 快速上手](/desktop/01-quick-start#三选择正确的权限模式)。

### 5. 发送第一条消息

可以从一个可验证的小任务开始，例如：

```text
先只读分析这个项目，告诉我它如何启动、主要目录分别负责什么，不要修改文件。
```

看到流式回复、工具调用和权限请求后，说明 Desktop、模型服务和项目目录已经连通。

## 路径二：从源码运行 CLI

### 1. 获取源码并安装 Bun

先安装 [Git](https://git-scm.com/downloads) 和 [Bun](https://bun.sh)，然后执行：

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
```

### 2. 配置模型服务

```bash
cp .env.example .env
```

编辑 `.env`，至少配置一种可用的认证方式、接口地址和模型。变量含义与认证头区别见 [环境变量](./env-vars.md)。

不要把真实 API Key 提交到 Git，也不要在 Issue、截图或诊断附件中公开它。

### 3. 启动并验证

macOS、Linux 或 Git Bash：

```bash
./bin/claude-haha
./bin/claude-haha -p "概括当前项目的目录结构"
```

Windows PowerShell 或 cmd：

```powershell
bun --env-file=.env ./src/entrypoints/cli.tsx
```

命令参数、无头模式、恢复模式和全局调用方式见 [CLI 参考](./cli-reference.md)。

## 下一步

- [Desktop 快速上手](/desktop/01-quick-start)：会话、权限、附件和工作区操作
- [第三方模型与自定义服务商](./third-party-models.md)：Provider、API 格式与模型映射
- [常见问题](./faq.md)：安装、OAuth、H5、Worktree 和 Computer Use 排查
- [全局使用](./global-usage.md)：在任意目录启动 CLI
