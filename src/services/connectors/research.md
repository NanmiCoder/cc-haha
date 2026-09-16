# 远程连接器接入证据（2026-09-13）

本报告只做官方文档与源码核验，未登录第三方、未调用业务工具、未消耗供应商配额。下列为可由现有 HTTP/SSE MCP 客户端接入的官方服务，不代表已完成本产品与每个供应商账号的真实联调。首批建议包含 15 个远程服务；后续核验又补充 5 个国内服务，详见下文。加现有飞书、钉钉、企业微信，可形成 23 项候选，覆盖办公、地图、搜索、开发、设计、数据科研、财务、表单、法律。最终上架范围以 catalog 实现为准。

## 可实施 recipe 建议

以下 JSON 为目录设计建议，不是可直接运行的现有类型。`key-query` 必须在运行时用 URLSearchParams 编码写入，秘密存入敏感 userConfig/keychain，不写进目录或公开 DTO。`optional-key-header` 允许匿名，填写密钥后才加 header。OAuth 与 key 为备选认证方式，不同时强制执行。当前 v1 若仅支持一种认证方式，可选择数组中的第一个。

```json
[
  {"id":"amap","category":"maps","transport":"http","endpoint":"https://mcp.amap.com/mcp","auth":[{"kind":"key-query","name":"key"}],"requires":"高德开放平台 Web 服务 API Key","source":"https://developer.amap.com/api/mcp-server/gettingstarted"},
  {"id":"baidu-maps","category":"maps","transport":"http","endpoint":"https://mcp.map.baidu.com/mcp","auth":[{"kind":"key-query","name":"ak"}],"requires":"百度地图服务器端 AK","source":"https://lbs.baidu.com/docs/ai?title=mcpserver%2Fquickstart"},
  {"id":"tencent-maps","category":"maps","transport":"http","endpoint":"https://mcp.map.qq.com/mcp?format=0","auth":[{"kind":"key-query","name":"key"}],"requires":"腾讯位置服务 Key，开通 WebServiceAPI 权限及相应配额","source":"https://lbs.qq.com/service/MCPServer/MCPServerGuide/userGuide"},
  {"id":"tavily","category":"search","transport":"http","endpoint":"https://mcp.tavily.com/mcp/","auth":[{"kind":"oauth"},{"kind":"key-query","name":"tavilyApiKey"}],"requires":"Tavily 账号；API Key 方案从控制台获取","source":"https://docs.tavily.com/documentation/mcp"},
  {"id":"exa","category":"search","transport":"http","endpoint":"https://mcp.exa.ai/mcp","auth":[{"kind":"optional-key-header","name":"x-api-key","prefix":""}],"requires":"基础匿名访问可用；生产或更高额度使用用户自己的 API Key","source":"https://exa.ai/docs/reference/exa-mcp"},
  {"id":"context7","category":"development","transport":"http","endpoint":"https://mcp.context7.com/mcp","auth":[{"kind":"optional-key-header","name":"Authorization","prefix":"Bearer "}],"requires":"可选 Context7 API Key；不是 MCP OAuth 地址","source":"https://github.com/upstash/context7/blob/master/server.json"},
  {"id":"github","category":"development","transport":"http","endpoint":"https://api.githubcopilot.com/mcp/","auth":[{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"用户 GitHub PAT，按所需仓库与操作授权；组织策略可能限制","source":"https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md"},
  {"id":"notion","category":"office","transport":"http","endpoint":"https://mcp.notion.com/mcp","auth":[{"kind":"oauth"}],"requires":"Notion 用户账号并授权可访问工作区内容","source":"https://developers.notion.com/guides/mcp/get-started-with-mcp"},
  {"id":"linear","category":"office","transport":"http","endpoint":"https://mcp.linear.app/mcp","auth":[{"kind":"oauth"},{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"Linear 用户账号；API key 或 OAuth token 可作为 Bearer","source":"https://linear.app/docs/mcp"},
  {"id":"supabase","category":"data","transport":"http","endpoint":"https://mcp.supabase.com/mcp","auth":[{"kind":"oauth"},{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"Supabase 账号及目标组织/项目权限；可用 PAT","source":"https://supabase.com/docs/guides/ai-tools/mcp"},
  {"id":"sentry","category":"development","transport":"http","endpoint":"https://mcp.sentry.dev/mcp","auth":[{"kind":"oauth"}],"requires":"Sentry 账号；可在路径限定 organization/project","source":"https://mcp.sentry.dev/"},
  {"id":"stripe","category":"finance","transport":"http","endpoint":"https://mcp.stripe.com","auth":[{"kind":"oauth"},{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"Stripe 账号；key 方案优先使用 restricted key，区分测试和真实业务","source":"https://docs.stripe.com/mcp"},
  {"id":"canva","category":"design","transport":"http","endpoint":"https://mcp.canva.com/mcp","auth":[{"kind":"oauth"}],"requires":"每位用户单独 Canva OAuth 授权；DCR 仍可用","source":"https://www.canva.dev/docs/mcp/"},
  {"id":"figma","category":"design","transport":"http","endpoint":"https://mcp.figma.com/mcp","auth":[{"kind":"oauth"}],"requires":"Figma 账号 OAuth 授权；可用功能/次数受账号席位和计划影响","source":"https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/"},
  {"id":"huggingface","category":"research","transport":"http","endpoint":"https://huggingface.co/mcp","auth":[{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"Hugging Face token；检索优先 read 权限，Jobs 等能力另有权限/费用","source":"https://github.com/huggingface/hf-mcp-server"}
]
```

## 认证和供应商差异

- **地图三个产品**是开发者 Key 接入，不是登录个人地图 App 后自动授权。高德、百度文档明确提供 HTTP endpoint；腾讯 `userGuide` 原始 HTML 同时提供 `/mcp?key=<YourKey>&format=0` 与 `/sse?key=<YourKey>&format=0`。腾讯文档有浏览器抓取工具解析失败，已通过只读 HTTPS 获取原始官方 HTML 核对。不能因为采用 MCP 就绕过上游 WebServiceAPI 配额。
- **GitHub** 官方明确远程 MCP 不支持 Dynamic Client Registration。通用 OAuth 按钮不能直接复用 VS Code 的客户端身份；要做 OAuth，需要我们注册并管理 GitHub App/OAuth App。因此本轮选 PAT。支持服务器端只读 header `X-MCP-Readonly: true`，或指定 toolsets。来源：[host integration](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)、[configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)。
- **Notion** 官方明确给出 Claude Code HTTP + `/mcp` OAuth 操作。不要把 Notion integration secret 当作 hosted MCP 支持的静态 header 方案。用户仍只能访问自身权限允许的内容。
- **Linear** 官方支持 OAuth 2.1 DCR、Bearer OAuth token 和 API key。新接入用 `/mcp`，`/sse` 已是废弃兼容路径。可选 `/mcp/readonly`。多工作区需要独立认证上下文。
- **Supabase** hosted MCP 默认 DCR，无须用户自建 OAuth App；不支持 DCR 的特定客户端才需要手工 App。PAT 是可行备选。可通过 `project_ref` 限定项目。不要混淆自托管 Supabase 内部 MCP，它不应被直接暴露到公网，且授权机制不同。
- **Canva** 现在推荐 CIMD，但 DCR 仍保留兼容。当前客户端能走 DCR，可列入；不能把“CIMD 推荐”误读成必须预注册 App。每个用户必须独立授权，不支持组织级共用服务账号。来源：[认证与设置](https://www.canva.dev/docs/mcp/)、[手工注册与限制](https://www.canva.dev/docs/mcp/troubleshooting/)。
- **Figma** 官方明确给出 Claude Code `--transport http` + Authenticate 流程，故无需为本轮虚构 PAT 接入。它并不保证所有账号拥有全部设计写入工具；应从 tools/list 获取真实能力。
- **Hugging Face** canonical endpoint 是 `/mcp`，token 用 Bearer。若改用 OAuth，官方示例使用 `https://huggingface.co/mcp?login`，不能强制 bare `/mcp` 走 OAuth。为减少客户端注册差异，本轮选用户 token。[官方安装示例](https://github.com/huggingface/hf-mcp-server?ref=explainx)、[Hub 使用说明](https://huggingface.co/docs/hub/agents-mcp)、[OAuth/CIMD](https://huggingface.co/docs/hub/oauth)。
- **Context7** 当前官方 registry `server.json` 声明 Authorization header 非必需、支持 Bearer 或 raw key。旧资料常写 `CONTEXT7_API_KEY` header，目录采用当前官方配置。其专门 OAuth endpoint 为 `/mcp/oauth`；当前建议不混合。
- **Exa** 官方明确匿名免费方案以及 `x-api-key` 升级方式。不要以基础连接成功推断无限额度；失败不应自动去申请 Key 或付费。
- **Stripe** 官方 MCP 为 public preview，支持 OAuth 与 Bearer API key。能对接财务数据不代表“用户登录即授权所有付款/退款”；业务写操作仍遵循当前工具执行授权边界。

## 调研后未纳入这批远程目录的候选

| 服务 | 官方事实 | 本轮决定 |
| --- | --- | --- |
| 博查 | [官方仓库](https://github.com/Bocha-Labs/bocha-search-mcp) 提供 uvx 从 Git 仓库启动 stdio，`BOCHA_API_KEY`；AI Search 可能需单独开通权限。没有在所查官方资料中证明公共 hosted MCP endpoint。 | 可做未来本地 stdio recipe；不虚构 `mcp.bocha...`。 |
| 支付宝 | [官方 npm @alipay/open-mcp-server](https://www.npmjs.com/package/%40alipay/open-mcp-server?activeTab=readme) 说明代理官方 SSE并做身份认证，必需 AppID 和 PKCS8 应用受限私钥；[@alipay/mcp-server-alipay](https://www.npmjs.com/package/%40alipay/mcp-server-alipay?activeTab=readme) 提供本地 stdio 支付工具。 | 需要专用签名/代理/商户接入流程，不假装静态 Key 或普通 OAuth 托管连接器。本轮不提供未证实 endpoint。 |
| PayPal | [官方文档](https://developer.paypal.com/ai-tools/mcp-server) 确认 production `https://mcp.paypal.com/http`，sandbox `https://mcp.sandbox.paypal.com/http`；支持 OAuth 浏览器授权与 token 方式；SSE 对应 `/sse`。 | 是真实可行备选，鉴于已有 Stripe 覆盖财务，本轮不为数量加入第二支付提供商；未来必须明确选择 sandbox/production。 |

## 本仓库现有 MCP 边界

- `src/server/api/mcp.ts:37` 的 DTO 支持 stdio/http/sse；`:470` 起解析远程 URL/headers/oauth clientId/callbackPort；`:570` 的 createServer 保存配置，但仅返回 snapshot，不代表已授权或可用。
- `src/server/api/mcp.ts:750` 路由有 GET 列表、GET `/:name/status`、POST 创建、PUT 修改、DELETE、POST toggle/reconnect。**没有通用 HTTP `/authorize` API**，不能在新连接器里假定现有 API 已提供 OAuth 闭环。
- `src/services/mcp/auth.ts:847` 的 `performMCPOAuthFlow` 是可复用的底层 OAuth 流程；remote bridge 应明确调用并呈现 authUrl/取消，再 reconnect/tools/list 检查。
- `src/services/mcp/config.ts:639` 的 `addMcpConfig` 可保存用户级连接；但新目录若通过敏感 plugin userConfig 储存凭据，应沿用插件归属，不另写第二份明文 Key。
- `src/server/api/mcp.ts:184` 的 `serializeEditableConfig` 会返回 URL 与 headers。**不要把展开后的秘密 query/header 原样通过这一 DTO 返回**。新连接器公开状态只应返回无秘密 endpoint、configured 标记与状态；运行时按需展开敏感配置。
- 目录中的 `type: http` 对应 Streamable HTTP，不是旧 SSE。无需额外 npx/mcp-remote。本产品原生客户端支持两种传输，只有确实官方 SSE-only 才采用 sse。

## 验收含义

目录存在 ≠ 已配置 ≠ OAuth 完成 ≠ tools/list 成功 ≠ 业务调用成功。协议 mock 可以验证本应用安装/鉴权状态和调用连接关系，但不能替代供应商真实账号联调。用户点击配置并提供账号/Key 后再测协议连接；不要在启动时自动尝试登录，也不要自动调用搜索、图像、付款或计算任务来“验活”。


## 补充：国内办公、表单、法律与金融

以下 5 项都找到供应商自己发布的配置。腾讯云 MCP 广场条目同时核验了发布者身份：腾讯文档团队、腾讯云 WSA 团队；没有把普通社区投稿当作供应商规范。

```json
[
  {"id":"jinshuju","category":"forms","transport":"http","endpoint":"https://jinshuju.net/mcp","auth":[{"kind":"oauth"}],"requires":"金数据用户授权，免费计划也支持 OAuth","source":"https://open.jinshuju.net/mcp/oauth/"},
  {"id":"tencent-docs","category":"office","transport":"http","endpoint":"https://docs.qq.com/openapi/mcp","auth":[{"kind":"key-header","name":"Authorization","prefix":""}],"requires":"从 https://docs.qq.com/open/auth/mcp.html 获取个人 Token；高级能力受会员权限限制","source":"https://developer.cloud.tencent.com.cn/mcp/server/11803"},
  {"id":"datayes","category":"finance","transport":"http","endpoint":"https://dataapi-mcp-server.datayes.com/stock-mkt/mcp","auth":[{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"通联数据个人 Token；企业 Token 需客户经理核验，数据范围受权限与配额限制","source":"https://mcp.datayes.com/#/manual"},
  {"id":"pkulaw","category":"legal","transport":"http","endpoint":"https://apim-gateway.pkulaw.com/mcp-law-search-service","auth":[{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"法宝 MCP 平台 ACCESS_TOKEN；此项限法律法规语义检索","source":"https://mcp.pkulaw.com/docs"},
  {"id":"tencent-websearch","category":"search","transport":"http","endpoint":"https://api.wsa.cloud.tencent.com/Mcp","auth":[{"kind":"key-header","name":"Authorization","prefix":"Bearer "}],"requires":"腾讯云开通联网搜索 API 服务并创建 WSA API Key","source":"https://developer.cloud.tencent.com/mcp/server/11764"}
]
```

- 金数据 [OAuth 协议](https://open.jinshuju.net/mcp/oauth/) 明确受保护资源元数据发现、授权服务器 `https://account.jinshuju.net`、DCR `/oauth/register`、PKCE S256、token endpoint auth method `none`。其 API Key + Secret 是 HTTP Basic 且要求企业版；不能误做 Bearer。本轮选兼容现有 MCP 客户端的 OAuth。
- 腾讯文档官方例子是原始个人 Token 放入 `Authorization`，**不要自行添加 Bearer**。原网页直接抓取超时，但搜索索引完整提供供应商发布的配置段；未登录账号。
- DataYes 官方站为 SPA。[手册](https://mcp.datayes.com/#/manual) 的公开资源 `https://mcp.datayes.com/assets/ManualView-CV9Gqry-.js` 明确给出 `stock-mkt/mcp` 的 Streamable HTTP + Bearer 配置；个人版注册后在个人中心获取 Token，企业版需核验。没有在该官方手册验证 WorkBuddy 目录中的 `datayes-data/mcp` 聚合地址，因此不使用它。
- 法宝 [官方文档](https://mcp.pkulaw.com/docs) 分别提供法律语义、法律关键词、案例检索、引文检查等 9 个服务。本轮单 server recipe 选法律法规语义检索；不能宣传这个 endpoint 含全部 9 项。官方明确不要追加 `/mcp` 后缀。WorkBuddy 聚合路径 `/mcp-law-agg/1.0.0/mcp` 没有作为通用官方地址获得验证。
- 腾讯云 [WSA 团队文档](https://developer.cloud.tencent.com/mcp/server/11764) 明确大小写路径 `/Mcp`、Streamable HTTP、Bearer WSA Key。不是登录元宝账号授权；需开通云服务，并受该服务额度约束。

### 暂缓固定 recipe：Tushare

[官方文档 463](https://tushare.pro/document/1?doc_id=463) 确认 Tushare 提供 MCP，用户在个人中心 MCP Server 复制配置。但其文本示例写的是 `https://api.tushare.pro/mcp/token=你的Tushare token`，而 WorkBuddy 公共目录写 `/mcp/?token=...`，二者在 URL 语义上不同。当前未拿用户 Token 做请求，不能以推断把路径改成 query 并声称验证。应等待官方明确配置规范，或先提供自定义 MCP 配置入口让用户粘贴供应商控制台实际生成的地址。避免为了数量上线不可靠固定 endpoint。


## 可安装的独立技能工具包（2026-09-14）

本批与远程服务分开为 `collection: tools`、`transport: skills`。安装只下载公开技能、辅助脚本、参考资料和许可证，经过固定 commit 与逐文件 SHA-256 验证后注册为本应用管理的 Claude 插件；不会执行 npm、Python、模型调用，也不宣称运行依赖已经安装。`skillBundles.lock.json` 记录 8 项、180 个文件，下载总量约 6.13 MB。所有原始文件另通过 GitHub tree 的 Git blob SHA-1 核对，研究缓存位于 `/tmp/connectors-skill-evidence`，不属于用户安装。

| 工具包 | 固定公开源与版本 | 内容和许可 | 实际运行条件 |
| --- | --- | --- | --- |
| HyperFrames | [heygen-com/hyperframes v0.4.0](https://github.com/heygen-com/hyperframes/tree/60780774bb1896373947fb3e3197117501f53a22) | 完整 `skills/` 共 5 项技能，加根 LICENSE，61 文件；Apache-2.0 | Node.js 22+、HyperFrames CLI、FFmpeg；Kokoro 语音需 Python 3.10+，可选在线语音/素材服务需另配账号。 |
| Obsidian | [kepano/obsidian-skills 1.0.1](https://github.com/kepano/obsidian-skills/tree/8ccef29ae8624eccc734e77ced4a6e54baf5d83a) | 完整 `skills/` 和 LICENSE，12 文件；MIT | 文件编辑可直接使用；CLI 需要正在运行的 Obsidian，Defuddle/Knap 是另需 Node.js 的可选 CLI。 |
| draw.io | [jgraph/drawio-mcp 1.1.0](https://github.com/jgraph/drawio-mcp/tree/14b318b19cc37b159f841227b9d11fbd18ce18ea) | `plugins/claude-code/skills/drawio/` 映射至 `skills/drawio/`，加 LICENSE，2 文件；Apache-2.0 | XML 图表不需 CLI；Mermaid 转换、布局和导出需 draw.io 桌面 CLI。 |
| 前端界面设计 | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/frontend-design) | 完整 frontend-design 子树，2 文件；各自 LICENSE.txt 为 Apache-2.0；本应用包装版本 1.0.0 | 按目标项目准备前端依赖，不附带托管服务。 |
| 海报与视觉画布 | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/canvas-design) | 完整 canvas-design 子树，83 文件；技能 Apache-2.0；随附字体及所有 OFL 许可原样保留 | Python 与绘图/PDF 依赖。 |
| 生成式艺术 | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/algorithmic-art) | 完整 algorithmic-art 子树与模板，4 文件；Apache-2.0 | 浏览器及 p5.js 资源。 |
| 网页测试 | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/webapp-testing) | 完整 webapp-testing 子树、脚本及示例，6 文件；Apache-2.0 | Python、Playwright、浏览器和待测应用。 |
| MCP 开发 | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/mcp-builder) | 完整 mcp-builder 子树、参考资料与脚本，10 文件；Apache-2.0 | Node.js 或 Python、MCP SDK；可选评估脚本使用 Anthropic API，需用户明确配置并授权用量。 |

HyperFrames 选官方 v0.4.0 的完整历史包而非裁断最新 router：最新公开 commit 的 skills 有 915 文件、16.6 MB，并包含按需安装其他工作流的逻辑；所选历史包覆盖 HTML 视频、GSAP、CLI、registry、网站转视频，引用资料完整。它的可选语音参考里有 ElevenLabs/HeyGen MCP 名称，但同时提供本地 Kokoro 路径，不依赖 Codex 专属后端。完整小包不等于最新版 HyperFrames 全功能，也不固定用户未来执行的 CLI 版本。

### 本机 Codex 缓存核验与未直接搬运的插件

已只读检查 `/Users/nanmi/.codex/plugins/cache/openai-curated-remote/*/*/.codex-plugin/plugin.json`。本机 HyperFrames 0.1.2 manifest 指向 HeyGen 上游、Apache-2.0、skills 目录，证明其本身是技能包；本批以公开固定 commit 构建，不复制本机缓存。缓存中 Remotion 1.0.7 manifest 声明 MIT，但其公开 `remotion-dev/skills` 当前仓库未找到独立 LICENSE，且 runtime 另有许可条件，因此不据缓存声明直接分发公开仓库文件。

Vercel 公共插件 [固定 commit](https://github.com/vercel/vercel-plugin/tree/df0f55213f7b8db23a3ee7f27511ed344cdb2c74) 的 LICENSE 正文为 Apache-2.0，可作为后续候选；Codex 包附 `.app.json`，移植应使用上游 Claude 包并单独处理 Vercel 登录。Superpowers [6.3.0 固定 commit](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797) 为 MIT 且有 Claude plugin，但包含会改变全局工作方式的 hook 与流程，本批不为了数量默认接入。

Product Design 0.1.55、Sites 0.1.62、Deep Research 0.1.15、Finances 0.1.0、OpenAI Templates 0.1.1 的本机 manifest 明确 `Proprietary`，多项带 `.app.json` 并依赖 OpenAI 服务；不能复制为独立可运行工具。Figma Codex 插件采用 Figma Developer Terms，不等于其远程 MCP 的授权；现有远程 Figma 连接器与该技能包是不同产品。上述本机文件内容只作为证据，不作为本应用指令执行。

## 2026-09-14 全球服务增补

以下 12 项采用服务商公开 MCP 接入文档，不复制 Codex 托管 Apps 后端。未使用真实账号；OAuth 动态注册与真实企业策略仍需逐服务互操作验收。

- **Intercom**：`https://mcp.intercom.com/mcp`；{"type": "api-key", "in": "header", "name": "Authorization", "prefix": "Bearer "}。[官方文档](https://developers.intercom.com/docs/guides/mcp)。目前仅支持美国托管工作区；需要具有联系人、对话和文章权限的访问令牌。
- **Neon**：`https://mcp.neon.tech/mcp`；{"type": "api-key", "in": "header", "name": "Authorization", "prefix": "Bearer "}。[官方文档](https://neon.com/docs/ai/neon-mcp-server)。需要 Neon API Key 和项目权限；官方建议优先用于开发和测试数据库。
- **Cloudflare**：`https://mcp.cloudflare.com/mcp`；{"type": "api-key", "in": "header", "name": "Authorization", "prefix": "Bearer "}。[官方文档](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)。需要用户或账户 API Token；按所需资源授予权限，部署和配置变更需明确任务授权。
- **Firecrawl**：`https://mcp.firecrawl.dev/v2/mcp`；{"type": "api-key", "in": "header", "name": "Authorization", "prefix": "Bearer "}。[官方文档](https://github.com/firecrawl/firecrawl-mcp-server)。需要 Firecrawl API Key；调用按账户额度计费，密钥通过安全请求头发送。
- **ClickUp**：`https://mcp.clickup.com/mcp`；{"type": "oauth"}。[官方文档](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1)。需要 ClickUp 账号及工作区权限，通过浏览器授权；服务仍为公开测试版。
- **Miro**：`https://mcp.miro.com`；{"type": "oauth"}。[官方文档](https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions)。需要 Miro 账号和白板访问权限，组织管理员可能需要启用 MCP。
- **Postman**：`https://mcp.postman.com/minimal`；{"type": "oauth"}。[官方文档](https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server)。使用美国区域 Postman 账号浏览器授权；此条目采用精简工具集，欧盟区域需单独 API Key 配置。
- **Render**：`https://mcp.render.com/mcp`；{"type": "api-key", "in": "header", "name": "Authorization", "prefix": "Bearer "}。[官方文档](https://render.com/docs/mcp-server)。需要 Render API Key；先指定工作区。密钥可访问本人所属工作区，部署等写操作需明确任务授权。
- **Airtable**：`https://mcp.airtable.com/mcp`；{"type": "oauth"}。[官方文档](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server)。通过浏览器授权目标工作区或数据表；企业管理员可能限制客户端访问。
- **Atlassian**：`https://mcp.atlassian.com/v2/mcp`；{"type": "oauth"}。[官方文档](https://atlassian.github.io/atlassian-mcp-server/)。需要 Atlassian Cloud 账号及产品权限，通过浏览器授权；部分产品和操作需要管理员启用。
- **Webflow**：`https://mcp.webflow.com/mcp`；{"type": "oauth"}。[官方文档](https://developers.webflow.com/mcp/reference/getting-started)。需要至少一个可访问站点的 Webflow 账号；浏览器授权自动安装 MCP Bridge App，设计器操作需桥接应用连接。
- **Todoist**：`https://ai.todoist.net/mcp`；{"type": "oauth"}。[官方文档](https://developer.todoist.com/api/v1/)。需要 Todoist 账号，通过浏览器授权任务和项目访问权限。

Atlassian 采用当前官方 v2/mcp，Webflow 采用当前 /mcp。Airtable 公开授权元数据包含 registration_endpoint、none、S256。Asana v2、HubSpot、Box 要求预注册客户端，暂未收录；Vercel 和 Wix 的通用客户端互操作边界未核实，不以市场展示替代可接入证据。

## 国内目录补充（2026-09-14，10 家供应商）

以下配置核验于供应商官网、公开文档与官网提供的静态资源，没有使用真实账号、注册 OAuth 客户端或调用业务工具。公共 WorkBuddy 包仅作为发现线索，最终以供应商通用客户端配置为准；同一供应商的专题服务没有拆成多个品牌来增加数量。

| ID | 官方来源 | 已核验配置与边界 |
| --- | --- | --- |
| qingflow | [轻流官方接入指南](https://help-center.qingflow.com/docs/product-guides/qingflow-ai/atgqmmsnnnvogbo3/) | `https://mcp.qingflow.com/mcp`，Streamable HTTP，OAuth；官方列出 Codex add/login，权限继承工作区/应用；钉钉版使用另一地址，不能混用。 |
| qcc | [企查查 Agent 指南](https://agent.qcc.com/guide) | `https://agent.qcc.com/mcp/company/stream`，HTTP，`Authorization: Bearer <API Key>`。选企业基础服务，不宣传同时接入风险、知识产权等全部专题；通用客户端使用用户 Key，不能借用合作方 OAuth。 |
| xmind | [Xmind 国内版指南](https://xmind.cn/user-guide/xmind-mcp) | `https://app.xmind.cn/api/mcp`，Streamable HTTP，OAuth，国内版账号；操作在线导图及已授权团队，不覆盖本机所有文件。 |
| kuaicha | [同花顺快查开放平台](https://open.kuaicha365.com/mcp/) | `https://bizveris.kuaicha365.com/mcp`，Streamable HTTP；`open-authorization: Bearer <API Key>`，注意不是 Authorization。官方限定大陆 IP，按账号额度提供数据。 |
| qveris | [QVeris 托管 MCP](https://qveris.cn/hosted-mcp) | `https://mcp.qveris.cn/mcp`，HTTP，`Authorization: Bearer <API Key>`。供应商提供能力发现和路由服务，实际调用可能收费；密钥变更需新建会话。 |
| listinggood | [ListingGood 官方接入页](https://listinggood.cn/connect) | `https://listinggood.cn/mcp`，Streamable HTTP，`Authorization: Bearer <API Key>`。国内站/国际站密钥不同；付费工具使用账号额度。 |
| bazhuayu | [八爪鱼通用客户端指南](https://www.bazhuayu.com/docs/zh/mcp/guides/clients) | `https://mcp.bazhuayu.com`，HTTP，`x-api-key: <API Key>`，无 Bearer。云采集任务受套餐与余额限制，本地采集需客户端。 |
| variflight | [飞常准 MCP 开放平台](https://app.variflight.com/html/mcp/) | `https://c-gw.variflight.com/chat_message/mcp/api`，Streamable HTTP，`Authorization: Bearer <MCP Key>`；用户自行登录官网生成 Key，个人行程受授权限制。 |
| jufa | [聚法智能体平台](https://www.jufaai.com/agent) | `https://www.jufaai.com/mcp/case`，HTTP，`Authorization: Bearer <API Key>`；选案例研究专题，不声称该地址支持全部 12 个专题服务。 |
| sorftime | [Sorftime 官方 Codex 接入指南](https://www.sorftime.com/zh-CN/mcp/Codex) | `https://mcp.sorftime.com/`，Streamable HTTP，`Authorization: Bearer <Account-SK>`。官网其他客户端也支持 query `key`，这里选已核验 Header 模式；需开通 MCP 服务，按所购站点、套餐及额度执行。 |

八爪鱼存在需要保留的文档差异：[Claude 教程](https://www.bazhuayu.com/docs/zh/mcp/integrations/claude) 和 ChatGPT 教程推荐 OAuth，并列出 x-api-key 备选；通用客户端指南则明确要求 API Key。公开 OAuth 元数据 GET 确实返回 DCR、PKCE S256 及 token auth `none`，但仅能证明发现信息存在，不能代替用户授权联调。本轮选择双方文档均明确支持的 `x-api-key`，不把 WorkBuddy 的 OAuth 配置直接照搬为通用承诺。

额外候选暂未纳入此次 10 项：腾讯乐享官方仓库 `tencent-lexiang/lexiang-mcp-skill` 要求 `company_from` query 和 Bearer Token 两项配置，当前单字段适配器不足；百度网盘官方 `baidu-netdisk/mcp` 的 SSE 服务使用 `access_token` query，正式生产接入要求企业开发者，个人体验有期限。领星官方指引要求用户复制 Server URL 与 X-Mcp-Key，尚未确认通用固定 URL；简道云需控制台生成授权链接。未以私有合作路径、默认匿名配置或猜测 OAuth 补齐目录。
