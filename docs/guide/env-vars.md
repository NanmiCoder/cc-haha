# 环境变量

Claude Code Haha 有两条配置路径：

- 桌面端用户优先在 **设置 → Providers** 中选择、测试并激活提供商。应用会管理对应的认证、模型映射和协议代理。
- 从源码运行 CLI 时，可以使用 `.env`、Shell 环境变量或 Claude Code 的 `settings.json`。

不要在多个位置重复保存同一把 API Key。排查问题时，先确认当前是否激活了桌面端 Provider。

## 常用变量

### Anthropic 兼容接口

| 变量 | 必填 | 说明 |
|------|------|------|
| `ANTHROPIC_API_KEY` | 与 Auth Token 二选一 | 通过 `x-api-key` 请求头发送 |
| `ANTHROPIC_AUTH_TOKEN` | 与 API Key 二选一 | 通过 `Authorization: Bearer` 请求头发送 |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic Messages 兼容端点的基础地址 |
| `ANTHROPIC_MODEL` | 否 | 当前会话的默认模型 |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | 否 | Fable 模型槽位；仅在提供商支持时配置 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 否 | Haiku 模型槽位 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 否 | Sonnet 模型槽位 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 否 | Opus 模型槽位 |
| `API_TIMEOUT_MS` | 否 | API 请求超时，单位为毫秒；默认 `600000` |

认证变量取决于服务端要求的请求头，不能仅凭提供商名称判断。如果返回 `401`，先核对服务商文档和桌面端 Provider 的认证策略。

### Azure OpenAI

Azure OpenAI 使用独立的 Responses API 路径：

| 变量 | 必填 | 说明 |
|------|------|------|
| `CLAUDE_CODE_USE_AZURE_OPENAI` | 是 | 设为 `1` 启用 Azure OpenAI |
| `AZURE_OPENAI_BASE_URL` | 是 | Azure 资源基础地址；也接受 `AZURE_OPENAI_ENDPOINT` |
| `AZURE_OPENAI_API_VERSION` | 否 | API 版本；默认 `2025-04-01-preview` |
| `AZURE_OPENAI_API_KEY` | 是 | Azure OpenAI API Key |
| `AZURE_OPENAI_CODEX_DEPLOYMENT` | 视模型而定 | Codex 模型对应的 Azure deployment 名称 |

示例：

```bash
CLAUDE_CODE_USE_AZURE_OPENAI=1
AZURE_OPENAI_BASE_URL=https://your-resource.cognitiveservices.azure.com
AZURE_OPENAI_API_VERSION=2025-04-01-preview
AZURE_OPENAI_API_KEY=your_azure_openai_key
AZURE_OPENAI_CODEX_DEPLOYMENT=your_codex_deployment
```

### 本地运行与隐私

| 变量 | 说明 |
|------|------|
| `CLAUDE_CONFIG_DIR` | 改用指定配置目录，而不是默认的 `~/.claude`；适合便携模式和隔离测试 |
| `CLAUDE_CODE_FORCE_RECOVERY_CLI` | 设为 `1` 使用简化的 Recovery CLI |
| `CLAUDE_CODE_SHELL_PREFIX` | 为 Bash 工具增加 Shell 前缀，例如 Windows 下的 `wsl -e bash -lc` |
| `DISABLE_TELEMETRY` | 设为 `1` 禁用遥测 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 设为 `1` 禁用非必要网络请求 |

本地 Server 的 `SERVER_HOST`、`SERVER_PORT`、`SERVER_AUTH_REQUIRED` 等变量见 [本地 Server](../reference/local-server.md)。

## 配置方式

### 桌面端 Provider

桌面端把 Provider 索引保存到：

```text
~/.claude/cc-haha/providers.json
```

应用管理的 Provider 环境写入隔离的 Haha 配置，不需要手工复制到 `~/.claude/settings.json`。当 CLI 读取到已激活的 Provider 时，会复用其认证、模型和协议设置；`openai_chat` 与 `openai_responses` Provider 会自动使用本机回环代理。

详细流程见 [第三方模型](./third-party-models.md)。

### `.env` 文件

源码仓库中的 `bin/claude-haha` 会在项目根目录存在 `.env` 时加载它：

```bash
cp .env.example .env
```

一个 Anthropic 兼容接口的最小示例：

```bash
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
ANTHROPIC_DEFAULT_HAIKU_MODEL=provider-model
ANTHROPIC_DEFAULT_SONNET_MODEL=provider-model
ANTHROPIC_DEFAULT_OPUS_MODEL=provider-model
```

`.env` 只用于源码启动脚本。桌面端创建的 CLI 子进程会跳过仓库 `.env`，避免旧密钥覆盖当前激活的 Provider。

### `settings.json`

用户级设置位于 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-example",
    "ANTHROPIC_BASE_URL": "https://provider.example.com/anthropic",
    "ANTHROPIC_MODEL": "provider-model"
  }
}
```

项目还可能包含 `.claude/settings.json` 或 `.claude/settings.local.json`。这些文件属于工作区输入；只在可信项目中使用，尤其不要从不可信仓库接受 `PATH`、`LD_PRELOAD`、代理地址或认证相关环境变量。

## 实际生效顺序

这里不存在可靠的“Shell > `.env` > settings”三段式规则：

1. `bin/claude-haha` 先让 Bun 加载仓库 `.env`。
2. CLI 初始化时合并已启用的用户、项目、本地、命令行和受管设置来源。
3. 已激活的 Haha Provider 会覆盖普通 Claude 设置中的 Provider 路由变量，防止两个客户端互相污染。
4. 桌面端 host 注入的运行时变量受到保护，不能被 `settings.json` 中的同名字段替换。
5. 企业受管策略和 `--setting-sources` 也会影响最终结果。

因此，切换模型提供商时应只保留一个主要配置入口。桌面端用户使用 Providers 设置页；纯 CLI 用户使用 `.env` 或用户级 `settings.json` 之一。

## 安全建议

- 不要提交 `.env`、Provider 配置或包含密钥的 `settings.json`。
- 不要在截图、Issue、日志或诊断包中暴露完整 Token。
- 使用 `CLAUDE_CONFIG_DIR` 做测试隔离，避免读写真实用户配置。
- `--print` 会跳过工作区信任对话框，只能在可信目录运行。更多限制见 [CLI 参考](./cli-reference.md)。
- 远程访问本地 Server 时，不要把 CORS 当成身份认证；请启用 H5 Token 或显式鉴权。
