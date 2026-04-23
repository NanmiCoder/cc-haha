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

## 验证

配置完成后，进入任意项目目录测试：

```bash
cd ~/your-other-project
claude-haha
# 启动后询问「当前目录是什么？」，应显示 ~/your-other-project
```
