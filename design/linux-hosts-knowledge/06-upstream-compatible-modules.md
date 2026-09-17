# 模块隔离与主工程升级约束

本文件落实用户的明确要求：尽量少修改已有代码，将新功能集中在新模块，使主工程后续 Bug 修复和功能升级可以较快合入。它约束所有 M0–M11 批次，优先于前文中的一般组织建议。

## 1. 设计原则：业务留在模块，主工程只接线

新增主机、概念、数据库、Redis 不应散落到现有设置页、聊天 store 和服务器中。新模块持有自己的数据、服务、UI、测试和迁移；宿主只负责入口、会话身份和消息流接点。

这不是追求零修改：真实聊天上下文需要跨发送、回放、历史和搜索；如果完全不改这些边界，只能得到看似接入却泄露或丢失上下文的功能。目标是让每个必要改动变成短小、可定位、可测试的委托调用，升级时能逐个确认。

固定约束：

1. 不复制 `ChatInput`、`EmptySession`、`Settings`、`chatStore` 或 `ConversationService` 到新模块维护分叉。
2. 不修改 Provider 请求格式、Agent 工具权限语义、SDK transcript 格式；新的 context 只是经过既有用户消息管道的内容块。
3. 不让主工程通用类型依赖 SSH/SQL 驱动，Node 驱动只能被 Electron 新模块 import。
4. 不修改旧 JSON 文件格式容纳主机/数据库；领域文件独立、版本独立。
5. 不给无上下文的普通消息增加解密、文件扫描、额外网络或等待；没有 feature 数据时快速返回原行为。
6. 不因新模块初始化/库损坏/vault 不可用而阻止普通聊天启动。
7. 不借需求重命名旧文件、改公共 API、抽取庞大通用插件框架或整理全仓样式。
8. 每一处原文件改动必须能映射到本文件的接点编号；白名单外的原文件变更需先写明原因、接点和证明，再实施。

## 2. 新模块目录（最终唯一位置）

```text
desktop/src/features/managed-resources/
  module.ts                       显式入口，无 barrel index.ts
  types/                          纯 DTO、selection、manifest
  api/                            DesktopHost 薄调用
  stores/                         公开资源状态、引用/草稿/队列快照
  hooks/                          两套 composer 共用 controller
  ui/
    HostsWorkspace.tsx
    DataConnectionsWorkspace.tsx
    ConceptKnowledgeSettings.tsx
    hosts/
    context/                      ContextEntryButtons / ContextPicker / chips
    dataConnections/
  integration/
    composerIntegration.ts        slash/refs/session迁移适配
    chatSubmission.ts             prepareAndSendUserTurn
    tabIntegration.ts             新特殊页签生命周期
    providerDisclosure.ts         敏感历史切Provider提示
  *.test.ts(x)                    各文件就近测试；集成fixture可分tests/

desktop/electron/services/managedResources/
  module.ts                       createManagedResourcesModule
  registerIpc.ts
  repositories/                  resources/selection/迁移
  credentialVault.ts
  knownHosts.ts
  sshSessionService.ts
  sftpService.ts
  transferService.ts
  remoteEditService.ts
  contextResolver.ts
  contextTicketClient.ts
  dataConnections/               mysql/postgres/Redis adapters及IPC
  *.test.ts

src/server/features/managedContext/
  module.ts                       createManagedContextFeature
  api.ts
  contextTicketService.ts
  contextProjectionService.ts
  publicRecordRepository.ts
  contracts.ts
  *.test.ts

src/services/managedContext/
  sensitivityPolicy.ts            SDK进程读取会话敏感标记的窄适配
  sensitivityPolicy.test.ts
```

不再创建 `desktop/src/components/hosts`、`pages/HostsWorkspace` 等第二份同功能文件。前文所有拟新增路径已统一到以上目录。源码分析中提到的原有文件路径仍是事实，不代表新增模块要放在那里。

新增 React feature 内仍遵守现有 UI 原语、i18n、a11y 与 token 约束；不因为离开 `components/` 路径就绕开组件规范。入口文件 `module.ts` 只导出明确的宿主接口与工厂，不通配重导出所有内部模块。

## 3. 宿主与模块的窄接口

### 3.1 Desktop renderer

`ContextEntryButtons` 同时渲染相邻主机/概念及旁边数据连接按钮，内部持有各面板开关；宿主不处理标签遍历、依赖展开和密码字段。props 只传 `scope`、disabled/support 状态，使用 feature store 获取公开引用。

`composerIntegration` 提供：

```ts
type ComposerScope =
  | { kind: 'draft'; draftId: string }
  | { kind: 'session'; sessionId: string }

type ManagedContextTriggerInput = {
  text: string
  cursorOffset: number // UTF-16 offset，与textarea/editor adapter一致
  excludedRanges: { from: number; to: number }[] // 半开区间，代码块/行内代码/URL
  isComposing: boolean
}

type ManagedContextTrigger = {
  kind: 'host' | 'concept' | 'database' | 'redis'
  query: string
  replacementRange: { from: number; to: number }
}

// 纯解析；不改DOM，不执行命令
resolveManagedContextTrigger(input: ManagedContextTriggerInput): ManagedContextTrigger | null
// 原子迁移；不复制原composer实现
moveManagedContextScope(from: ComposerScope, to: ComposerScope): void
// 消息入队前复制当前refs；返回undefined代表完全走旧行为
snapshotManagedContext(scope: ComposerScope): ConversationContextSelectionV2 | undefined
```

文本框 adapter 负责从现有结构化编辑器/Markdown token 得到 excludedRanges，不能仅用一个贪婪正则判断所有代码块；生产代码不得以 any 实现。只有光标处触发器被消费，原 composer 继续拥有正文、附件、提交和键盘主流程。range 必须合法且不与 excludedRanges 相交；isComposing=true 直接返回 null。

`chatSubmission.ts` 接收宿主提供的 `sendWireMessage`、等待/读取最终 runtime、最终 session 身份和本轮 requestId，以及 feature selection。无 selection 时立即调用原发送函数；有 selection 时完成 ticket 准备再委托。同一函数供三条普通发送分支调用，不能在 `chatStore` 内复制准备逻辑。

存入原 queue/user message 的新增字段限定为 `managedContext?: { selection?, manifest?, requestId, status }`，其中无秘密正文；类型作为纯 type import。宿主仍拥有 queue 调度，feature 不另建第二个聊天队列。

### 3.2 Electron module

```ts
createManagedResourcesModule({
  getActiveConfigDir,
  getMainWindow,
  getServerUrl,
  getLocalAccessToken,
  safeStorageAdapter,
  nativeDialogs,
  clipboard,
  logger // 只收结构化非正文元数据
}): {
  registerIpc(): void
  dispose(): Promise<void>
}
```

这些依赖来自既有 Electron 服务的注入，模块不反向 import `main.ts`，不自行启动第二个 cc-haha sidecar，不搜索用户 HOME。main 仅创建、注册、退出 dispose。跨 host capability 的声明和 preload 映射仍由宿主维护。

### 3.3 Server module

`createManagedContextFeature` 通过当前 configDir/session lookup/runtime lookup 注入，而不是持有整个 ConversationService 实例。

固定宿主调用点：

- `handleManagedContextApi(req, peer)`：仅匹配 `/api/context-tickets` 相关路由，未匹配返回 null。
- `admitContextTurn({sessionId, requestId, content, attachments, ticket, runtimeRevision})`：校验并返回 reservation 或普通消息 pass-through。
- `composeManagedUserContent(baseContent, reservation)`：在最终 SDK 用户消息 content 处合成一次。
- `commitContextTurn/abortContextTurn`：记录 receipt，消耗/撤销票据；不改变宿主现有 permission 或 Provider 行为。
- `projectManagedUserMessage(sessionId, uuid, rawContent)`：有公开记录则投影，否则只对自己版本化封装做 fail-closed 处理；普通消息原样返回。
- `getManagedSessionPolicy(sessionId)`：返回敏感标记和标题/索引/Trace 采集政策；不返回主机资料或密码。

不得将 SSH/SFTP/数据库具体类型的分支放进 WS handler。server feature 只认识序列化上下文和公开 manifest，实际内容已由 Electron 解析。

### 3.4 SDK 诊断策略的最小接点

SDK 已有进程可能预热，不能只在启动时用 env flag 表示敏感状态。`src/services/managedContext/sensitivityPolicy.ts` 从活动 configDir 下按 sessionId 读取专属布尔策略文件，缺失文件是非敏感，已标记后该进程缓存为敏感；在 Trace/prompt dump 的捕获入口调用。server 在发送首条含秘密上下文前原子写策略文件，写失败不派发。

该适配只处理版本化 `{sensitiveContext: true}` 和 session ID，不读密码、不读资源库、不 import `src/server`。策略文件路径只接受已验证 session ID，未知版本/损坏时对该会话关闭正文采集并保留诊断元数据。原有 logger 的普通行为不做全仓替换。

这是为避免秘密流入应用诊断所需的有限核心修改；不改 `sessionStorage.ts`、SDK raw transcript 或 Provider 执行循环。

## 4. 既有文件接入白名单

每个接点的业务实现和测试主文件都位于新模块；下表只允许薄接线。行数是审查目标，不是通过压缩代码作弊的硬阈值。

| 接点 | 既有文件/区域 | 允许的改动 | 不允许塞入 |
|---|---|---|---|
| U01 | `TabBar.tsx` | 两个图标/点击调用，约 10–30 行 | 连接创建、标签管理逻辑 |
| U02 | `ContentRouter.tsx` | 新页签容器、保活显隐，约 10–25 行 | SSH runtime 初始化 |
| U03 | `tabStore.ts`、`persistenceMigrations.ts` | 新特殊 type/ID/恢复分支、委托 close hook | 新库文件读写、传输取消实现 |
| U04 | `Settings.tsx`、`uiStore.ts` | 概念导航/枚举/独立页面 | 概念 CRUD 与图算法 |
| U05 | `ChatInput.tsx`、`EmptySession.tsx` | 相同按钮组件、trigger委托、scope迁移、snapshot传参 | 密码拼接、闭包算法、网络 staging |
| U06 | `composerUtils.ts` | 保留四命令、调用feature解析；不替换原parser | 新业务命令执行 |
| U07 | `chatStore.ts`、必要的 chat type | 可选managedContext元数据、三发送点委托、UUID回放关联 | 一整套新queue、context序列化 |
| U08 | `api/websocket.ts` | 仅为accepted/rejected/runtimeRevision等必要协议处理 | 知识库和凭据解析 |
| U09 | desktopHost types/electronHost/browserHost、preload、IPC capability校验入口 | 新能力/窄API映射，具体校验委托模块 | 任意RPC/URL/文件路径通道 |
| U10 | `desktop/electron/main.ts`、`keychain.ts` | 工厂创建/注册/退出、修正mock开关策略 | CRUD、SSH/SFTP、数据库操作 |
| U11 | `src/server/router.ts`、必要的 index peer传递 | 新路由委托与真实peer来源传递 | 票据状态机 |
| U12 | `src/server/ws/events.ts`、WS handler | 可选新字段、admit/commit/replay委托、runtimeRevision | 资源类别switch、明文历史投影实现 |
| U13 | `ConversationService` | 最晚compose/canSend绑定，传稳定UUID | 读取主机JSON、vault、额外Provider逻辑 |
| U14 | `sessionService`、`transcriptReducer`、`searchContentProjector` | 唯一project/policy委托 | 多份密码正则过滤器 |
| U15 | 现有title绑定、Trace/prompt-dump入口 | 查询feature policy后跳过该会话正文采集 | 改写所有正常会话诊断格式 |
| U16 | `sessionRuntimeStore`或现有模型切换controller的实际接点 | 敏感Provider切换提示委托，仅在已敏感时执行 | 重做模型选择器 |
| U17 | 五语言locale、package/lock/build、persistence gate | 新keys、已批准依赖收集、注册新测试 | 格式化整个locale或重装所有依赖 |

测试可在原有测试文件补一个“委托接点仍连接”的用例，但主要业务测试放新模块中。严禁因行数目标取消关键历史/搜索保护；这些接点有明确理由，不能只改发送端。

## 5. 升级保护契约

新增 `desktop/src/features/managed-resources/integration/*.test.ts(x)` 和 server feature 的集成测试，至少固定以下契约：

| 契约 | 升级后检测的问题 |
|---|---|
| 空selection完全走原消息链 | 无上下文的聊天被新feature拖慢/拦截 |
| 两套composer均到同一controller | 上游改首页后只剩已有会话可用 |
| 三发送点使用同一ticket准备 | 新队列分支丢引用 |
| final sessionId/runtimeRevision与ticket一致 | 上游会话/运行配置改动造成跨会话发送 |
| SDK UUID → replay/history/project一条身份 | 上游重放格式变动带来重复/泄露 |
| host tab生命周期与主会话互不干扰 | 上游路由重构导致SSH切页就断/关闭聊天 |
| server auth入口拒绝非loopback/非local bearer | 上游H5访问策略扩展意外暴露staging |
| Trace/prompt dump在secret turn前能见标记 | 上游诊断路径绕开新策略 |
| 新版资源库unknown字段与旧fixture保持 | 上游通用设置迁移误清理新模块目录 |
| 移除一个标签重算全部依赖/凭据 | 上游UI改chip未同步真实发送状态 |

测试应驱动真实模块和宿主动作，不使用文本扫描“文件里还有某字符串”作为主要证明。可以有辅助依赖边界检查：renderer不得import Node驱动，Electron模块不得import main，runtime policy不得import server。

## 6. 后续合入主工程 Bug/功能更新的流程

这是未来升级作业说明，不授权当前自动执行 git merge/rebase 或发布。

1. 记录当前主工程 base commit 和模块版本；保存本轮运行证据。确认用户自己的未提交内容已被保留。
2. 比较上游变动是否命中 U01–U17；不命中的模块文件通常可原样保留，仍需跑契约。
3. 命中时逐个恢复薄接点，优先适配 integration 层，不能复制整份旧宿主文件盖掉上游修复。
4. 若上游改了队列、replay、runtime或persistence，先让相应契约真实失败，再修改适配层使其通过；不得把fixture改成新错误行为。
5. 运行新模块窄测试、宿主连接测试、impact要求的check；涉及打包再跑Electron/native/实际产物smoke。
6. 用无新feature数据的旧用户fixture和有feature v2数据的fixture分别启动，证明普通聊天及新增功能都可用。
7. 对比这次 diff：业务改动优先集中于新模块与adapter；原文件如出现大段替换，逐行说明必要性。

主模块 metadata 可在新目录中维护 `integration-map.md`，记录基线 SHA、宿主符号、契约测试位置与最近验证日期；不在原工程每个接点插入大片“补丁开始/结束”注释。

## 7. MiniMax 3 每批必须补的一项报告

```text
升级兼容性：
- 新模块文件：...
- 原文件改动：U05 ChatInput，仅挂ContextEntryButtons及传selection
- 为什么必要：宿主拥有编辑器和提交事件
- 原行为证明：空selection回归通过
- 升级检测：composerIntegration契约通过
```

只要出现无法对应 U 编号的大段原文件业务代码，本批不能标记 passed。先把业务移动回新模块，再做验证；不应等开发全部完成后才尝试模块化。
