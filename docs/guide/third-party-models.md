# 第三方模型

Claude Code Haha 可以连接 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 三类接口。对桌面端用户来说，最可靠的入口不是手写环境变量，而是 **设置 → Providers**：应用会保存认证方式、模型映射，并在需要时启动本机协议代理。

## 推荐配置流程

1. 打开桌面端的 **设置 → Providers**。
2. 选择内置预设，或新建自定义 Provider。
3. 填写 Base URL、认证信息和协议格式。
4. 至少配置主模型；服务商使用不同模型名时，再配置 Haiku、Sonnet 和 Opus 槽位。
5. 先点击测试，确认认证和模型可用，再激活 Provider。
6. 新建会话验证工具调用；只返回文本并不代表 Agent 工作流完整可用。

激活后，桌面端和由它启动的 CLI 会复用同一份 Provider 配置。不要再把另一套旧密钥写进 `.env` 或 `~/.claude/settings.json`。

## 选择正确的协议

| Provider 格式 | 上游接口 | 适用场景 |
|----------------|----------|----------|
| `anthropic` | Anthropic Messages | 服务商原生兼容 Anthropic 请求与响应 |
| `openai_chat` | `/v1/chat/completions` | 服务商提供 OpenAI Chat Completions |
| `openai_responses` | `/v1/responses` | 服务商提供 OpenAI Responses |

`anthropic` 会直接请求服务商，不替换协议。`openai_chat` 和 `openai_responses` 会由 Claude Code Haha 在本机启动回环代理，把 Claude Agent 流量转换成所选协议。这个代理只用于当前运行时，不需要把端口手工暴露到局域网。

如果提供商同时宣传“OpenAI 兼容”和“Anthropic 兼容”，以它实际实现完整、工具调用稳定的接口为准。不要仅根据 URL 中是否含有 `/v1` 推断协议。

## 认证与模型映射

认证头由服务商决定：

- Anthropic API Key 通常使用 `x-api-key`。
- Bearer Token 通常使用 `Authorization: Bearer`。
- OpenAI 兼容服务通常使用 Bearer Token，但私有网关可能不同。

模型槽位不是额外下载的模型，而是 Claude Agent 在不同任务中请求的逻辑档位。主模型必须能处理工具调用；其他槽位可以映射到同一个模型，也可以按成本和能力分别配置。某个服务商不支持的槽位可以留空。

模型名和服务商能力会持续变化，所以本文不维护一份容易过期的型号清单。请在 Provider 设置页使用服务商当前返回的模型 ID，并通过测试按钮确认。

## 内置运行时

Claude Code Haha 还提供 Claude、OpenAI 和 Grok 的内置运行时。可用的登录方式取决于当前版本和本机账号状态；按照 Provider 页面显示的授权流程完成登录即可。

内置运行时与“自定义兼容接口”是两条路径。已有官方账号时优先使用内置运行时；连接中转服务、自建网关或本地模型时再创建自定义 Provider。

## 仅使用 CLI

纯 CLI 用户可以直接配置 Anthropic Messages 兼容端点：

```bash
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
./bin/claude-haha
```

这个方式不会自动把 Anthropic 请求转换成 OpenAI 协议。OpenAI Chat Completions 或 Responses 服务应先在桌面端创建 Provider，让应用管理协议代理。完整变量和生效顺序见 [环境变量](./env-vars.md)。

Azure OpenAI 使用项目内置的专用 Responses 路径，配置项见 [Azure OpenAI 环境变量](./env-vars.md#azure-openai)。

## LiteLLM：进阶兼容层

只有在服务商没有可靠的 Anthropic 接口、又无法直接使用 Provider 协议转换时，才需要额外部署 LiteLLM。它会增加一个服务、一次协议转换和一层排查成本。

最小示例：

```yaml
model_list:
  - model_name: provider-model
    litellm_params:
      model: openai/provider-model
      api_base: https://provider.example.com/v1
      api_key: os.environ/PROVIDER_API_KEY
```

启动 LiteLLM 后，把它的 Anthropic 兼容地址作为 `anthropic` Provider 接入。部署、鉴权和模型前缀以 [LiteLLM 官方文档](https://docs.litellm.ai/) 为准。

## 能力边界

第三方模型要稳定运行 Agent 工作流，至少需要：

- 正确处理多轮消息、system 内容和工具调用；
- 保留 tool call ID，并能接收对应的 tool result；
- 支持足够长的上下文和输出；
- 在流式模式下发送结构完整、顺序正确的事件。

思考模式、effort、Prompt Cache、图像输入和结构化输出是否可用，取决于所选协议、服务商和具体模型，不能统一认定为“支持”或“不支持”。遇到问题时先关闭可选能力，验证最小文本与工具调用，再逐项恢复。

## 常见问题

| 现象 | 优先检查 |
|------|----------|
| `401` / `403` | 认证头类型、Token 权限、Base URL 是否属于同一服务 |
| `404` | Provider 格式是否选错、Base URL 是否重复包含接口路径 |
| 模型不存在 | 使用服务商真实模型 ID，不要沿用其他平台的别名 |
| 一直输出文本但不执行工具 | 模型或网关是否完整支持工具调用 |
| 切换 Provider 后仍请求旧地址 | 是否同时在 `.env`、`settings.json` 和桌面端保存了配置 |
| 流式响应中断 | 先关闭可选能力，并检查网关是否改写或缓冲事件流 |
