# 数据库与 Redis：成熟客户端选型及扩展设计

2026-09-06，依据用户在分析过程中追加的需求编写。此文补充主设计，不替换 SSH、SFTP、概念知识及聊天发送的原要求。

客户端运行和打包范围与主设计一致，只支持 Windows 10 和 Windows 11。MySQL、PostgreSQL、Redis 以及 SSH 目标服务可以运行在 Linux；这不扩展桌面客户端的平台范围。

## 1. 选型结论

有成熟的 Node 技术路线项目，但“完整客户端”和“可嵌入框架”需要区分。当前 cc-haha 已经有 React/Electron 壳和一套认证、设置及 Agent 消息链，首选成熟驱动加本项目工作台，能将连接资料、凭据、标签和模型上下文保持在一个数据源。

技术栈核查于 2026-09-06。按用户最新指示，许可证暂不作为本轮选型门槛；表中仅保留核查事实，设计优先比较可嵌入性、现有 React/Electron 适配和连接状态管理成本。

| 项目 | 定位与技术路线 | 当前许可/集成判断 | 本设计用途 |
|---|---|---|---|
| [DbGate](https://github.com/dbgate/dbgate) | Node/Express + Svelte + Electron，多数据库及 Redis，插件与 Node scripting 接口 | 当前主仓库 GPL-3.0，另有旧许可文件；完整应用，不是 React 插件包 | 最接近整体交互目标，参考连接树/查询/Redis 浏览；不直接搬入源码 |
| [Beekeeper Studio](https://github.com/beekeeper-studio/beekeeper-studio) | Electron/Node 数据库桌面客户端 | Community GPL-3.0-or-later，商业目录单独许可；完整应用 | 参考 SQL 工作台、查询结果和连接编辑交互 |
| [RedisInsight](https://github.com/redis/RedisInsight) | Redis 完整客户端，Electron、React、Node 后端 | 当前根 LICENSE 为 SSPLv1；React 技术相近也不等于独立组件 SDK | 参考键树、类型详情、TTL 和命令工作区 |
| [redis-commander](https://github.com/joeferner/redis-commander) | Node Redis 管理 Web 应用 | MIT；仍带独立 Web 服务、配置和管理界面 | 可作为轻量参考；不另启动一个带重复密码配置的内嵌后台 |

选择独立驱动的原因是避免重复的应用壳、Web 服务、连接配置和凭据体系；不以许可证作为拒绝复用的理由。如果后续明确优先快速得到完整专业客户端，则 DbGate 是 SQL+Redis 一体化的首要技术验证候选，RedisInsight 是专业 Redis 能力的候选；应作为隔离子应用集成验证，不能伪称可直接 import 成 React 组件。该备选不阻塞本轮连接/标签/注入设计。

### 1.1 实际计划引入的依赖

| 数据类型 | 采用 | 原因与范围 |
|---|---|---|
| MySQL/MariaDB | [`mysql2`](https://github.com/sidorares/node-mysql2) | Node 驱动，MIT；连接、参数化查询和流式结果；MySQL/MariaDB 分别测试 |
| PostgreSQL | [`pg`](https://node-postgres.com/) + 同上游 `pg-cursor` | Node 驱动；游标分批读取避免一次加载大结果；不启用原生 `pg-native` |
| Redis | [`@redis/client`（Node-Redis）](https://github.com/redis/node-redis) | 官方 Node 客户端的基础包，MIT；单机连接、TLS、ACL、scan 与类型读取 |
| SQL Server，后续 | [`mssql`](https://github.com/tediousjs/node-mssql) | 成熟 Node 客户端，首版不安装，需求明确后加 adapter |
| Redis Sentinel/复杂集群，后续备选 | [`ioredis`](https://github.com/redis/ioredis) | 支持该类连接的成熟客户端；首版不与 Node-Redis 同时安装，避免重复维护 |

此选型不新增 UI 依赖，不以 ORM（如 Prisma/TypeORM）作为通用数据库客户端底层。首版安装清单限定为 SSH 主设计的 `ssh2` 与此处 `mysql2`、`pg`、`pg-cursor`、`@redis/client`；类型包按实际需要作为 dev dependency。版本在 M0 验证后精确锁定，不在设计中编造“最新版”。

openGauss/GaussDB 不能因为协议近似 PostgreSQL 就标注完全支持；具体认证方式、系统目录及类型兼容需独立 adapter 验证后开放。Oracle/MongoDB/SQLite/ClickHouse、Redis Cluster/Sentinel 首版列为扩展，不出现可保存却无法连接的伪支持选项。

## 2. 功能边界与界面

确定纳入：连接配置、密码管理、多标签、复用已有标签、连接测试、按标签/实体选择及上下文注入。

作为推荐完整客户端范围，设计另包含 SQL 结构浏览、用户主动执行查询、结果分页和 Redis 键值浏览。用户尚未单独回复这部分范围选择，实施时若确认只需资料管理，可停止在 M9；不会影响已经完成的主机功能。应用生成的 SQL 写操作、表格直接编辑、Redis 值修改、TTL 修改、删除键和批量数据迁移不在本轮默认范围；任意 SQL 在显式 query 模式中按真实数据库权限执行，不能保证没有副作用。

### 2.1 入口

右上角保留主机图标，另增加一个 `Database` 图标，label“数据连接”。打开单例 `__data_connections__`、type `data-connections` 工作台。左侧可切“数据库 / Redis”，右侧是连接详情、查询或键值浏览页签。

输入框中“主机”“概念”两个按钮并排，旁边是“数据连接”按钮；数据连接面板顶部横向选择“数据库 / Redis”。所有面板支持多个标签同时勾选，主机、概念、数据库和 Redis 的选择同时保留。`/hh`、`/ce`、`/db`、`/rd` 分别直达对应类别。`db/rd` 与 `hh/ce` 一样是本地保留命令，不注册到 CLI，不立即执行数据库语句。

连接表单复用现有输入与标签组件，显示：名称、引擎、地址、端口、用户名、凭据、默认数据库/Schema、TLS、环境、多个标签、用途/安装与访问说明、关联主机（可选）。Redis 额外提供 ACL 用户、数据库编号、键前缀说明；未填 ACL user 按兼容默认认证语义处理，不能把空字符串错当用户名认证。

操作顺序为保存资料、主动测试、主动连接。保存/打开/选择上下文不自动连接远端。测试成功只表示当前身份能建立连接与轻量探测，不能写“拥有全部读写权限”。

左边连接可按标签分组，同名连接显示地址/引擎；右侧标签顶部常驻连接名、环境、数据库，结果不会跟随左侧随意换目标。只有明确创建/切换连接标签改变执行目标。多个服务共享一个标签时，选择列表清楚显示数量和端点。

### 2.2 SQL 工作区

左侧连接→数据库→Schema→表/视图→列/索引。元数据由各 adapter 查询系统目录；不能让用户提供未经验证的 SQL 模板来驱动系统目录。表预览为应用生成、引擎正确引用标识符的 SELECT；过滤值用参数传入。

右侧 SQL 文本编辑 + 执行/取消 + 结果。查询执行只由用户明确点击或快捷键触发；选择连接或向 Agent 注入资料不会执行 SQL。执行期间固定 connectionRevision/database，不把编辑后的连接偷偷应用到运行中的查询。

首版 `inspection` 模式只提供由应用生成的结构和表预览；任意 SQL 查询在用户明确开启 `query` 模式后使用配置的数据库身份执行。UI 提示推荐使用服务器侧只读账户，**不承诺以 SELECT 开头或客户端复选框就能阻止写入**；不靠正则把任意 SQL 分类为安全。该区按用户账户实际权限工作，应用不自动取得更高权限。

首版不承诺任意 SQL 只读：即使某条 SELECT 可能调用有副作用的函数。若产品要提供强制只读保证，须用数据库侧受限身份并为具体引擎做能力验证，不把字符串解析作为权限边界。首版不提供内置 UPDATE/DELETE/DDL 生成和可编辑结果格。

查询结果：默认最多 1,000 行、硬上限 10,000 行/10 MiB；批次≤200 行。结果头保留列名、类型及重复列索引，结果为 cell 数组而不是列名对象，避免同名列覆盖。BigInt/DECIMAL 用字符串，日期保留类型与原值，binary 用截断预览和长度，NULL 有独立标记。默认不保留查询正文/结果历史，不自动给模型读取结果。

每个 query 使用专用连接/游标；超时默认 30 秒，最大 300 秒，超限暂停或取消。不能通过给用户任意 SQL 尾部追加 LIMIT 限制结果；使用游标/stream 控制消费者、driver cancellation/连接释放。用户取消后若没有 server-side cancel 确认证据，显示“本地等待已取消，服务端完成状态未知”，不能声称数据库语句一定已停止。

### 2.3 Redis 工作区

首版只支持 standalone，端口默认 6379，databaseIndex 默认 0，可配置非负编号，超出目标配置范围显示服务器错误。TLS 可选，但启用时必须验证证书，密码用独立字段，不拼进 URL。

键浏览用 SCAN cursor，过滤用 MATCH；COUNT 是提示值，不是可靠分页大小，可能重复或返回空批，cursor=0 才代表本轮扫描结束。应用按 raw key bytes 去重、保存 cursor，显示“已发现 N 个键”，不编造精确总页数；数据变化时扫描也不是一致性快照。[Redis SCAN 文档](https://redis.io/docs/latest/commands/scan/)

禁止用 `KEYS *`、`MONITOR`、`CONFIG`、`EVAL`、`FLUSH*` 做首屏/后台刷新。默认没有通用原始命令输入口；只实现有界读取方法。用户点击刷新才发起新扫描，后台不持续扫描生产键空间。

支持 string、hash、list、set、zset、stream 的分页读取；分别使用有界 range/scan 操作，不对未知大小集合调用全量读取。TTL 显示 -1 为不过期、-2 为已不存在，查看与读取之间键过期是正常状态。大值只读取前 64 KiB 预览，单页总量≤1 MiB；二进制 key/value 使用 byte encoding，禁止将乱码重编码当原 key。

节点详情显示 key、类型、TTL、大小/数量以及只读内容。关闭连接取消扫描/读取并移除 listener，连接丢失不自动重放任何潜在写命令。首版无键值写入、删除或改 TTL。

## 3. 统一资源模型：v2 增量

不把数据库对象伪装成 Linux Host。保持明确类型，复用标签、vault、修订与 ticket。主设计的 `ResourceDocument` 最终升级为 schemaVersion 2，新增 `dataConnections: DataConnection[]`；旧字段不改语义。

```ts
type DataConnection = SqlConnection | RedisConnection

interface ConnectionBase extends EntityMeta {
  name: string
  address: string
  port: number
  username: string | null
  credentialId: Id | null
  tagIds: Id[]
  relatedHostId: Id | null
  environment: 'development' | 'test' | 'staging' | 'production' | 'unspecified'
  tls: {
    enabled: boolean
    serverName: string | null
    caCertificate: string | null // 公共 CA PEM；不是私钥
    clientCertificate: string | null
    clientKeyCredentialId: Id | null
  }
  description: string
  accessInstructions: string
}

interface SqlConnection extends ConnectionBase {
  kind: 'database'
  engine: 'mysql' | 'mariadb' | 'postgresql'
  database: string
  schema: string | null
  mode: 'inspection' | 'query'
}

interface RedisConnection extends ConnectionBase {
  kind: 'redis'
  topology: 'standalone'
  databaseIndex: number
  keyPrefixDescription: string
}
```

TLS 关闭表示连接可能未加密，配置摘要明确显示；启用时固定验证链与 hostname，自签名使用导入 CA；不提供隐蔽的 `rejectUnauthorized:false` 默认或自动回退。客户端私钥存 vault，对话只注入“配置了客户端证书”和指纹，不注入 PEM。与 SSH 的 safeStorage 可用性/portable 限制一致。

凭据 kind 增加 `database-password`、`redis-password`、`tls-client-key`。记录级 secret schema 及修订校验扩展，公开 DTO 不返回密码或连接 URL。`relatedHostId` 只说明服务部署关系，不自动将该主机的 SSH 密码也加入上下文，不自动建立隧道。

标签仍以 namespace 区分：`host | database | redis | concept`。同名环境标签可分别存在不同 namespace，选择器显示类别。若用户需要一次选完整环境，可在统一选择器勾选四类资源，而不是隐式跨库扩大标签成员。

如果一期后续再需要跨资源统一标签，可新增显式资源集合类型；本轮不借此次扩展引入通用 CMDB/EAV 或插件系统。

### 3.1 Selection 与 manifest v2

- `ConversationContextSelectionV2.schemaVersion = 2`；在原字段上加 `databaseRefs: EntityVersionRef[]`、`redisRefs: EntityVersionRef[]`。
- 同时新增 `directDatabaseIds/directRedisIds`；配合原 directHostIds/directConceptIds 跟踪直接选择来源，移除某个标签不得误删其他来源仍引用的实体。
- `sourceTags` 加 `namespace` 字段；各 memberId 只属于该 namespace。不以同名标签混合解析。
- `PublicContextManifestV2.schemaVersion = 2`；databases 摘要包含 engine/database/schema，redisConnections 摘要包含 topology/databaseIndex，字段不能混用。
- `credentialRefs` 覆盖所有勾选密码的资源；统一 `includePasswords` 开关影响四类资源中有密码的部分，private-key/TLS key 始终不注入。
- 最多 20 台主机、20 个数据库连接、20 个 Redis 连接、100 条概念，合成的总 64 KiB 限额仍适用，不是每类各 64 KiB。
- `context-selections.json` 和 public records 读 v1 时补空 databaseRefs/redisRefs，旧 host/concept refs 保持；sourceTags.namespace 由旧关联类别确定，歧义项标记待重选，不凭同名猜。

新安装直接建立 v2；保留 v1→v2 fixture 与 migration，以便分阶段发布或恢复旧数据。不要求为了迁移先给真实用户写一个 v1 文件再升级。

下面是最终 selection 的完整类型，与主设计已同步的 v2 一致。基础形状 v1 仅用于迁移 fixture，实施者不自行推断字段：

```ts
interface ConversationContextSelectionV2 {
  schemaVersion: 2
  hostRefs: EntityVersionRef[]
  conceptRootRefs: EntityVersionRef[]
  dependencyRefs: EntityVersionRef[]
  databaseRefs: EntityVersionRef[]
  redisRefs: EntityVersionRef[]
  credentialRefs: EntityVersionRef[]
  directHostIds: Id[]
  directConceptIds: Id[]
  directDatabaseIds: Id[]
  directRedisIds: Id[]
  sourceTags: {
    namespace: 'host' | 'database' | 'redis' | 'concept'
    id: Id
    labelAtSelection: string
    memberIds: Id[]
  }[]
  includePasswords: boolean
}

interface PublicContextManifestV2 {
  schemaVersion: 2
  requestId: Id
  selection: ConversationContextSelectionV2
  hosts: { id: Id; name: string; address: string; port: number }[]
  concepts: { id: Id; title: string; includedAs: 'root' | 'dependency' }[]
  databases: {
    id: Id; name: string; engine: 'mysql' | 'mariadb' | 'postgresql'
    address: string; port: number; database: string; schema: string | null
  }[]
  redisConnections: {
    id: Id; name: string; address: string; port: number
    topology: 'standalone'; databaseIndex: number
  }[]
  resolvedAt: string
  containsSecrets: boolean
  secretFieldCount: number
  estimatedTokens: number
}
```

v1→v2 selection：保留原字段和未知字段；缺失 databaseRefs/redisRefs/directDatabaseIds/directRedisIds 均补 `[]`；缺失 directHostIds/directConceptIds 时，将原 hostRefs/conceptRootRefs 中无法确认来自 sourceTags 的根作为直接来源保留，不能清空用户选择。明确归属失败的 tag 标为待重选并阻止自动提交。vault 内容不参与迁移解密。

`recomputeSelection` 固定规则：同 namespace+tagId 只允许一个来源，重新选择同一标签替换该来源 memberIds 并保持来源位置；直接 ID 列表按直接选择先后排列。每类根排序为 sourceTags 保存顺序及其 memberIds 顺序，然后 direct IDs 顺序，稳定按 ID 去重。从存留根重算 dependencyRefs 和 credentialRefs，删除已无根需要的独有依赖/凭据；共享依赖/凭据保留一份。存留实体保持已采纳 revision，新加入项采纳当前预览 revision，遇到已有实体实际版本变化提示更新，不静默刷新。

例：概念根 A 依赖 X、D，根 B 依赖 D、Y；删除 A 的唯一来源后，只保留根 B、依赖 D/Y，X 消失。若 A 同时被直接选择则继续保留。概念本身没有凭据；主机/数据库/Redis 来源变化时另按相同规则重算 credentialRefs。上述重算在一个 store action/主进程校验内完成，不能先删 chip、稍后忘记删依赖或秘密引用。

## 4. 连接、查询与 IPC

进程仍是 Electron owner。增加 `DesktopHost.dataConnections` 和 `dataConnections` capability；配置存储复用同一个 resources repository，连接服务按数据库种类使用明确 adapter。

拟新增文件：

```text
desktop/src/features/managed-resources/types/dataConnectionTypes.ts
desktop/src/features/managed-resources/api/dataConnectionsApi.ts
desktop/src/features/managed-resources/stores/dataConnectionsStore.ts
desktop/src/features/managed-resources/ui/DataConnectionsWorkspace.tsx
desktop/src/features/managed-resources/ui/dataConnections/ConnectionForm.tsx
desktop/src/features/managed-resources/ui/dataConnections/ConnectionTree.tsx
desktop/src/features/managed-resources/ui/dataConnections/SqlQueryPanel.tsx
desktop/src/features/managed-resources/ui/dataConnections/QueryResultGrid.tsx
desktop/src/features/managed-resources/ui/dataConnections/RedisBrowser.tsx
desktop/electron/services/managedResources/dataConnections/connectionService.ts
desktop/electron/services/managedResources/dataConnections/sqlAdapter.ts
desktop/electron/services/managedResources/dataConnections/mysqlAdapter.ts
desktop/electron/services/managedResources/dataConnections/postgresAdapter.ts
desktop/electron/services/managedResources/dataConnections/redisService.ts
desktop/electron/services/managedResources/dataConnections/registerIpc.ts
```

不抽象统一“执行命令”的万能 endpoint。接口固定如下：

| 方法 | 参数/结果 |
|---|---|
| `list/save/deleteConnection` | type DTO + expectedRevision；复用库事务和标签规则 |
| `testConnection` | connectionId 或未保存配置+临时凭据；返回 engine/version/elapsed/capabilities；finally 关闭 |
| `openConnection/closeConnection` | configId + revision → owner-bound dataSessionId/generation；不绑定 SSH shell |
| `listDatabases/listSchemas/listTables/describeTable` | dataSessionId + 元数据标识；adapter 校验与引用标识符 |
| `previewTable` | dataSessionId、generation、tableId、projection/filter/page；生成参数化、有界 SELECT |
| `executeQuery` | dataSessionId、generation、queryId、sql、typed params、limits；query 模式校验，发批次事件 |
| `cancelQuery` | dataSessionId、generation、queryId；结果区分 localStopped/serverCancelled/outcomeUnknown |
| `scanKeys` | Redis sessionId、cursor、match、countHint；返回原始 key 标识和 nextCursor |
| `readKey` | opaque rawKeyToken、type、cursor/range、limits；有界只读 |
| `subscribe` | 连接、查询批次、完成/失败事件；返回 unlisten |

连接测试固定轻量探测：SQL `SELECT 1` 与服务器版本能力信息、Redis PING；没有元数据访问权限时测试可以显示“连接成功，结构权限不足”。测试不枚举全部库、不发送修改命令、不把完整驱动错误中的 DSN 回显到 UI/日志。

openConnection 时固定 configId/configRevision/database/mode/owner，后续 query 必须带该 dataSessionId/generation；queryId 永久绑定该会话。修改保存配置或 inspection/query 模式不升级活动会话权限，必须显式重新打开连接。取消也校验 owner 与 query 归属，不能通过相同 queryId 操作别的连接。

每个会话默认最多 2 个活动查询，全局最多 8 个；结果事件带 queryId/generation，用户切换页签不得把迟到结果写到新连接。数据结果是业务数据，与主设计的主机资料不同，保存在内存且默认不进入聊天上下文。

驱动调用运行在 Electron Node 环境，不尝试让 browser 直接 TCP 连接数据库。首版低并发异步驱动加有界分批返回即可；若实测大结果序列化阻塞主进程，再用专用 worker 分离，不能预先新建一整套 DB sidecar。

SSH 隧道不在当前首版连接模型中。后续如实现，仅通过主机 ID 复用可信 SSH 服务；不能把 UI 中某个终端“已经连上”当作数据库自动可用的网络隧道。

## 5. 数据库与 Redis 的上下文注入

新增 slash 行为与 `/hh` 完全一致：输入 `/db` 显示数据库标签；`/rd` 显示 Redis 标签；默认展开当前成员，可勾选、预览和添加。按钮、首页首轮、队列、会话迁移、版本冲突和票据都复用同一链路。

模型 JSON 数据块 `schemaVersion=2`，保留 hosts/concepts，增加：

```json
{
  "databases": [{
    "id": "30000000-0000-4000-8000-000000000001",
    "name": "项目测试库",
    "engine": "postgresql",
    "address": "192.0.2.20",
    "port": 5432,
    "database": "example_test",
    "schema": "public",
    "username": "test_reader",
    "password": "FAKE_DATABASE_PASSWORD",
    "tls": {"enabled": true, "serverName": "db.example.test"},
    "environment": "test",
    "tags": ["6.13.2测试"],
    "description": "用于功能测试",
    "accessInstructions": "仅测试网络可访问",
    "relatedHostId": "10000000-0000-4000-8000-000000000001"
  }],
  "redisConnections": [{
    "id": "40000000-0000-4000-8000-000000000001",
    "name": "项目测试缓存",
    "address": "192.0.2.21",
    "port": 6379,
    "topology": "standalone",
    "databaseIndex": 0,
    "username": "default",
    "password": "FAKE_REDIS_PASSWORD",
    "tls": {"enabled": false},
    "keyPrefixDescription": "example:test:*",
    "tags": ["6.13.2测试"]
  }]
}
```

这段是新增字段示例，实际消息仍由主设计完整 wrapper 包含 requestId/resolvedAt 等。用字段而不是 `postgres://user:password@host`/`redis://...` 拼 DSN，以免 URL 编码、错误日志与截图扩大密码暴露。

不自动注入整库 Schema、表记录、Redis key/value、查询结果或关联主机密码。用户日后要求“把这张表结构/查询结果加入上下文”时应有显式预览及大小限制的新引用类型，本轮不悄悄加入。

包含数据库或 Redis 密码触发同一 sensitiveContext 标记、AI title 禁用、索引/Trace 策略、Provider 切换说明与 SDK 留存边界。不能只给 SSH 密码做保护而数据库 DSN 原样进日志。

## 6. 必测场景与交付标准

1. 新建 PostgreSQL/MySQL/Redis 配置→保存加密密码→选已有多个标签→四类统一 picker 查到→真实 prepare/ticket→mock SDK 获得正确字段；列表和 renderer store 不出现密码。
2. 引擎默认端口仅在初次选择引擎时填写，不覆盖用户手动端口；相同地址不同端口/数据库/用户名均有独立 ID。
3. v1 主机/概念旧 fixture 升 v2，原密文、unknown 字段、tags 和已保存 refs 保持；新增数组为空，无假的示例连接。
4. TLS 成功/证书不受信任/hostname 不符/客户端 key 解密失败，不能静默降级。驱动错误包含假密码时经过结构化清理。
5. 连接失败/取消/超时 finally 释放；切换连接不串 queryId；晚到事件不能污染新标签。
6. SQL 结果超过 10,000 行或 10 MiB 不产生无界内存，BigInt/Decimal/重复列/NULL 不丢真值；取消结果如实区分本地与服务端状态。
7. Redis SCAN 空批 cursor 非 0、重复 key、键过期、二进制 key、大值、有界 collection；禁止测试实现内部偷偷使用 KEYS/HGETALL/SMEMBERS 全量读。
8. Redis 无密码旧式 AUTH 与 ACL 用户密码分别验证，数据库编号错误有可理解反馈；不根据连接测试成功声称读写权限。
9. `/db`、`/rd` 与按钮等价，包含密码开关关闭时完全不解密；相同标签名在四个 namespace 不串资源。
10. 打包 Windows 产物实际加载 mysql2/pg/pg-cursor/@redis/client，依赖不进入 renderer bundle；在临时数据库服务中完成功能 smoke。

默认 PR 检查使用 fake driver + loopback 协议 fixture；确定性集成使用隔离容器/测试服务和假凭据，并显式标明 docker 缺失为 skipped。不得扫描或连接用户保存的数据库。实现具体镜像版本和 fixture 时锁定版本；不拉 latest、不在普通 CI 使用真实公网数据库。

M9 完成配置/测试/注入；M10 完成结构/查询与 Redis 浏览。只交付连接表单不能声称已完成完整数据库客户端。全部实施顺序见 [任务说明](03-minimax-implementation.md)。
