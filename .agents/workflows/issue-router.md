# GitHub Issue 本地路由流程

状态：本地调度 CLI 已实现。阅读本文不授予派单或 Git 操作权限；启用后沿用用户已经明确的动作范围。定时器、GitHub 查询和执行会话由当前客户端的管家适配，CLI 不调用 Codex 私有 API、不调用模型、不启动后台服务。

本流程随仓库保存，适用于能读取仓库的不同 Agent 客户端。管家是可交接的角色，不绑定某个模型、个人 skill 路径、客户端会话或用户目录。根目录 AGENTS.md 是发现入口，本文是流程约定；本机运行状态位于主工作区被 Git 忽略的 .issue-router/。

## 文件与本机状态

| 位置 | 用途 | Git 管理 |
| --- | --- | --- |
| AGENTS.md | 引导 Agent 发现本文与其他项目规则 | 跟踪 |
| .agents/workflows/issue-router.md | 角色、派单、去重、验证与交接约定 | 跟踪 |
| 主工作区的 .issue-router/state.sqlite3 | 当前队列、owner、版本、并发资源与动作记录 | 忽略 |
| 主工作区的 .issue-router/reports/ | 验证、审查、交接与阻塞证据 | 忽略 |
| 主工作区的 .issue-router/backups/ | SQLite 一致性备份 | 忽略 |

目录整体忽略，覆盖数据库、可能的 journal/WAL 文件、报告与备份。源码在 scripts/issue-router/，入口为 `bun run issue-router`，定向回归为 `bun run check:issue-router`；policy 与 persistence-upgrade 门禁会选中这些回归。

不要在每个 worktree 的当前目录下各自创建数据库，也不要通过工作区复制规则分发数据库副本。每个 issue 的源码工作区独立，任务队列与并发名额共享。

从任意工作区先读取 Git 元数据：

```bash
git rev-parse --path-format=absolute --git-common-dir
git worktree list --porcelain -z
```

CLI 解析 NUL porcelain 并验证共享 Git 目录身份，将唯一状态根目录解析为主工作区的 .issue-router/。不能仅用当前工作区的 --show-toplevel，也不能盲目取共享 Git 目录的父目录。Git 的未配置 core.worktree 的 separate-git-dir 可能把 Git 目录报告成主工作区，此时必须先从真实主工作区执行 init 或 install-exclude；它在共享 Git 目录 info/issue-router.config 中显式登记主路径。其他 linked worktree 随后使用同一定位信息；登记前无法确定主目录的 linked worktree 会停派。路径中的空格、换行和非 ASCII 字符保留。

同一主工作区及其 linked worktrees 上的不同 Agent 必须解析到相同状态根。另一个独立 clone 有自己的 Git 元数据，不能自动视为共享队列；需要明确接入同一协调入口。状态库保存仓库身份和 schema 版本，不保存模型凭证。

## 可执行 CLI 与适配契约

需要 packageManager 指定的 Bun（当前 1.4.3）及 frozen install。可从任意目录调用工具所在 checkout 的绝对脚本路径，同时用 `--cwd` 指定这个仓库的任意工作区。`bun run issue-router COMMAND` 是在已包含本工具的 checkout 内的简写。请求是 `--input FILE` 或 `--input -` 的 JSON 对象；无请求字段的命令可省略 input。标准输出只有一行 `{ "ok": true, "result": ... }` 或 `{ "ok": false, "error": { "code", "message" } }`，失败退出码 1。严格输入 schema 在 [commands.ts](../../scripts/issue-router/commands.ts)；未知字段会报错。

先运行 `locate`，人工核对 primary/commonDir/database。首次初始化是有意创建一个新的管家；缺库恢复时不能运行 init。主工作区尚无 tracked ignore 时，显式运行 `install-exclude`，它保留 common Git info/exclude 原有内容、幂等追加 `/.issue-router/`，不改主工作区源码。init 会再次检查整个目录被忽略。例：

```bash
bun --no-env-file /path/to/checkout/scripts/issue-router/cli.ts locate --cwd /path/to/linked-worktree
bun --no-env-file /path/to/checkout/scripts/issue-router/cli.ts install-exclude --cwd /path/to/primary
bun --no-env-file /path/to/checkout/scripts/issue-router/cli.ts init --cwd /path/to/primary --input - <<'JSON'
{"repository_id":"GITHUB_STABLE_REPOSITORY_ID","repository":"NanmiCoder/cc-haha","required_checks":["pr-quality-gate"]}
JSON
bun --no-env-file /path/to/checkout/scripts/issue-router/cli.ts status --cwd /path/to/linked-worktree
```

init 的 repository_id 来自 GitHub 仓库元数据（NanmiCoder/cc-haha 为 1197569406），不能用易重命名的 slug 替代。该库只服务一个仓库；meta 保存 repository_id、slug、主目录、共享 Git 目录和配置；SQLite user_version 当前为 3。init 遇到已有文件（包括空库/损坏库）报错，不覆盖。独立 clone 不共用本库。

管家先完整读取分页，再一次性提交候选与游标。CLI 不验证外部服务是否真的翻完页；适配器必须保证 complete 是实际完成结果。`cursor_before` 必须等于 status.cursor，`scan_id` 是本轮稳定 ID；相同内容重放幂等，不同内容使用同一 ID 会报错。首轮必须 baseline，记录历史但不自动排队；之后 baseline=false（默认），查询保留重叠窗口，周期性对账全部 open issue。每条 fingerprint 必须覆盖正文、相关评论/补充材料、重开/关闭等有意义变化；updated_at 用真实 GitHub 时间。`is_pr:true` 会被排除。

```bash
bun run issue-router observe --input - <<'JSON'
{"scan_id":"bootstrap-20261028","cursor_before":"","cursor_after":"2026-10-28T03:00:00Z","complete":true,"baseline":true,"candidates":[{"number":1704,"title":"从 GitHub 读取的真实标题","state":"open","fingerprint":"真实材料摘要的哈希","updated_at":"2026-10-28T02:00:00Z"}]}
JSON
bun run issue-router enqueue --input - <<'JSON'
{"number":1704,"modules":["按实际调用边界确定的模块"],"branch":"fix/issue-1704-reproduction"}
JSON
```

上例候选只是输入形状示例，正式 baseline 必须提交已完整读取的所有候选。先选择一个明确小 issue 试跑，其余历史任务留在 baseline。`cover` 输入 number/covered_by/reference，记录有复现证据支持的重复覆盖；相似标题不足以判重。模块名是协调员选定的冲突域；若两个不同模块实际交叉，先选相同冲突域串行，不凭工作区隔离假定兼容。

claim 前适配器按 issue、稳定分支、PR 和历史标记搜索所有相关会话/PR，记录完整结果；discovery.observed_at 取本次真实查询时间，需在 15 分钟内。owner 是本轮协调持有者的稳定不透明 ID。claim 返回 run 和 action；后续所有 run 操作传同一组 `run_id` / `owner` / `generation`（下称 token）。不能把整个返回对象原样作为请求。

```bash
bun run issue-router claim --input - <<'JSON'
{"number":1704,"owner":"router-hostA-20261028","lease_seconds":7200,"discovery":{"source":"当前客户端与 GitHub 适配器","reference":"查询证据路径或 URL","observed_at":"2026-10-28T03:00:00Z","complete":true,"sessions":[],"prs":[]}}
JSON
bun run issue-router dispatch-start --input - <<'JSON'
{"run_id":"返回的 run.run_id","owner":"router-hostA-20261028","generation":1,"action_key":"返回的 action.action_key","sender":"本次外部操作执行者的唯一 ID"}
JSON
```

只有 dispatch-start 成功者才能调用外部建聊工具。把 action.payload.marker 放在会话标题前部和初始任务正文，先创建专属 worktree，再创建真实可查询会话；初始任务必须包含本文的验收、授权和回传约定。若 discovery 已有一个会话，claim 必须同时传 `adopt:{session:{client,host,session_id},worktree}`，session 必须与 discovery.sessions[0] 相同，返回 resume 动作；已有一个 PR 时必须沿用其 number/url/branch（discovery.prs 的字段），多会话/多 PR 冲突停派。PR 尚无会话时可创建负责原 PR 的执行会话，不能再建第二个 PR。

```bash
bun run issue-router bind-session --input - <<'JSON'
{"run_id":"返回的 run.run_id","owner":"router-hostA-20261028","generation":1,"action_key":"原 create action_key","sender":"dispatch-start 的 sender","session":{"client":"实际客户端","host":"实际执行主机","session_id":"真实可查询的不透明 ID"},"worktree":"执行者专属工作区的绝对规范路径"}
JSON
```

临时 clientThreadId/排队创建 ID 不是稳定 session_id；等到实际 ID 才 bind。建聊返回未知或进程崩溃：用 dispatch-unknown（token/action_key/sender/reference）记录，或保留 sending，之后 `reconcile`（token/action_key/reference/outcome）。outcome=found 时 create 必须带真实 session/worktree，merge 必须带 merge_sha；absent/unknown 都保留 unknown，不能重置 pending 再发。外部 exactly-once 无法由 SQLite 保证。resume 成功用 ack（token/action_key/sender/reference）；恢复后确认 resume 已交付用 reconcile found。不要把恢复查询的“未找到”当作不会迟到的证明。

observe 的增量 inbox 不会自动派新执行者。每次有意义的材料变化递增 issue.revision，A→B→A 也是三次不同材料状态。对 active run 调用 consume（token），原子消费 inbox 并生成按当前 revision 去重的 resume 动作，再按 dispatch-start → 原会话续发 → ack 执行。重复 consume 返回同一动作；已发送结果不自动重发。未发送的过时 resume 可取消，sending/unknown 保留且阻止发送下一操作，避免迟到消息反转材料顺序。ack 只能确认当前 revision，旧 ack 不覆盖新交付。初次 bind 后也调用 consume，以便投递建聊期间的新材料。没有 active run 的候选先分析，再显式 enqueue；重复扫描和 CI 失败不产生新 run。progress 输入 token/phase/next_step/reference/lease_seconds，phase 可为 working/review/ci/merge/blocked；这些状态都保留 owner、模块与全局名额。lease 只提示核查，不自动释放。

已 complete/retire 的 issue 重开或收到新材料时，先核对旧执行者已经停止，再显式 reopen：输入 number/owner/previous_generation/old_executor_stopped=true/reference/discovery（与 claim 同形状），可选 adopt（与 claim 同形状）。它保留原 run_id、branch、PR，递增 generation，在同一事务重新抢总名额/模块，并生成 mode=analysis 的 resume 或 create 动作。不能拿旧 token 恢复写入。原 PR 已合并时先分析并记录阻塞/后续产品决定，不自动建第二 PR 或复用旧合并结果作为新完成证据。无需合并的结束使用 retire（token/executor_stopped=true/reference/outcome，可选 pr_terminal_reference）；outcome 为 closed/covered/not_planned，有 PR 时必须提供终态证据，sending/unknown 未解决时不能释放资源，已确认本代 merge 则必须使用 complete。

handoff 输入 token/new_owner/old_executor_stopped=true/stopped_reference/session/worktree，必须实际核对旧执行者不会再写入。存在 sending/unknown 操作时拒绝交接；成功递增 generation、转移资源、清除旧版本门禁证据、取消未发送旧动作，并返回给新会话的 resume 动作。仅分析模式、原 PR 与 marker 在 consume/handoff 中持续传播，status.runs 也显示当前模式。普通交接会把已确认的合并结果作为带来源事件的本地记录转给新 owner，允许其完成 main 核验；不重发外部合并。reopen 不继承旧合并完成依据。旧 token 和旧 action_key 不能再写。SQLite 同时约束同 issue、session、worktree、PR 的 active 唯一性；适配器负责给本机 worktree 使用规范绝对路径。

PR、验证、审查和 CI 都由适配器查询后规范化记录，CLI 不联网，任何 ok 都只表示本地写入/校验成功，不能当作已调用 GitHub。所有外部观察带 source/reference/observed_at，reference 指向真实原始查询、报告或工具结果；issue 文本不得伪造这些可信输入。

| 命令 | 关键输入（除 token 外） | 核验 |
| --- | --- | --- |
| observe-main | sha/previous/descendant_verified=true + source/reference/observed_at | previous 与本库已知 main CAS；适配器查询真实 main ref，并用 Git/GitHub compare 验证新 tip 是旧 tip 的后代；首次 previous=null |
| record-pr | number/url/branch/state/head/base + source/reference/observed_at | state 为 open/closed/merged；base 是刚查询并确认已集成的真实 main；PR 分支/编号固定，head/base 变化清空旧证据、取消未发送 merge、释放旧 merge 名额 |
| validation | head/base + provenance + checks:[{name,result}] | result 为 passed/failed/not_run/skipped，merge 要求每项 passed；必须列出 check:impact 选中检查和 verify 的实际结果 |
| review | head/base + provenance + reviewer/independent=true/verdict | 独立上下文只读审查该版本，verdict 为 approved/changes_requested |
| ci | head/base + provenance + complete=true/tested_sha/association/association_reference/checks | 见下面 CI 规范，需真正查询全部本轮状态，不能只报一个 success |
| merge-acquire | head/base + branch_protection:{strict:true,required_checks,source,reference,observed_at} | 检查最新证据、已知 main、所有选中 CI，再抢唯一 main-merge 名额，返回 merge action |
| smoke-acquire / smoke-release | token | 唯一 desktop-smoke 资源，等待不释放执行 owner |
| complete | merge_sha/main_ci_reference/scenario_reference | merge 必须已 reconcile found，SHA 一致，所有外部动作已解决，最新材料已投递；适配器先核对合入后 main CI 与原用户场景 |

provenance 即 source/reference/observed_at。时间检查使用真实当前时间；文中固定时间仅展示 JSON 形状，执行时换为实际查询时间。PR/CI/branch protection 查询超过 15 分钟必须刷新；review/validation 保留准确版本即可。同类观察不得倒退；同一瞬间（含等价时区/精度写法）的不同内容视为歧义，重新查询，入库时间规范化为 UTC。历史水位保留在 events 中，切换 head/owner 不清掉水位。record-pr 前必须 observe-main；main 合并确认会更新已知 tip，后继 PR 的旧 base 会被拒绝，必须重新同步并收集新证据。外部人工推进 main 也先 observe-main，不能直接沿用缓存。

CI 适配器读全部分页、当前 PR head、真实 main 和最新尝试，展开 checks，每个检查含 name/external_id/tested_sha/selected/status/conclusion，可附 scope_reference。status 为 queued/in_progress/completed；conclusion 为 success/failure/cancelled/skipped/neutral/timed_out/action_required 或 null。相同 name 多次结果必须先按实际 attempt 取最新，歧义拒绝。head CI 的 tested_sha 必须等于 head；PR synthetic merge CI 用 association=merge，适配器核验实际测试提交的 parent/tree 与 head/base 对应，并保存 association_reference。每个检查的 tested_sha 必须一致。complete=true 表示这一版所有 selected/advisory 结果已枚举，不能漏掉红灯的 advisory。配置和当前 branch protection 要求的检查必须在列表里且 selected=true；所有 selected 包括 advisory 必须 completed/success；未选中只允许 completed/skipped 且有 scope_reference。pending/cancelled/缺失/旧 SHA 不算绿。

发送 merge action 前再次查询 head/main/protection/CI，若改变则记录新版本、同步复验。merge-acquire 和 dispatch-start 都检查最新材料已交付、无其它待发/未知外部动作、PR 为 open，再核对版本证据。仅取消且从未发送的 merge 动作可在相同 head/base 恢复后重新变 pending，sending/unknown/sent 绝不这样重发。外部合并必须携 expected_head，服务端 strict required checks 或 merge queue 约束最新 base。当前已核实 main 的 strict=true、context=pr-quality-gate（GitHub Actions app 15368），每次合并仍实时查询。CLI 的本地串行不能锁住人工 GitHub 操作。merge 结果未知用 reconcile，不另派任务；合并成功后 complete 前查询 main CI、验证原场景，写入真实证据引用。

## 备份、迁移与恢复命令

```bash
bun run issue-router backup
bun run issue-router migrate
bun run issue-router restore --input /path/to/restore-request.json
bun run issue-router recovery-confirm --input /path/to/recovery-audit.json
```

backup 使用 SQLite VACUUM INTO 生成一致快照，返回主目录 .issue-router/backups/ 下唯一文件，包括已提交 WAL 数据。migrate 显式把 v1/v2 升级到 v3，先自动备份；版本未知、身份错误或损坏会停派。迁移保留 owner/代次/发送状态，旧动作结果仍需先对账，当前材料在原会话上重新确认一次 revision 交付；不会自动重建会话。两者都不重开任务。恢复请求形状是 `{"backup":"备份绝对路径","clients_stopped":true}`。先停所有客户端、核对数据库与会话/PR，将原 state.sqlite3、-wal、-shm 一起保留到隔离位置；restore 只允许不存在的目标，原子发布已验证快照。不能删除旧库当作重新 init。

恢复后的库有 recovery_required 屏障，只能 status/backup/migrate；核对所有会话、分支、PR、in-flight 操作和资源后，提交 `{"clients_stopped":true,"reference":"完整恢复核对记录"}` 给 recovery-confirm，再逐一 reconcile 已知结果。所有 owner/generation/unknown 状态保留。SQLite 快照之后发生的外部动作必须从原始工具结果/会话标记/PR 补齐，未核实前不能恢复派单。定位登记丢失时从已核实的主目录恢复 common Git metadata；不要从 linked worktree 猜路径。

确定性测试只在临时 Git 仓库/隔离 HOME、mock GitHub/会话输入下运行，不读真实 ~/.claude/providers，不消费 live quota。CLI 和进程争抢测试覆盖真实入口，不涉及桌面 UI；首次真实 issue pilot 是另一个验收层，不能把 mock 通过写成 live 会话/PR 已验收。

## 角色、能力与授权

- 管家读取 GitHub issue、评论、关联 PR 和本机任务状态，负责分类、排队、分配资源、续发任务、核对结果与通知用户，不修改产品代码或代替执行者完成修复。
- 每个非重复、已接单的 issue 有一个执行会话和自己的 worktree。它负责实现、验证、核实审查发现，以及已获授权的 commit、push、PR、CI 和 merge。
- 独立审查 Agent 使用独立上下文，只读审查指定版本，验证写入使用隔离目录，不继续委派。执行者不能把自审称为独立审查。

启用时一次写清楚：监控仓库/分支、扫描周期、旧 issue 范围、可自动实施的需求、创建和续发执行会话的权限，以及 commit/PR/merge 的范围。已获授权的例行步骤不反复确认；发布、仓库设置、绕过门禁、真实模型验证和额度使用不由“处理 issue”自动获得授权。

调度核心只依赖这些能力：读取问题与代码版本、创建/查找/读取/继续执行会话、建立独立 worktree、获取验证证据、查询 PR/CI 与带版本条件的合并。客户端负责适配其会话工具；数据库中的会话引用包含 client、host 和 opaque session_id，不能把某一客户端的 threadId 当作所有 Agent 都能使用的 ID。

换客户端时，新管家先读取共享状态并对账。不能访问原客户端的执行会话时，不把它判定为已停止；先核对原执行者、worktree、分支与 PR，确认不会继续写入后，再交接或替换 owner。新旧 Agent 不能同时拥有同一任务。

## 去重、并发与恢复

建议以 SQLite 为权威状态，至少记录：

- issues：稳定 repository_id 与 issue number、类别、当前状态、材料指纹、已投递指纹、重复覆盖关系。
- runs：run_id、owner 与递增代次、client/host/session 引用、worktree、分支、PR、base/head、审查与 CI 版本、最后活动、阻塞和下一步。
- inbox/outbox：已观察事件、待派单/续单动作、唯一 action_key、发送状态和真实结果。
- resources：两个全局在办名额、模块占用、一个桌面冒烟名额、一个 main 合并名额。
- events/meta：状态历史、证据位置、扫描游标、仓库身份、配置与 schema 版本。

核心约束是同一个 issue 最多一个 active run；历史任务可以保留。建议用唯一部分索引约束 active=1 的 repository_id/issue_number。等待审查、CI 和合并仍保留唯一 owner，不能因为执行会话已结束就重新开任务。

抢占使用短写事务，将 issue 状态、唯一 owner、总名额和模块资源一起检查并落盘；只有抢占成功的动作可以创建会话。事务不能跨网络请求、模型推理或执行者长任务。同模块存在交叉修改时先串行，不能只依赖不同 worktree 隔离源码来推定业务兼容。

扫描按更新时间增量查询，包含新建、重开、补充材料与关闭状态，排除 API 中的 PR，读完分页。候选事件与扫描游标一起提交，再消费队列；失败不推进游标。查询保留重叠窗口，并周期性对账 open issue。首次先建立历史基线，不一次派出所有积压。

派单前检查本地台账、已有会话和关联 PR。材料未变则不重新分析；新材料只续发给原执行者。相似标题只是重复线索，按错误签名、复现、版本和验收确认覆盖关系后，记录 covered_by，不另派实现。已有补丁或 PR 优先评审、验证。

外部操作前先将 pending 动作抢占并提交为 sending；只有成功转换的持有者调用外部工具。创建标记同时写入会话标题前部与初始任务。结果未知时按标记对账，不能盲目重试。临时创建 ID 不能冒充可查询的真实会话 ID。

租约过期只触发核查，不能自动释放 owner 和名额。迟到结果按 owner/代次条件更新，不能覆盖新 owner。若客户端无法按唯一标记确认建聊结果，保留“创建结果未知”，宁可等待也不再开一个。跨外部服务不能仅靠本地 SQLite 宣称严格 exactly-once。

数据库缺失、损坏、身份不符或不可读时停止新派单，使用一致性备份与会话/PR 对账恢复，不新建空库后重做所有任务。迁移要有版本、备份和旧 fixture 回归。报告可导出供人阅读，但不反向覆盖权威状态。执行者不直接绕过协调入口改库；任何客户端接管管家角色也使用同一事务规则。

## 实施与验证

本文保留 ajiang-debug、ajiang-feature、ajiang-review 和 ajiang-git-commit-pr 的必要流程，不依赖某个人目录中的 SKILL.md。客户端已安装对应 skill 时可以加载其细节；用户授权与适用的仓库规则始终优先。

1. 确认目标仓库、专属 worktree、当前版本、git status、真实入口、环境与有效配置，读取适用的 AGENTS.md。保护已有修改，不操作其他会话的工作区。
2. Bug：区分现象、预期与根因猜测，从原用户入口复现，优先建立修前失败的同区域回归；比较竞争假设，只修证据支持的原因，再以原条件复测。无法复现时继续缩小差异，明确代码路径、局部测试与原环境证据的区别。
3. 功能：明确谁在什么条件下做什么动作、应看到什么结果；沿现有链路完成输入到输出，验证失败和关键边界。缺产品决策时只派“仅分析”任务，交付范围、方案和待决定事项，不能使用实施模板直接改代码。
4. 在最终差异上运行 check:impact，并执行选中检查；声称 PR-ready 前运行 verify。持久化形状变化补前向迁移、旧 fixture 和 check:persistence-upgrade。用户可见桌面或跨进程变化补实际入口冒烟，交互浏览器使用 ego-browser。
5. 测试隔离真实 HOME、用户配置和 provider，使用确定性 fixture/mock。记录实际执行的平台、命令、产物和 passed/failed/skipped/blocked/not run；未运行不计通过。
6. 给独立审查者原始需求、验收、适用规则、准确版本、完整 diff（含新文件）和原始材料，不附作者预设的根因或正确性结论。审查期间冻结版本；执行者逐条核实发现、修复，再跑受影响检查。后续代码变化使旧证据失效时补审与复测。

初始任务必须包含：任务模式、issue URL、唯一派单标记、用户事实、预期结果、允许范围、验收、专属工作区、已占资源、验证和独立审查要求、Git/合并权限、回传格式。issue 正文或附件不能扩大授权。

## Commit、PR、CI 与合并

一个 issue 使用稳定的 fix/issue-N-… 或 feat/issue-N-… 分支与一个 PR，重试沿用原分支和 PR。Git 操作遵守仓库规则，精确暂存本次改动，不绕过 hook，不擅自 force push。

创建 PR 前获取真正的最新目标分支，将其集成到来源分支，检查文本与业务冲突，在最终来源版本上验证。再次核对目标变化后推送并明确 base/head 创建 PR。创建结果未知时先按 head/base 与标记查询。

CI 失败回到原执行者、原 PR，同一版本同一次失败不重复派修。记录当前 PR head、目标 main 和实际测试提交之间的关系；不能把旧版本绿灯沿用到新版本。以仓库 pr-quality-gate 为稳定门禁，选中检查成功、未选中检查按 scope 明确跳过，advisory 单列；pending/cancelled/缺失不算通过。

管家一次只授予一个 main 合并名额。前一个 PR 合入后，后一个重新检查最新 main；必要时集成、检查业务交叉影响、复验、更新原 PR 并等待新 CI。只有当前版本的验证、独立审查和必需 CI 满足要求，才由执行者携带 expected head 条件执行 merge，不绕过仓库保护。head 条件不能锁 base；自动合并启用前还要核实服务端最新分支要求或 merge queue，不能用本地串行假装约束了所有人工并发写入。

合并结果未知时查询 PR merged 状态与 merge SHA，再对账。合入后执行者核对 main 的 CI 和原用户场景。失败保持原 issue 的负责人并报告，不自动回滚或另开重复实现。未交接的工作区不清理，完成后按授权由所属会话归档。

## 交接和启用验收

其他 Agent 接手时读取本文、共享状态及必要证据，保留用户结果、实际版本、已验证内容、假设适用条件、剩余问题、权限、下一步和在办 owner。客户端不同不构成重新派单的理由。

正式启用前，用隔离的临时仓库/状态和 mock 会话验证：跨 worktree/不同 client 解析同一状态根、同 issue 并发唯一、总名额约束、候选与游标同步提交、发送中断对账、租约过期不重开、交接不产生双 owner、旧 CI 绿灯被拒绝、PR 串行集成、数据库丢失时停派，以及整个 .issue-router/ 被 Git 忽略。

最后选择一个明确的小 issue 试跑真实执行会话、专属 worktree、验证、独立 review 和已授权的 PR/CI/merge 流程，再启用两小时巡检。定时器只负责唤醒协调流程；即使更换调度器或 Agent 客户端，状态规则仍以此仓库和共享台账为准。
