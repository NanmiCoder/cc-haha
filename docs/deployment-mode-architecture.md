# 千川小致Desktop「部署模式」技术架构设计文档

> 关联 issue：HAI-5（分析）→ HAI-6（PRD，已定稿）→ **HAI-7（本文，架构）** → HAI-8（实现）。
> 本文依据 PRD 定稿结论与仓库当前代码（`src/`、`desktop/src/`、`adapters/`）编写。

---

## 1. 概述

### 1.1 目标

引入单一运行时配置项 `deploymentMode`（`public` / `private-cloud`），用一个开关集中控制全部「公网依赖」行为差异，避免在各业务模块散落条件判断。架构要解决三件事：

1. **配置的读取与传播**——谁写、谁读、怎么传到前后端各进程。
2. **入口可见性控制（feature gate）**——按 mode 统一决定导航/页面/路由/服务的可见性。
3. **硬编码外网地址配置化**——把第二类（可配置内部源）的每个地址改为带默认值的可配置项。

### 1.2 核心约束（来自 PRD 定稿的用户决策）

| 约束 | 决策 | 架构影响 |
|---|---|---|
| OQ-1 配置层级 | **纯运行时 Settings**，不构建时锁定，不环境变量锁定 | `deploymentMode` 只存在于 `~/.claude/settings.json`（用户级），全进程在启动时读取 |
| OQ-2 切换行为 | **切换后强制提示重启**，弹「确认并重启」框，不热切换 | 架构无需支持运行时热重载；`applyMode()` 只在进程启动时执行一次 |
| OQ-3 Provider 网关 | 全局默认提示值，新建 Provider 时预填，可逐个改 | 是 Settings 里的「默认提示」，不是强制覆盖 |
| OQ-5 内部技能源 | MVP 只隐藏市场入口 + 本地技能加载；内部源配置项预留、P1 后置 | 架构预留 `internalSkillSource` 字段，MVP 不消费 |

### 1.3 质量属性优先级

1. **向后兼容**（最高）：现有 `public` 模式用户零感知，`deploymentMode` 缺省时行为与现状完全一致。
2. **可维护性**：一处开关 → 全局生效；新增外网依赖时只改配置注册表，不改消费方。
3. **简单性**：复用现有 Settings 链路与已有「essential-traffic-only」gating 模式，不引入新基础设施。
4. **安全性**：私有云模式下默认不发起任何不可达外网请求，避免无意义超时与日志噪声。

---

## 2. 架构总览

### 2.1 设计原则

- **单一真相源（SSOT）**：`deploymentMode` 只在用户级 `settings.json` 里有一份，Server 读取后作为唯一的权威值向前端/CLI 广播。
- **集中消费、统一 gating**：前后端各有一个集中的 `deploymentMode` 读取点（后端 `deploymentModeService`，前端 `useDeploymentMode` hook + `DeploymentModeProvider`），业务代码只查询「现在是否私有云」或「某 feature 是否启用」，**绝不直接读原始 settings**。
- **配置优先级收敛**：因用户决策为「纯运行时」，优先级链简化为 `settings.json(deploymentMode)` → 默认 `public`。不再有构建期/环境变量覆盖。
- **入口 gating 用注册表，不用散落 if**：维护一个 `featureGates` 声明式注册表，把「feature → 可见 mode」的映射集中在一处。

### 2.2 配置读取与传播链路

```
~/.claude/settings.json
  { "deploymentMode": "private-cloud",
    "privateCloud": { "providerGatewayBaseUrl": "...", ... } }
        │
        ▼  (进程启动时读取一次)
  Server: deploymentModeService.getMode()
        │
        ├──► GET /api/settings  → 前端 settingsApi.getUser() 拿到 deploymentMode
        │         │
        │         ▼
        │    DeploymentModeProvider (React Context)
        │         │
        │         ▼
        │    useDeploymentMode() / useFeatureGate()
        │         │
        │         ▼
        │    UI 按 featureGates 条件渲染
        │
        └──► Server 内部服务启动时:
             deploymentModeService.getMode() →
               决定路由是否注册 / 服务是否初始化 / 网络请求是否发起
        │
        ▼
  CLI 子进程: 启动时由 Server 通过环境/启动参数注入 XIAOZHI_DEPLOYMENT_MODE
             (CLI 不直接读 settings.json，避免再解析一次)
```

**关键点**：
- 启动时一次性 `applyMode()`：各服务在初始化时读取 mode，决定行为分支。运行期不切换（OQ-2），所以无需热重载/事件总线。
- 切换流程：用户在 Settings 改 mode → `PUT /api/settings/user` → Server 持久化 → 返回 `{ restartRequired: true }` → 前端弹「确认并重启」→ 调 Electron `relaunch` → 新进程读取新 mode 生效。

### 2.3 技术栈选型

复用现有栈，**不引入新依赖**：

| 关注点 | 选型 | 理由 |
|---|---|---|
| 配置存储 | 用户级 `~/.claude/settings.json`（复用 `settingsService`） | 已有原子写入、前向迁移、缓存失效机制，不新增存储边界 |
| 后端读取 | 新增 `deploymentModeService`（`src/server/services/`） | 集中读取点，与 `settingsService` 同层，单一职责 |
| 前端读取 | 新增 `DeploymentModeProvider`（React Context）+ `useDeploymentMode`/`useFeatureGate` hook | React 标准模式，与现有 `settingsStore`/Zustand 一致 |
| Feature gating | 新增 `featureGates` 声明式注册表（前后端各一份镜像） | 集中映射，消费方只查不判断，新增 feature 只改注册表 |
| 切换重启 | Electron `app.relaunch()` + `app.exit()` | 已有 `appMode`/`appModeLifecycle` 服务，复用其重启机制 |

---

## 3. 模块设计

### 3.1 后端：`deploymentModeService`（新增）

**职责边界**：部署模式的唯一读取与解析点。其他服务/路由/网络请求只通过本服务查询，不直接读 `settings.json`。

**位置**：`src/server/services/deploymentModeService.ts`

**对外接口**：

```ts
export type DeploymentMode = 'public' | 'private-cloud'

export type PrivateCloudConfig = {
  providerGatewayBaseUrl?: string      // OQ-3: 新建 Provider 时的默认预填值
  dingtalkEndpoint?: string            // 钉钉私有部署版 endpoint
  feishuEndpoint?: string              // 飞书私有部署版 endpoint
  updateServerUrl?: string             // 自动更新源（写入/覆盖 app-update.yml）
  internalSkillSource?: string         // OQ-5: MVP 预留，暂不消费
  telemetryEndpoint?: string           // 遥测重定向端点（未配则关闭）
}

class DeploymentModeService {
  /** 启动时解析 settings，缓存 mode 与 privateCloudConfig */
  init(settings: Record<string, unknown>): void

  /** 当前模式（缺省/未知值 → 'public'，保证向后兼容） */
  getMode(): DeploymentMode

  /** 便捷谓词：等价于 getMode() === 'private-cloud' */
  isPrivateCloud(): boolean

  /** 私有云专属配置（mode !== private-cloud 时返回 {}） */
  getPrivateCloudConfig(): PrivateCloudConfig

  /** feature gate 查询：某 feature 在当前 mode 是否启用 */
  isFeatureEnabled(feature: FeatureKey): boolean
}
export const deploymentModeService = new DeploymentModeService()
```

**设计约束**：
- `getMode()` 对任何非法/缺失值一律返回 `'public'`，确保现有用户零感知（向后兼容的最高优先级）。
- `init()` 在 Server `startServer()` 早期、路由注册之前调用——因为 feature gate 要影响路由是否注册。
- `deploymentModeService` 不监听 settings 变更（OQ-2 不热切换），进程生命周期内 mode 不变。

### 3.2 后端：`featureGates` 注册表（新增）

**位置**：`src/server/services/featureGates.ts`

```ts
export type FeatureKey =
  | 'skill-market'              // 技能市场（ClawHub/SkillHub）
  | 'official-oauth'            // Claude/ChatGPT/Grok 官方账号 OAuth 登录
  | 'official-mcp-registry'     // 官方 MCP registry
  | 'official-plugin-market'    // 官方插件市场（GCS）
  | 'claude-in-chrome'          // Claude in Chrome / 便携模式
  | 'im-telegram'               // Telegram IM
  | 'im-whatsapp'               // WhatsApp IM
  | 'im-wechat'                 // 微信 IM
  | 'auto-update-check'         // 自动更新检查（public 启用，private-cloud 默认关，配了 updateServerUrl 才开）

export const FEATURE_MODES: Record<FeatureKey, DeploymentMode[]> = {
  'skill-market':             ['public'],
  'official-oauth':           ['public'],
  'official-mcp-registry':    ['public'],
  'official-plugin-market':   ['public'],
  'claude-in-chrome':         ['public'],
  'im-telegram':              ['public'],
  'im-whatsapp':              ['public'],
  'im-wechat':                ['public'],
  'auto-update-check':        ['public'],  // private-cloud 下：有 updateServerUrl→动态启用，否则禁用
}
```

**规则**：`feature ∈ FEATURE_MODES[feature]` 才可见。`private-cloud` 默认对所有「公网强依赖」feature 返回 false，个别 feature（如 auto-update）再叠加 `privateCloudConfig` 做条件判断。

**消费方式**：
- 路由层：`router.ts` 注册 `market`/`haha-oauth`/`haha-openai-oauth`/`haha-grok-oauth`/`plugins`(official 源) 等资源前，先判断 `deploymentModeService.isFeatureEnabled(...)`；`private-cloud` 下这些路由不注册（404），即便前端误调也兜底。
- 服务层：`officialRegistry.prefetchOfficialMcpUrls()`、`officialMarketplaceGcs.fetchOfficialMarketplace()`、`metricsOptOut` 等在入口处 `if (!isFeatureEnabled) return`，从源头切断外网请求。

### 3.3 前端：`DeploymentModeProvider` 与 hooks（新增）

**位置**：`desktop/src/components/`（与 `AppShell` 同层）+ `desktop/src/hooks/`

**Provider**（在 `App.tsx` 顶层，`settingsStore` 就绪后包裹）：
- 从 `settingsStore` 读 `deploymentMode`（已由 `fetchSettings()` 拉取），注入 Context。
- 暴露 `{ mode, isPrivateCloud, privateCloudConfig, isFeatureEnabled }`。

**Hooks**：
```ts
function useDeploymentMode(): { mode: DeploymentMode; isPrivateCloud: boolean; ... }
function useFeatureGate(feature: FeatureKey): boolean  // true=渲染该入口
```

**消费方式**：所有「入口隐藏类」的 UI 元素用 `useFeatureGate('skill-market')` 等包裹，而非裸 `mode === 'private-cloud'`。这样新增 feature 只改注册表，不改消费组件。

### 3.4 前端：Settings 配置入口（改动）

**位置**：`desktop/src/pages/Settings.tsx` + `desktop/src/components/settings/`

新增一个「部署模式」分栏（线框级）：
- 单选：`public`（公网部署）/ `private-cloud`（私有云）。
- 切换到 `private-cloud` 时展开「私有云配置」区：Provider 网关默认地址（OQ-3 提示值）、钉钉/飞书 endpoint（OQ-6 带说明文案）、自动更新源 URL、内部技能源（MVP 只读「即将支持」）、遥测端点（留空=关闭）。
- 切换确认：提交后弹 `ConfirmDialog`「部署模式切换需要重启应用才能生效，确认并重启？」→ 用户确认 → 调 `window.desktopHost.relaunch()`（复用现有 `appMode` 重启机制）。

---

## 4. 数据架构

### 4.1 存储选型

复用用户级 `~/.claude/settings.json`（`settingsService` 已管理）。**不新增存储边界**，符合 AGENTS.md「不新增依赖/抽象」原则。

### 4.2 核心数据模型（settings.json 新增字段）

```jsonc
{
  // 新增顶层字段（缺省 = 'public'，向后兼容）
  "deploymentMode": "private-cloud",

  // 私有云专属配置；public 模式下忽略、可为空
  "privateCloud": {
    "providerGatewayBaseUrl": "https://gateway.intra.company.com",
    "dingtalkEndpoint": "https://oapi.dingtalk.intra.company.com",
    "feishuEndpoint": "https://open.feishu.intra.company.com",
    "updateServerUrl": "https://updates.intra.company.com/xiaozhi/",
    "internalSkillSource": "",   // MVP 预留，暂不消费
    "telemetryEndpoint": ""      // 空 = 关闭遥测
  }
}
```

### 4.3 配置项命名与默认值（第二类「可配置内部源」清单）

| 配置项 | 字段 | 默认值（public，现状硬编码） | private-cloud 行为 |
|---|---|---|---|
| Provider 网关 baseUrl | `providerGatewayBaseUrl` | 无（各 preset 自带，如 DeepSeek=`https://api.deepseek.com/anthropic`） | 作为新建 Provider 的预填默认值（OQ-3，不强制覆盖已存在的） |
| 钉钉 endpoint | `dingtalkEndpoint` | `https://api.dingtalk.com`（`adapters/dingtalk/index.ts:50`、`adapters/common/config.ts:155`） | 预填到 adapter 配置，指向企业私有部署版 |
| 飞书 endpoint | `feishuEndpoint` | 由 `@larksuiteoapi/node-sdk` 默认（飞书开放平台） | 预填，指向私有部署版 |
| 自动更新源 | `updateServerUrl` | `app-update.yml`（打包时写入，公网 release 源） | 覆盖 `app-update.yml` 的 `url`；**未配则关闭自动检查**（`useUpdateStore` 跳过 `checkForUpdates`） |
| 内部技能源 | `internalSkillSource` | `https://clawhub.ai` / `https://api.skillhub.cn`（`providerFetch.ts` 的 `DEFAULT_BASES`） | **MVP 预留不消费**（OQ-5）；P1 实现后用于替换 `HAHA_MARKET_BASE_*` |
| 遥测端点 | `telemetryEndpoint` | `https://api.anthropic.com`（`firstPartyEventLoggingExporter.ts:118`） | 非空→重定向上报；空→关闭遥测 |

**自动更新源的特殊处理**：`app-update.yml` 是打包期产物，运行时改 settings 无法直接改文件。方案是 `updater` 启动时读 `deploymentModeService.getPrivateCloudConfig().updateServerUrl`，若提供则用 electron-updater 的 `setFeedURL({ url })` 动态覆盖；未提供且 `isPrivateCloud()` 则不调用 `checkForUpdates`（对应 `featureGates['auto-update-check']` 的条件分支）。

### 4.4 向前兼容（向后不变量）

- 旧 `settings.json` 没有 `deploymentMode` 字段 → `getMode()` 返回 `'public'` → 行为与现状完全一致。**无需前向迁移脚本**（这是「新增字段 + 缺省兼容」，不是「形状变更」；但会补一个旧 fixture 回归测试验证缺省返回 public）。
- 新增字段对 `settingsService` 的合并逻辑透明（它本就是 `Object.assign` 任意键）。

### 4.5 一致性策略

- 单进程内：启动时读一次、进程内不变（OQ-2）。
- 多进程间：Server 读 settings 为权威；CLI 子进程由 Server 通过启动参数注入（不各自读文件）；Adapter Sidecar 由 Server 在启动命令里注入对应环境变量（`DINGTALK_STREAM_ENDPOINT` 等已有机制）。
- 无并发切换问题：因为不热切换。

---

## 5. 接口设计

### 5.1 前端获取部署模式（复用现有 API）

不新增端点。`GET /api/settings`（`settingsApi.getUser()`）已返回全部用户设置，前端直接读返回体里的 `deploymentMode` 与 `privateCloud`。

**响应示例**（节选）：
```jsonc
{
  "deploymentMode": "private-cloud",
  "privateCloud": { "providerGatewayBaseUrl": "...", ... },
  // ... 其余现有字段
}
```

### 5.2 切换部署模式（复用现有 API）

`PUT /api/settings/user`（`settingsApi.updateUser()`）直接写新字段。

**请求**：
```jsonc
{ "deploymentMode": "private-cloud", "privateCloud": { ... } }
```

**响应**：现有 `{ ok: true }`。Server 在 settings 写入后，额外返回提示（通过响应或前端逻辑）：切换需重启。

> 说明：不单独造 `/api/deployment-mode` 端点。部署模式本质是 settings 的一个字段，复用 settings 读写接口最简，符合「不新增依赖/抽象」。

### 5.3 Server 内部 API（供其他服务调用，非 HTTP）

```ts
// src/server/services/deploymentModeService.ts
deploymentModeService.getMode(): DeploymentMode
deploymentModeService.isPrivateCloud(): boolean
deploymentModeService.getPrivateCloudConfig(): PrivateCloudConfig
deploymentModeService.isFeatureEnabled(feature: FeatureKey): boolean
```

### 5.4 前端内部 API（hooks）

```ts
// desktop/src/hooks/useDeploymentMode.ts
useDeploymentMode(): { mode, isPrivateCloud, privateCloudConfig }
useFeatureGate(feature: FeatureKey): boolean
```

### 5.5 错误处理

- `deploymentMode` 值非法（非 `public`/`private-cloud`）→ `getMode()` 降级为 `'public'`，并 `logWarning`（不抛错，保证启动）。
- `privateCloud.providerGatewayBaseUrl` 格式非法 → 新建 Provider 时不预填，记 warning，不阻断。
- 切换时写 settings 失败 → 前端提示「保存失败，未切换」，不触发重启。

---

## 6. 非功能性方案

### 6.1 性能

- **零运行时开销**：mode 在启动时读一次、进程内缓存为常量；`isFeatureEnabled` 是 O(1) 查表，无 I/O。
- **减少无意义外网请求**：private-cloud 下从源头不发官方 registry / 遥测 / 市场预取请求，省去超时等待（现状这些请求在不可达环境会产生 5-30s 超时与重试噪声）。

### 6.2 可用性

- 切换流程明确（重启提示），用户不会处于「半切换」的未知态。
- private-cloud 下所有「隐藏类」功能保留本地替代路径（自定义 Provider、手动 MCP、本地技能），核心工作流不中断。

### 6.3 安全性

- private-cloud 默认不发任何不可达外网请求，减少日志中的失败凭证/超时噪声，也降低误连公网的风险面。
- Provider 网关地址只是「默认提示值」，不自动改写已配置 Provider（OQ-3），避免静默改用户数据。

### 6.4 可观测性

- `deploymentModeService.init()` 启动时记录一条结构化日志（mode + privateCloudConfig 是否提供），便于排查「为什么某入口不可见」。
- feature gate 的判断集中，排障时只需看 mode + 注册表，无需 grep 散落的 if。

---

## 7. 部署架构

本文不涉及部署拓扑变更。部署模式是**应用内运行时配置**，不改变进程拓扑（仍是 Electron main + Renderer + Sidecar server + CLI + Adapter sidecar）。对打包/分发的影响：

- 仍是同一份构建产物。private-cloud 用户安装后自行在 Settings 切换模式（OQ-1：不构建时锁定）。
- 自动更新源：private-cloud 用户配 `updateServerUrl` 指向企业内部更新服务器；未配则关闭自动更新。

---

## 8. 架构风险与对策

| 风险 | 影响 | 概率 | 缓解方案 |
|---|---|---|---|
| 配置项增多后可维护性下降 | 中 | 中 | 用 `featureGates` 注册表 + `privateCloudConfig` 结构化字段集中管理；新增外网依赖必须登记进注册表（加测试约束） |
| private-cloud 用户误以为某功能坏了 | 低 | 中 | 隐藏的入口在 Settings「部署模式」分栏集中说明「哪些功能在私有云下不可用及替代方案」 |
| `auto-update` 的 `app-update.yml` 动态覆盖不生效 | 中 | 中 | 用 electron-updater `setFeedURL` 运行时覆盖（非改文件）；未配源则直接跳过检查；加桌面 smoke 验证 |
| CLI 子进程未正确接收 mode 导致行为不一致 | 中 | 低 | Server 启动 CLI 时统一注入 `XIAOZHI_DEPLOYMENT_MODE` 环境变量；加单测校验注入 |
| 向后兼容回归（现有 public 用户行为变化） | 高 | 低 | `deploymentMode` 缺省硬返回 `public`；`featureGates` 在 public 下全部 true；补旧 fixture 回归测试 |
| featureGates 前后端注册表漂移 | 中 | 中 | 前后端各维护一份 `FeatureKey` 类型，但消费逻辑一致；考虑后续抽到共享 `src/shared/`（P1） |

---

## 9. 演进路径（MVP → 完整形态）

### Stage 3（HAI-8）MVP 范围（建议）

按 PRD OQ-5 与用户「先做开关」的意图，MVP 聚焦最小可用闭环：

1. **配置开关落地**：`deploymentMode` 字段 + `deploymentModeService` + 前端 `DeploymentModeProvider` + Settings 配置入口 + 切换重启。
2. **隐藏入口类**：feature gate 注册表 + 6 个入口隐藏（技能市场、官方 OAuth×3 入口、官方 MCP registry、官方插件市场、Claude in Chrome、公网 IM×3）。后端对应路由不注册 + 服务入口短路。
3. **核心 baseUrl 可配**：Provider 网关默认提示值（新建 Provider 预填）+ 钉钉/飞书 endpoint 预填。自动更新源「未配则关检查」逻辑。
4. **遥测**：private-cloud 下未配 telemetryEndpoint 则关闭（复用现有 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`privacyLevel` 机制）。
5. **文档约束类**：部署文档新增「私有云网络前置条件」段落（H5 远程访问、飞书/钉钉私有版），不改代码。

### P1（后续）

- 内部技能源实际消费（`internalSkillSource` 替换 `HAHA_MARKET_BASE_*`，实现企业内部技能市场浏览/安装）。
- `featureGates` 抽到 `src/shared/` 前后端共享，消除漂移风险。
- cc-switch 导入的 baseUrl 智能提示（OQ-4：导入后对外网 baseUrl 提示「建议改为内部网关」）。
- 遥测重定向到内部收集端点的完整实现（若企业有自建遥测后端）。

---

## 10. 开放问题 / 待确认项

PRD 的 6 个开放问题已由用户全部闭合（见 1.2 节）。架构层面，以下点在实现阶段（HAI-8）需由全栈开发专家确认，但**不阻塞架构定稿**：

1. **CLI 子进程注入方式**：通过 `env` 还是 `argv` 传 `deploymentMode` 给 CLI 子进程——取决于现有 CLI 启动封装（`desktopCliLauncherService`）哪个改动更小，实现时定。
2. **Settings 配置入口的 i18n key**：需补 zh/en/jp/kr/zh-TW 五语言文案（`settings.deploymentMode.*`），实现时一并加。
3. **自动更新 `setFeedURL` 的时序**：需确认 electron-updater 在 `main.ts` 初始化序列中，`deploymentModeService.init()` 是否早于 `autoUpdater` 配置——实现时验证时序。

以上三点均为实现细节，不影响架构选型。架构方案至此可提交用户/BOSS 确认技术选型，确认后 HAI-8 开发。

---

*文档生成时间：2026-08-04。基于仓库当前代码与 PRD 定稿结论编写。*
