# 全局使用（任意目录启动）


如果你希望在任意项目目录直接运行 `claude-haha`，可以通过以下方式配置。配置完成后，`claude-haha` 会自动识别你当前所在的工作目录。

## macOS / Linux

在 `~/.bashrc` 或 `~/.zshrc` 中添加：

```bash
# 方式一：添加 PATH（推荐）
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"

# 方式二：alias
alias claude-haha="$HOME/path/to/claude-code-haha/bin/claude-haha"
```

然后重新加载配置：

```bash
source ~/.bashrc  # 或 source ~/.zshrc
```

## Windows (Git Bash)

在 `~/.bashrc` 中添加：

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```

### Windows + WSL 工具链

如果 `claude-haha` 运行在 Windows / Git Bash，但 Node、Python、uv、bun 等工具主要安装在 WSL 里，可以显式通过 WSL 调用：

```bash
wsl -e bash -lc 'node --version && python3 --version'
```

cc-haha 会在检测到 `wsl` / `wsl.exe` 调用时自动设置 `MSYS2_ARG_CONV_EXCL=*`，避免 Git Bash 把 `/home/...` 这类 WSL 路径错误转换成 `C:/Program Files/Git/home/...`。

如果你想让 Bash 工具默认进入 WSL，可以在启动前设置：

```bash
export CLAUDE_CODE_SHELL_PREFIX='wsl -e bash -lc'
```

Computer Use 仍然控制 Windows 桌面应用，WSL 内的 CLI 工具不需要写入 `computer-use-config.json`。如果只使用 WSL 工具链、不需要桌面控制，建议使用 `--no-computer-use` 或在 Settings > Computer Use 中关闭它。

## 验证

配置完成后，进入任意项目目录测试：

```bash
cd ~/your-other-project
claude-haha
# 启动后询问「当前目录是什么？」，应显示 ~/your-other-project
```
