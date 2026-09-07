# MiniMax 3 开发任务与验收契约

本文把功能拆成可独立验证的小批次。实施者只能按已经确定的设计实现，不自行换框架、放宽密码/文件保存边界，或把尚未连接的 UI 当完成功能。

必须同时阅读 [模块隔离与升级约束](06-upstream-compatible-modules.md)。新增业务放独立模块；下文列到的原文件只允许该文 U01–U17 白名单中的薄接线，每批报告原行为与升级契约证据。

## 1. 实施时只采用这一套方案

| 项目 | 固定决定 |
|---|---|
| 客户端平台 | 只支持并验收 Windows 10、Windows 11；macOS/Linux 桌面构建和专用实现不在范围内 |
| 应用集成 | React + Zustand + 现有 DesktopHost + Electron，sidecar 只扩上下文发送 |
| SSH/SFTP | Electron 中使用 ssh2；复用现有 xterm；不执行本地 sshpass/scp 命令 |
| 数据库 | Electron 内 mysql2、pg/pg-cursor；Redis 为 @redis/client；不安装整套 DbGate/RedisInsight |
| UI 入口 | 标题栏主机、数据连接图标；设置页概念知识；输入框并排“主机”“概念”，旁边“数据连接” |
| 多标签 | 各类可同时多选，按 ID 合并；来源独立，删除某标签不能移除另一来源仍需的实体 |
| slash | hh/ce/db/rd 为本地上下文 UI 命令，非 CLI 命令 |
| 数据 | 最终资源、selection、manifest schema v2；v1 是基础模型及迁移 fixture |
| 凭据 | 独立加密字段；连接与提交时解密；不将 prompt 明文放 renderer store |
| 注入 | main prepare → sidecar ticket → UUID 绑定的普通 WS → ConversationService 一次合成 |
| 生效范围 | 当前会话保持到移除；每条消息固定所选 ID 与修订；旧历史无法撤回 |
| 首版执行面 | 普通桌面聊天、手动 SSH、数据连接管理、SQL/Redis 浏览；不扩 H5/IM/team-member/subagent |
| 许可 | 暂不作为设计/实施阻塞；技术选型不以许可作为拒绝理由 |

数据库范围尚无用户单独确认时，按推荐 M9+M10 设计实施；只有用户明确改成“只要资料管理”，才将 M10 标记 deferred。不得自己认为查询难做而删除它。

## 2. 开始前固定动作

1. 在 `D:\srcs\cchaha\cc-haha` 执行 `git status --short`，将既有改动记入本轮记录；不得清理、重置或覆盖。
2. 阅读根 AGENTS，以及待改目录的嵌套 AGENTS；当前文档不替代仓库规则。
3. 按 README 阅读分析和两份设计。设计与最新明确用户要求冲突时按用户要求修改设计，再继续；不能在代码中偷偷偏离。
4. 核对关键符号，而非依赖旧行号：`TabBar`、`ContentRouter`、`useTabStore`、`ChatInput.handleSubmit`、`EmptySession`、`chatStore.sendMessage/queueUserMessage/sendQueuedMessage`、WS `handleUserMessage`、`ConversationService.sendMessage/buildUserContent`。
5. Windows 的 Bun 不在 PATH 时使用 `C:\Users\29267\.bun\bin\bun.exe`；rg 使用用户 AGENTS 给出的绝对路径。不得因为命令未解析就删除/重装依赖树。
6. 用户运行 Bundle 是 `D:\tools\cc-haha-desktop-2026-09-05`。它不是源码编辑目标，禁止直接复制半成品覆盖正在运行的 Bundle。本轮真实实现完成后，另在隔离输出目录验证打包；是否替换运行版本需要单独明确任务。
7. 桌面客户端平台只包含 Windows 10 和 Windows 11。不要开发、修复或运行 macOS/Linux 桌面客户端专用构建；远端被管理的 Linux 主机仍按 SSH/SFTP 设计实现。

本次设计交付没有授权创建/切换分支、提交、推送、PR、发布、扫描真实服务器或使用模型额度。开发任务开始后也不能把可访问的真实凭据当测试授权。

## 3. 每个开发批次的输入与输出

每批只处理下面一个 M 编号中的一个子项。一个子项原则上≤6 个生产文件，测试文件按实际需要；若跨进程接点需更多，拆成“类型/服务”“接线”“闭环”三个连续子项，不能删测试来凑数量。

输入必须明确：任务 ID、已完成依赖、允许编辑路径、预期行为、fixture、验收命令。

输出固定格式：

使用 [共享目录监督协议](07-agent-supervision.md) 时，以其 JSON 提交模板和任务单为实际交接入口：开发端只能提交 `ready_for_review / blocked`，审计端独立发布 `ACCEPTED / REWORK / RESTART_STAGE / BLOCKED / STALE`。下述 passed 等仅描述检查结果，不能代替审计放行。只执行 control 指向的任务，不能自行按本文开始下一批。

```text
任务：M?.?
状态：passed / failed / blocked / not run
行为：完成了什么真实变化
修改：本批文件清单
证据：实际运行的命令、退出码、关键结果
未完成：明确项目；无则写无
下一批：唯一后继任务 ID
```

不能写“应该通过”“理论可用”“测试已覆盖”而不附本轮实际结果。不能调现有测试输入让其配合新实现；不 mock 正在验证的模块本身。

## 4. 稳定接口与阶段顺序

### M0 — 契约与依赖验证

依赖：无。

允许范围：新增纯类型和 schema 文件、其测试、桌面依赖和锁文件、必要的 Electron build 配置。不得修改聊天运行逻辑。

- M0.1：新增 `desktop/src/features/managed-resources/types/resourceTypes.ts`、`desktop/src/features/managed-resources/types/dataConnectionTypes.ts`。规范类型唯一名称为 `ConversationContextSelectionV2`、`PublicContextManifestV2`，不再建立 SelectionV2/无版本名的同义类型。资料 schema 使用仓库已有 Zod；IPC 复用已有字段校验工具，所有对象、union、错误码、事件字段与设计一致。不要创建通用 key/value 属性表替代具体类型。
- M0.2：只在 `desktop/package.json` 锁定运行依赖 `ssh2@1.17.0`、`mysql2@3.24.3`、`pg@8.23.0`、`pg-cursor@2.22.0`、`@redis/client@6.2.1`，开发依赖锁定 `@types/ssh2@1.15.6`、`@types/pg@8.23.1`、`@types/pg-cursor@2.7.2`；`mysql2` 和 `@redis/client` 使用包内类型。只更新 `desktop/bun.lock`，不得改根 `package-lock.json` 或其他锁文件。在新目录 `desktop/electron/services/managedResources/` 增加无网络的依赖探针及测试，验证五个驱动在当前 Electron 42 的 Node 主进程环境可加载并具有 `Client/createConnection/Client/default/createClient` 入口；递归检查 `desktop/src` 的 import specifier，证明 renderer 没有导入这些包。此子阶段不连接 SSH、数据库或 Redis，不接入 `main.ts`、IPC、UI、聊天和打包配置。
- M0.3：编写纯契约 fixture：Host、Concept、MySQL/PostgreSQL、Redis、selection v2、publicManifest v2、ticket wire example。server/desktop 分别验证同一个 fixture，防止两端类型漂移。
- M0.4：创建新模块入口与 integration-map，固定宿主 U01–U17 的符号和无feature回归契约。工厂依赖注入，禁止反向import main或复制composer。

通过条件：普通桌面构建与 Electron 构建仍可加载；所有新类型示例过校验，非法端口、未知引擎/拓扑、重复 ID、缺失字段拒绝；未出现 native 模块找不到。

停止条件：依赖无法在目标 Electron 产物运行，或必须新增未设计依赖。报告具体加载错误与版本；不要改用自制 SSH/数据库协议，不在主界面塞 iframe 假实现。

### M1 — 本地资源库、vault 与迁移

依赖：M0。

允许范围：`desktop/electron/services/managedResources/` 的 repository/vault/known-host storage、新迁移测试、`keychain.ts` 及启动策略最小接线、persistence lane 注册。

- M1.1：`resources.json` v2 的读写、串行事务、revision、原子保存、未知字段透传、损坏与高版本只读。
- M1.2：标签唯一性和关联验证；Host/Application、DataConnection、Concept CRUD；删除引用约束。
- M1.3：Windows 10/11 `safeStorage` adapter、临时凭据、record payload 校验。加密不可用、加解密自检失败和解密失败均明确处理，不覆盖旧密文，不为 macOS/Linux 桌面后端增加分支。
- M1.4：context selections v2 存储、v0/v1 fixture、credential revision 变化；将新增旧-fixture 测试接入 `check:persistence-upgrade`。

通过条件：在临时目录创建/重启读取保持资料，磁盘无 fixture 明文密码；fake secure vault 成功，不可用 vault 的临时连接仍可用而保存失败；v1→v2 保持 host/concept/unknown 字段；故障注入不破坏旧文件。

不允许：触碰真实 `~/.claude`/keychain、用 real safeStorage 作为 CI 唯一测试、写用户 global settings schema、损坏文件清空重建。

### M2 — DesktopHost 与管理界面闭环

依赖：M1。

允许范围：新 IPC、DesktopHost types/electronHost/browserHost/preload、薄 API、资源 store、host 工作台表单与树、TabBar/ContentRouter/tabStore 的最小接线、相关 i18n/tests。

- M2.1：所有新 IPC 实现主窗口主 frame 校验；schema 与 owner 双校验；browser unavailable 明确返回。
- M2.2：右上主机图标→单例工作台，主机新增/编辑、应用列表、凭据输入、多个已有标签选择与新建。
- M2.3：标签管理、namespace 唯一性、实体删除引用提示、元数据 JSON 导入导出。
- M2.4：页签恢复 allowlist 与迁移，窗口关闭资源清理入口；此阶段主机列表可显示未连接，不显示伪终端成功。

通过条件：真实表单操作经 API/IPC fake boundary 到真实 repository，再刷新看到同一资料；重复点击图标不新增页签；重开不丢主机；跨窗口调用被拒；五语言 keys 齐全、六主题 token 可解析。

### M3 — 真正的 SSH 控制台

依赖：M2。

允许范围：SSH 服务、SSH xterm runtime/surface、主机 workspace 接线与 focused terminal tests；本地 terminal 只允许必要的显示层提取。

- M3.1：allocate→subscribe→start、连接状态机、SSH 认证、host key challenge、超时/取消/generation。
- M3.2：PTY shell 输入输出、UTF-8、resize、Ctrl+C/复制、xterm ack 与高低水位背压。
- M3.3：多主机/同主机多连接、切页保活、重连新 generation、退出及 renderer 生命周期清理。

fixture：loopback `ssh2.Server`，固定测试 key、假密码、独立端口；可编排初始 banner、分片 UTF-8、认证失败和断连。不连接用户主机。

通过条件：首个 banner 不丢、多终端输出不串、隐藏/恢复只保活一次、迟到回调不能复活关闭连接、已变更 key 不进入密码认证、持续输出背压可恢复、关闭无 socket/listener 泄漏。

### M4 — SFTP 与远程文件编辑

依赖：M3。

允许范围：SFTP/transfer/edit 服务、文件区/任务条/编辑器组件、新增脚本 fixture；不改 Agent 本地文件工具。

- M4.1：目录读取、POSIX 路径、文件/目录操作、隐藏文件、symlink 行为。
- M4.2：原生文件选择 capability、流式上传下载、目录枚举、冲突策略、取消和 `.part` 清理。
- M4.3：2 MiB UTF-8 编辑、stat+SHA-256 修订、保存互斥、冲突 diff、同目录 temp+安全 replace。
- M4.4：dirty/传输关闭确认、断线草稿保留、save race 故障、权限和元数据限制提示。

通过条件：文件字节往返相等；取消不改原文件、不删他人临时文件；外部写入后 save 返回冲突且保留草稿；不支持 atomic replace 时拒绝覆盖；有特殊文件和非法编码时不假成功。真实 SSH 容器 smoke 验证 shell+SFTP+vim/resize/上传下载，记录环境；fixture 单测不是 OpenSSH 兼容证明。

### M5 — 概念知识与确定性解析

依赖：M2；可与 SSH 工作不冲突地排在 M4 之后。

允许范围：概念 repository 校验、dependency resolver、设置独立页面、settings/uiStore 接线和测试。

- M5.1：概念 CRUD、多标签、依赖和参考选择、反向关系列表。
- M5.2：事务内三色环检测、依赖先于根、按 ID 去重、根顺序和依赖顺序稳定。
- M5.3：删除阻塞、缺失引用、revision 冲突、大小/深度/节点上限。

通过条件：fixture C 依赖 A/B、A/B 都依赖 D，选择 C+A 输出 D,A,B,C（A 标为 root），D 只一份；reference 不自动带正文；环 C→A→C 返回完整路径。通过 UI 保存生成状态，不手工 setState 模拟完整图。

### M6 — 并排多标签入口与草稿/队列

依赖：M2、M5。

允许范围：ContextPicker、context controller/store、composerUtils、ChatInput、EmptySession、chatStore 的引用字段与迁移动作；此阶段不解密 prompt。

- M6.1：在两套 composer 都加入并排“主机”“概念”按钮，旁边数据连接按钮；同一 selection 能同时保存各类标签。
- M6.2：`/hh /ce /db /rd` 精确命令匹配与有空格后的过滤；代码/路径/IME/Enter/Esc 边界。
- M6.3：sourceTags+direct IDs、多来源并集、移除某来源后的保留、同名不同 ID、成员固定快照。
- M6.4：draftId→最终 sessionId 原子迁移；已有会话 refs 隔离；queue item 创建时复制 refs，编辑正文保留引用；失败不清空。

通过条件：同样多标签由按钮和 slash 得到相同 refs；主机/概念互不覆盖；A={H1,H2}、B={H2,H3}，两标签选中得到 H1/H2/H3，移除 A 得到 H2/H3；若 H1 是直接选择则保留 H1。首页选择后创建会话不丢 refs；后台队列不因用户切换到另一会话改变。

限制：本阶段 UI 可展示“待发送上下文”，不得仅把标签名称拼到文本后作为 F07/F09 已实现。

### M7 — Ticket 与消息提交闭环

依赖：M1、M6。

允许范围：main context resolver/ticket client、server context-tickets API/service、两端 wire types、WS handler、ConversationService、统一 prepareAndSend 接线及 focused tests。

- M7.1：确定性模型 JSON、公开 manifest、版本/依赖/credential 校验、64 KiB 限额、无密码模式零 decrypt。
- M7.2：先建立公开 context-turn/receipt repository、最小 UUID user replay 投影；然后 main 固定 loopback staging、严格路由 auth、TTL/容量、runtimeRevision、正文/附件/context binding。
- M7.3：user UUID=稳定 requestId，service 最晚 reserve/复查/合成；accepted/rejected、receipt 状态和幂等。
- M7.4：即时/idle出队/busy引导发送三条路径共用准备；过期/断线/重启和 delivery-unknown；非普通会话拒绝。

通过条件：此阶段只跑 `includePasswords=false` 的 UI→stage/WS→mock SDK 闭环，JSON 中既有原正文/图片，也有且只有一份非秘密上下文；无 vault decrypt。公开 receipt 在派发前持久化，user replay 按 UUID 关联。换 runtime、取消、附件处理延迟竞态中不能误发旧上下文。相同 ID 重试一次，新的 ID 同样正文两次。密码解析仅在隔离 resolver 单测中测试，完整含密码闭环在 M8 验收。

M7 的 composition root 将 `allowSecretDisclosure` 设为 false，capability 返回不可用且 prepare 的 includePasswords=true 返回 `SECRET_DISCLOSURE_NOT_READY`；这是分阶段开发保护，不是最终产品降级。M8 完成全部保护及闭环测试后才设为 true，并移除开发期不可用文案。不要发布 M7 中间态。

### M8 — 历史、标题、搜索、Trace 与回放

依赖：M7。

允许范围：contextProjectionService、sessionService、transcriptReducer、searchContentProjector、title 绑定、WS replay、chatStore ID 关联、Trace/prompt dump 的最小 sensitivity 接点、迁移和对应测试。

- M8.1：复用 M7 的公开 records 与最小 replay 投影，扩展历史 API，证明重放/历史一致、缺少公开记录时不返回 raw block。
- M8.2：敏感会话禁用首轮和 assistant 回调的 AI title，使用干净正文派生；不误伤普通会话标题。
- M8.3：SQLite 与 fallback 搜索都走安全投影，敏感标记生效后重建派生索引；Trace/prompt dump 不捕获该会话正文。
- M8.4：Provider 变更对敏感历史显示准确说明，切换取消不改配置；普通会话继续原行为。
- M8.5：派发前写 sensitivity 策略文件并接 SDK Trace/prompt-dump guard，证明写失败不派发；完成所有安全投影测试后在 composition root 开放 allowSecretDisclosure，执行含实际假密码的完整 UI→mock SDK→replay/history 闭环。

通过条件：普通形式密码 `fake-host-password-123`（不能只用 sk-token）在 renderer state、public manifest、应用搜索 snippet、标题、Trace/dump 中不出现；mock SDK transcript 允许按设计包含它，测试和产品说明明确区别。缺失 record 和重启恢复不泄露 raw block。

此阶段只控制应用额外复制与展示，不改造全部 SDK 秘密历史存储。不得以“用户看不到密码”宣称完全不落盘。

### M9 — 数据库/Redis 连接管理与注入

依赖：M0–M2、M6–M8。

允许范围：dataConnections 服务/IPC/API/store/表单/树、数据连接页签接线、context resolver 的 typed extension、schema v2 迁移与测试。

- M9.1：SQL/Redis discriminated union、默认端口、TLS、ACL/database、关联 host、多标签、加密凭据。
- M9.2：轻量连接测试、独立连接身份、finally 清理、结构化错误；保存/选入不连接。
- M9.3：输入框数据连接→数据库/Redis 多标签，`/db /rd`；加入同一 ticket JSON，版本与凭据规则不旁路。

通过条件：新建三种 fixture 连接（MySQL、PostgreSQL、Redis），选择两个重叠标签，mock SDK 获得 engine/address/port/database/user/password 等正确字段；不额外传关联主机密码，不自动扫描键/表；TLS 失败不降级；v1 旧数据可读且无资料丢失。

### M10 — SQL 结构/查询与 Redis 键值浏览

依赖：M9。

允许范围：mysql/postgres adapters、query panels/result grid、redisService/browser 和其测试。不得把此阶段改成引入整套外部应用。

- M10.1：按 adapter 获取数据库/Schema/表/列，生成参数化表预览，默认 inspection。
- M10.2：显式 query 模式 SQL、游标/stream、有界批次、类型保真、cancel/timeout 状态、不持久化业务结果。
- M10.3：Redis SCAN cursor、多类型有界读取、TTL、二进制 key、过期/变更状态。

通过条件：超过行/字节上限不会无界读取；相同列名不覆盖；大整数不损失精度；断连/cancel 有明确结果；SCAN 空批非结束、重复键去重、key 消失正常显示；所有实际执行绑定打开该标签时的连接 ID。该阶段提供客户端操作，不自动给 Agent 注入查询结果。

### M11 — 集成、运行与打包验收

依赖：全部适用阶段。

允许范围：修复证实的问题、deterministic smoke 接点、构建需要的最小改动、用户文档（此时遵守 docs 中英规则）；不借集成进行全局格式化。

- 从空白临时配置启动 Electron，走下表完整场景；记录 UI 操作与截图。
- 执行 narrow tests、impact 选中全部适用 checks、persistence、chat contract、agent-flow、desktop UI smoke；Windows 10/11 产物真实加载及 loopback smoke。
- 更新依赖包收集规则、打包产物清单；不要把开发目录存在的 node_modules 当产物已携带依赖。
- `git diff --check`、`git diff`、`git status --short`，确认无真实凭据/生成物/用户改动混入。

完成只表示本轮证据支持的范围。macOS、Swift 和 Linux 桌面平台 gate 对本产品不适用，记录 `skipped: Windows 10/11 only`；不得为了运行它们安装平台工具或修改产品代码。Docker 等适用于协议 fixture 的工具缺失时记录 skipped/blocked，不能伪造通过。

## 5. 最终验收矩阵（执行者照表逐项）

| 用例 | 操作与关键断言 | 最低验证方式 |
|---|---|---|
| A01 | 首页无聊天→主机图标→单例页签，重复点击不复制 | UI + store action |
| A02 | 新建 H1/H2/H3、标签 A/B；保存重开资料完整 | UI→IPC→repository fixture |
| A03 | 主机、概念并排；各选≥2 标签，同存；移除重叠来源不误删 | 两套 composer 的 DOM 事件测试 |
| A04 | `/hh ` 过滤中文标签；IME Enter不确认，选中Enter不发送 | parser + real input events |
| A05 | 首页选引用→新建/替换session→第一条模型输入含全部资料 | join test/mock SDK |
| A06 | SSH首次key确认、key变化拒绝；假密码连接成功/失败 | loopback SSH protocol |
| A07 | 两终端+分片中文+初始banner+resize+Ctrl+C+保活 | runtime integration + smoke |
| A08 | 流式目录传输、覆盖冲突、取消、Windows非法名 | temp local FS + SFTP fixture |
| A09 | UTF-8保存成功；外部修改冲突；无原子覆盖拒绝 | edit service→SFTP integration |
| A10 | C依赖A/B、共同D；去重/顺序/环路/参考不展开 | repository action→resolver |
| A11 | 运行时排队，后续改选不改队列；资料变更暂停发送 | queue action→prepare |
| A12 | 当前模型/runtime改变、ticket过期、取消竞态不误发 | WS+ConversationService fixture |
| A13 | 同UUID不重复；不同UUID同正文保留；重启未知不自动重发 | transport+replay+receipt |
| A14 | 正确假密码进mock SDK，未进入标题/前端/搜索/Trace | sentinel scan of test outputs |
| A15 | 无密码开关不调用decrypt且vault不可用时仍能发 | resolver→mock SDK |
| A16 | MySQL/PostgreSQL/Redis资料多标签→`/db /rd`注入 | 同一 ticket join |
| A17 | SQL有界类型保真、取消不串连接；Redis cursor/binary/TTL | fake+isolated service integration |
| A18 | 旧数据升级、损坏保护、未知字段、高版本只读 | persistence fixtures |
| A19 | 五语言/六主题/键盘焦点/组件可达；小屏主机概念仍相邻 | contracts + rendered smoke |
| A20 | Windows 10/11 独立输出启动并连接测试服务；退出无残留 | packaged Electron smoke |

## 6. 检查命令与执行规则

这些是未来实施命令，不表示设计阶段已经执行。新增路径只在对应阶段建立后运行；测试路径以实际建成文件为准，不能把“文件不存在”报告成跳过成功。

```powershell
bun test ./desktop/electron/services/managedResources
bun test ./src/server/features/managedContext
bun run --cwd desktop test -- --run src/features/managed-resources
bun run --cwd desktop test -- --run src/components/chat/ChatInput.test.tsx src/pages/EmptySession.test.tsx
bun run --cwd desktop check:electron
bun run check:impact
bun run check:persistence-upgrade
bun run check:chat-contract
bun run check:agent-flow
bun run check:desktop-ui-smoke
```

`check:impact` 选中什么就继续执行什么，包括 `check:server/check:desktop/check:native/check:policy/check:coverage` 等；上表不是豁免列表。`check:docs` 含安装步骤，与依赖 root node_modules 的检查顺序执行。只有用户要求全量验证，或准备声明 PR-ready/push-ready 时，运行 `bun run verify`；此任务不自行创建 PR。

所有测试使用临时 HOME/USERPROFILE/CLAUDE_CONFIG_DIR，清理仅删除已验证位于临时测试根的路径。真实数据库/SSH smoke 只用明确创建的本地测试实例，真实用户配置不进入测试。

ad-hoc UI 按仓库要求使用其指定浏览器技能；若技能缺失，报告缺失并使用已获授权的可用验证能力，不将已有 agent-browser 脚本偷换成任意浏览器操作。原生窗口和打包流需要真实 Electron smoke，browser build 不能代替。

## 7. 让模型立即停止当前子项的条件

- 接口所需信息在两份设计中冲突：报告文件和段落，不凭自己喜好选择。
- 发现需要把密码放 renderer modelContent、命令行参数、public REST 返回或普通 localStorage 才能实现：说明当前接点不足，不能先写后补。
- 依赖版本/API 与设计能力不符：返回实际类型/API 和验证结果，不发明不存在的方法。
- 远程操作失败、结果未知、数据版本冲突：保留原始资料/草稿，不能通过自动覆盖“修好”。
- 为让测试过必须回滚用户文件、修改无关配置或让真实凭据进入测试：停止，说明具体阻塞。
- 子项扩散到未计划领域：先在本目录补明确的小范围设计，再进入下一子项；不做整仓重构。

可继续的独立工作仍应完成；“有一个未知项”不等于丢弃整个原始目标。

## 8. 可直接给 MiniMax 3 的启动提示词

```text
在 D:\srcs\cchaha\cc-haha 实施“主机、数据库、Redis与概念知识”功能。

先阅读：
1. AGENTS.md 以及待改目录嵌套 AGENTS.md
2. design/linux-hosts-knowledge/README.md
3. design/linux-hosts-knowledge/01-project-analysis.md
4. design/linux-hosts-knowledge/02-functional-technical-design.md
5. design/linux-hosts-knowledge/05-database-redis-design.md
6. design/linux-hosts-knowledge/03-minimax-implementation.md
7. design/linux-hosts-knowledge/06-upstream-compatible-modules.md
8. design/linux-hosts-knowledge/07-agent-supervision.md（启用共享目录监督时）

当前下一任务只执行 M0.2 依赖验证。不要开始 M0.3 或后续任务；精确路径、版本和验收命令以共享目录的当前任务单为准。
若启用共享目录监督，以 runtime/agent-supervision/managed-resources/control.json 的当前任务为准，提交后等待审计，不能自行开始下一阶段。
先运行 git status --short，保留所有既有改动。
只增加锁定依赖、新目录中的无网络加载探针及边界测试；不新增资源业务服务、界面或聊天接线。
主机/概念为并排按钮且支持多个标签，这个约束不能改成单选或合并入口。
密码存储、资源修订、上下文来源、ticket字段按文档精确实现。
不修改生产聊天发送逻辑，不连接真实服务器，不读取真实凭据。
新代码只放指定feature模块；原文件只作U01-U17白名单的薄接线，禁止复制宿主组件。
不创建/切换分支，不commit/push/PR，不发布，不使用真实模型额度。
许可证暂不作为本轮阻塞条件，不擅自改既定技术方案。
所有新增状态和错误必须有明确类型，不以any、TODO或假成功绕过。
先写能表达非法/合法边界的测试，再实现并执行相应窄检查。
如设计冲突，报告确切段落和最小缺失信息，不自行猜。
结束按文档模板报告修改、实际检查与下一子项，不声称整个功能已完成。
```

后续每轮把提示中的任务 ID 换成唯一下一子项，并附前一轮实际通过的证据。不要一次把 M0–M11 全部交给能力较弱的模型，避免它在上下文压缩后丢掉身份、队列、持久化和异常规则。
