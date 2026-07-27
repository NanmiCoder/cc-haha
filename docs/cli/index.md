---
title: 安装与启动
nav_title: 安装与启动
description: 从源码运行 CLI：安装依赖、配置模型服务、在任意目录启动。
order: 0
---

# 安装与启动

CLI 是 Claude Code Haha 的内核，桌面端每个会话背后跑的都是它。如果你只想用图形界面，装桌面端就够了，见 [下载与安装](../start/install.md)；下面这些步骤是给需要终端交互、`--print` 脚本自动化，或者准备读源码、提 PR 的人看的。

CLI 目前只从源码运行，没有单独的安装包。

## 获取源码

先装好 [Git](https://git-scm.com/downloads) 和 [Bun](https://bun.sh)，然后：

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
```

## 配置模型服务

```bash
cp .env.example .env
```

编辑 `.env`，至少给出一种可用的认证方式、接口地址和模型。一个 Anthropic 兼容接口的最小配置是这样：

```ini
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
```

变量含义、认证头的区别、Azure 与其他协议的写法见 [环境变量](./env.md)。如果你已经在桌面端配好了服务商，CLI 会直接复用那份配置，不需要再写 `.env`。

不要把真实 API Key 提交到 Git，也不要在 Issue、截图或诊断附件里公开它。

## 启动并验证

macOS、Linux 或 Git Bash：

```bash
./bin/claude-haha
./bin/claude-haha -p "概括当前项目的目录结构"
```

Windows PowerShell 或 cmd：

```powershell
bun --env-file=.env ./src/entrypoints/cli.tsx
```

看到流式回复和工具调用，说明模型服务、项目目录和 CLI 已经连通。

## 在任意目录启动

`./bin/claude-haha` 只在仓库里能用。把它加进 `PATH`，就能在任何项目目录直接敲 `claude-haha`，CLI 会自动把当前工作目录当成项目根。

macOS 和 Linux 在 `~/.bashrc` 或 `~/.zshrc` 中添加：

```bash
# 方式一：加入 PATH（推荐）
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"

# 方式二：alias
alias claude-haha="$HOME/path/to/claude-code-haha/bin/claude-haha"
```

改完重新加载：

```bash
source ~/.zshrc  # 或 source ~/.bashrc
```

Windows 的 Git Bash 同样在 `~/.bashrc` 中加 `PATH`：

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```

验证方式是换个目录再启动，然后问它「当前目录是什么」：

```bash
cd ~/your-other-project
claude-haha
```

### Windows 配 WSL 工具链

如果 `claude-haha` 跑在 Windows 或 Git Bash 里，而 Node、Python、uv、bun 这些工具装在 WSL 中，可以显式经 WSL 调用：

```bash
wsl -e bash -lc 'node --version && python3 --version'
```

检测到 `wsl` / `wsl.exe` 调用时，CLI 会自动设置 `MSYS2_ARG_CONV_EXCL=*`，避免 Git Bash 把 `/home/...` 这类 WSL 路径错误转换成 `C:/Program Files/Git/home/...`。

想让 Bash 工具默认进 WSL，启动前设置：

```bash
export CLAUDE_CODE_SHELL_PREFIX='wsl -e bash -lc'
```

Computer Use 控制的仍然是 Windows 桌面应用，WSL 内的命令行工具不需要写进 `computer-use-config.json`。只用 WSL 工具链、不需要桌面控制时，加 `--no-computer-use`，或在 设置 → Computer Use 里关掉它。

## 下一步

- [命令参考](./reference.md)：命令行参数、无头模式与恢复模式
- [环境变量](./env.md)：认证、模型与本地运行变量的完整清单
- [架构总览](../internals/index.md)：CLI、Server、桌面壳与 Adapter 的分工
- [参与贡献与质量门禁](../internals/contributing.md)：提 PR 之前要跑哪些检查
