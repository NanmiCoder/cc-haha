# Global Usage (Run from Any Directory)


If you want to run `claude-haha` directly from any project directory, set up one of the following. Once configured, `claude-haha` will automatically recognize your current working directory.

## macOS / Linux

Add to `~/.bashrc` or `~/.zshrc`:

```bash
# Option 1: Add to PATH (recommended)
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"

# Option 2: Alias
alias claude-haha="$HOME/path/to/claude-code-haha/bin/claude-haha"
```

Then reload the config:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

## Windows (Git Bash)

Add to `~/.bashrc`:

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```

## Verify

After setup, navigate to any project directory and test:

```bash
cd ~/your-other-project
claude-haha
# Ask "What is the current directory?" — it should show ~/your-other-project
```
