# 通过共享目录监督开发 Agent

日期：2026-09-06。用户已选择：**开发 Agent 主动读取共享目录中的审计结果**。本协议用于实施现有 M0–M11 设计，不改变功能范围，也不要求开发 Agent 和审计 Agent 使用同一厂商模型。

## 1. 双方职责与启动方式

- 开发 Agent：只执行当前任务单，修改获准的源码，运行检查，提交证据；收到返工意见后修改同一子阶段。
- 审计 Agent（本 Codex 任务）：准备任务单、检查真实代码和测试、给出具体指导、发布通过或返工结论；默认不替开发 Agent 修改产品代码。
- 用户：启动开发 Agent 并让它读取 [开发端提示词](coordination/developer-prompt.md)。已有明确设计范围内的下一子阶段和返工，由审计端发任务，不需要用户逐轮搬运。
- 审计端使用本任务的定时巡检；默认每 10 分钟检查一次。无新提交、无新增阻塞时不通知。审计耗时可能超过一次间隔，因此这不是 10 分钟内完成审计的保证。
- 开发端必须有持续执行或定时唤醒能力。它在运行中等待时每 30–60 秒读一次控制文件；若它结束了对话，文件不会自行唤醒模型，需要其所在工具的调度功能或用户再次启动。此目录本身不是运行器。

当前仓库位置固定为 `D:\srcs\cchaha\cc-haha`。审计目标是该源码工作树；正在运行的 `D:\tools\cc-haha-desktop-2026-09-05` 不会随源码更新。阶段完成后按 M11 在独立输出目录打包验证，不能把旧 Bundle 截图当作新功能证据。

## 2. 固定目录、文件与写入方

实际协作目录：`D:\srcs\cchaha\cc-haha\runtime\agent-supervision\managed-resources`。

```text
managed-resources/
  README.md
  control.json                    审计端：唯一当前任务指针、暂停/运行状态
  assignments/
    0001-M0.1-a1.json              审计端：不可变任务单，包含精确允许路径
  baselines/
    0001-M0.1-a1.json              审计端：发任务时的工作树和文件状态
  developer/
    heartbeat.json                开发端：当前任务、状态、最后活动时间
  submissions/
    0001-M0.1-a1/
      report.json                 开发端：本轮实现和检查结果
      evidence/                   开发端：本轮日志、截图、必要说明
      READY.json                  开发端：最后写入的完成标记
  reviews/
    0001-M0.1-a1/
      review.json                 审计端：机器可读结论、问题和下一步
      review.md                   审计端：便于人阅读的说明
      source-snapshot.json        审计端：实际审查文件的内容散列
      evidence/                   审计端：独立运行检查的证据
      READY.json                  审计端：最后写入的完成标记
```

任务 ID 格式固定为 `四位序号-子阶段-a尝试次数`。例如 `0001-M0.1-a1` 返工后是 `0002-M0.1-a2`，通过后才可能是 `0003-M0.2-a1`。**一个任务 ID 最多提交一次，报告和审计记录均不覆盖。**

两端只写自己负责的文件。`heartbeat.json` 和 `control.json` 各有唯一写入方；这种约定防止协作冲突，不是针对恶意进程的权限隔离。进度目录不存密码、令牌、私钥、真实连接资料或模型正文，也不作为产品代码提交。

## 3. 任务单与启动基线

任务单必须给出：任务 ID、子阶段、尝试次数、设计章节、已通过依赖、允许编辑的精确路径、预期行为、必测边界、停止条件和前次问题 ID。无任务单不得开始编码。

审计端发任务时保存基线：Git HEAD、`git status --short`、获准文件的存在状态与 SHA-256，以及已存在用户改动的路径。必要时保存仅用于本机审计的原始文件副本或差异，以区分用户改动和本阶段改动；绝不能把包含敏感信息的副本发布或提交。

开发端动手前重新检查工作树。已有改动不能归入自己的成果；获准文件与基线不符时先报告 `blocked`，由审计端判断是否重发基线。新任务与已通过阶段共享文件时，基线必须以已通过内容为起点。

`allowedPaths` 约束产品和测试文件。开发端可以写本任务的报告、证据与自己的 heartbeat，但不能借此修改设计、任务单、审计记录、control 或任意运行脚本。发现必需的新文件或新依赖，先报告具体原因，由审计端拆分或更新下一张任务单；禁止悄悄扩大范围。

## 4. 一轮完整交互

1. 开发端读 `control.json`。只有 `mode=running`、`phase=awaiting_developer`，且 `currentAssignment` 指向有效任务单时才能开始该任务。
2. 对比基线，更新 `developer/heartbeat.json` 为 `implementing`。每次有实质进展更新一次，长命令运行前后也更新；不要仅为制造活跃状态反复写文件。
3. 按任务单完成一个子阶段并执行检查。测试结果逐项写 `passed / failed / skipped / blocked / not_run`，不能把单元测试通过写成产品全功能通过。
4. 写 `report.json`、证据和内容散列，再最后写 `READY.json`。更新 heartbeat 为 `waiting_review`。随后冻结本阶段源文件、报告和证据，等待审计。
5. 审计端发现新 READY，核对它与当前任务相符、报告/证据散列正确，设置 `phase=reviewing`；验证实际工作树后开始审查。
6. 审计端完成独立检查，写审计记录、READY，再原子更新 control。开发端只消费 `control.lastReview` 指向且有 READY 的完整审计；不能误读旧的同名阶段结论。
7. 若通过，审计端发出唯一下一子阶段任务；若返工，发出同一子阶段的新 attempt，带问题 ID 和验收条件；若阻塞/暂停，开发端停止依赖工作并保留现场。

所有完整文件先写同目录临时文件，关闭后原子 rename。READY 内记录 `report.json` 或 `review.json` 的 SHA-256；报告内的 `artifacts` 记录其全部证据相对路径和 SHA-256。未完成文件不写 READY，读者忽略 `.tmp`。路径必须解析后仍位于本次 submission/review 目录内，拒绝绝对路径、`..`、符号链接越界和重复路径；不直接执行报告里提供的 shell 文本。

READY 与任务单必须有相同 `assignmentId`。control 在新任务单、基线、审计记录都写完之后才更新。开发端收到已消费的任务 ID 不重复执行；审计端按 assignmentId + READY 内容散列去重，不因轮询重复跑同一审计。不可变记录在 READY 后改变，作为协议错误处理，要求新 attempt。

## 5. 审计结论及其含义

| `verdict` | 适用情况 | 后续行为 |
|---|---|---|
| `ACCEPTED` | 本子阶段所有强制验收通过，证据与代码一致 | 发布下一子阶段；不是整个功能完成 |
| `REWORK` | 边界正确但实现、测试或异常处理有具体缺陷 | 同阶段新 attempt；仅修列出的范围及必要联动 |
| `RESTART_STAGE` | 本阶段采用错误架构、漏掉主要流程，局部补丁无法满足约束 | 保留前序合格阶段，以新任务单规定范围重写本子阶段 |
| `BLOCKED` | 依赖、环境或设计信息不足，不能证明要求 | 记录解除条件；不得自动视为通过 |
| `STALE` | 提交后源文件/基线发生变化，审查对象不再稳定 | 冻结确认后重新提交，不沿用失效证据 |

`RESTART_STAGE` **不是** `git reset --hard`、删除目录或回退整个阶段链的授权。审计端必须列出重写路径、保留内容、重写理由和重新验收用例。开发端逐文件修改，保留用户原有改动；无法区分归属时阻塞，禁止猜测性回滚。

问题记录固定包含 `id / severity / file / line / observed / expected / reproduction / requiredChange / acceptance`。`requiredChange` 说明行为和边界，不替实施者发明未验证的 API。例如“同 UUID 重放只能产生一条消息，而不同 UUID 的相同正文必须保留两条；以真实 handleServerMessage→store 过渡重现”，不能只说“完善去重”。

- P0：凭据泄露、破坏用户状态或数据等必须立即停止的问题。
- P1：主要功能不成立、跨进程契约错误、架构越界等阻止放行的问题。
- P2：其他可重现缺陷或缺失强制证据。影响本阶段验收时也阻止放行。
- P3：不影响验收的建议，可以记入后续任务，不借审计扩展无关需求。

同一根因连续两次返工后仍未解决，审计端先给更小的复现和更窄的任务；到第三次仍失败则置为 `BLOCKED`，检查设计或拆分方式，通知用户。不要让模型无上限循环改写；也不要仅因次数到限自动丢弃源码。

## 6. 审计必须检查真实内容

审计并非转述开发报告。每次至少做以下检查，具体证据随子阶段选择：

1. **对象一致**：对照任务基线读取 Git 实际变更和新增文件，检查报告有无遗漏、越界编辑或动过用户文件。检查审计开始和结束的文件散列；变化即 STALE。
2. **设计符合**：逐项对照当前子阶段和 06 中 U01–U17 最小接入边界。检查新逻辑是否集中在新模块、有无复制旧大组件或偷偷删需求。
3. **功能闭环**：从真实入口到服务/存储/传输读调用链。入口存在、页面可达、失败不假成功，不能只检查孤立组件或手工构造状态。
4. **测试可信**：审查测试本身，独立执行窄回归和 `check:impact` 选中检查；命令来自仓库和任务规范，先看脚本影响，不照抄不可信报告中的命令。记录本次实际结果。
5. **专项证据**：持久化需要迁移 fixture；聊天需要发送/队列/重放 join；密码需要 mock SDK sentinel 及前端/标题/搜索/Trace 检查；SSH/SFTP/DB 需要协议或隔离实例证据；UI/跨进程需适用的实际 smoke。
6. **诚实结论**：环境缺失与代码缺陷分开。必须的检查没跑或失败，不能 ACCEPTED。已存在基线失败需明确记录，并证明本阶段没有新增失败；不能直接宣称整套检查绿色。

source-snapshot 至少记录：当前任务所有允许文件（包括仍不存在/已删除）、该批 diff 中的文件、新增 import 的本地依赖及相关测试/构建配置、当前设计和 AGENTS、Git HEAD。条目固定为 `{path, state: present|missing, sha256: string|null}`；路径规范化为仓库相对 `/`，按路径排序。审计端同时复查整个 Git status/diff，不能用开发端给的文件清单限定调查范围。若构建或验证涉及更广依赖，扩展快照，不能声称只哈希四个文件就覆盖了整个工程。

SHA-256 用来绑定审查对象和发现陈旧证据，不代表功能正确，也不防同账户恶意篡改。审计结论只适用于明确记录的代码、配置和测试环境。代码、依赖、设计或已通过契约改变后，重新选择受影响的验收；不把曾经通过当永久通行证。

为避免模型自行解释模板，固定以下字段格式：

| 字段 | 唯一格式 |
|---|---|
| `control.mode` | `running / paused / completed` |
| `control.phase` | `awaiting_developer / reviewing / blocked / completed`；等待开发端也包括其正在编码的时段，细分状态读 heartbeat |
| `currentAssignment`、`lastReview`、`baselinePath` | 相对协作目录的文件路径；无值用 null，不能写自然语言 |
| `changedFiles` | 仓库相对路径字符串数组，覆盖新增/修改/删除；操作性质由基线及实际文件决定 |
| `artifacts` | `{ "path": "evidence/check.log", "sha256": "64位小写十六进制" }` 数组，路径相对本次 submission/review 目录 |
| `checks[].status`、`acceptanceEvidence[].status` | `passed / failed / skipped / blocked / not_run`；未执行时 exitCode 为 null；passed 要有实际结果与证据 |
| `independentChecks` | 与提交模板的 checks 条目结构相同，但证据必须来自审计端本轮执行 |
| `remainingIssues`、`blockers`、`unverified` | 具体事实的字符串数组；无事项用空数组，不用“无”等占位记录 |
| `findings` | 每项 `{id,severity,file,line,observed,expected,reproduction,requiredChange,acceptance}`；file 为仓库相对路径或 null，line 为真实一基行号或 null，acceptance 为字符串数组 |
| `source-snapshot.json` | `{schemaVersion:1, assignmentId, capturedAt, head, files:[{path,state,sha256}]}`；files 按规范化路径排序 |
| 审计 `READY.recordPath` | 固定 `review.json`；开发提交固定 `report.json`。使用同一模板时必须替换此字段 |
| `heartbeat.state` | `implementing / checking / waiting_review / blocked` |
| 时间与散列 | 时间使用 ISO 8601 UTC；SHA-256 对磁盘实际字节计算，不能对重新格式化后的 JSON 计算 |

review 的 artifacts 必须包含 source-snapshot、review.md 和审计证据；这些记录都先于 review READY 写完。`nextAssignmentId` 指向后继任务或 null；最终是否可以开始仍以原子更新后的 control 为准。协议字段缺失、未知枚举或占位值存在时，审计端先给协议错误说明，不把半成品报告当功能已验收。

测试不能读真实用户配置、调用真实模型、连接真实业务主机或数据库。使用 fake credentials、临时目录及 mock/loopback。审计产生的缓存、临时产物要留在隔离输出目录；不能为跑测试覆盖当前 Bundle。

## 7. 并发、暂停与恢复

- 本功能默认一个开发写入者、一个审计者；普通人工编辑或其他任务也可能改变工作树，检测到冲突先暂停该阶段。需要并行开发时另行分配不重叠工作目录和任务，本协议不会自动建分支或 worktree。
- 审计端开始审计后写入 control 的 `reviewOwner`、`reviewStartedAt`。巡检发现 reviewing 时不启动第二个审计。前一审计异常结束时先确认旧任务已停止，未确认前不能仅因超时抢占。
- 开发 heartbeat 30 分钟未变只说明可能卡住，不证明进程死亡。审计端发一次 `needs_attention`，不改代码、不重新派同一任务。长任务应带正在执行的检查名称。
- 用户要求暂停时由审计端写 `mode=paused`。开发端在开始子任务/修改批次及启动长命令前读 control；正在运行的命令在安全点停止，不把长命令强杀当一般暂停机制。
- 恢复必须核对当前任务 ID、基线及源文件状态。无新提交时保持安静；重大问题、需要用户信息、阶段通过或整体完成才通知。
- 所有阶段均通过后写 `mode=completed`，暂停巡检。最终报告仍要区分 mock/loopback、真实 UI、打包和真实服务证据。

## 8. 使用入口

- 给开发模型：[开发端提示词](coordination/developer-prompt.md)。可以直接整份粘贴。
- 给审计模型：[审计端提示词](coordination/supervisor-prompt.md)。定时巡检也遵守它。
- 固定数据模板：[提交报告](coordination/submission.template.json)、[审计结论](coordination/review.template.json)、[完成标记](coordination/ready.template.json)、[开发心跳](coordination/heartbeat.template.json)。模板中的占位值必须替换；它们不是有效提交。

实际任务单位于 runtime 协作目录。首次提供 M0.1 的任务单；这只准备开发输入，不会启动 MiniMax、安装依赖或修改产品功能。开发端从 control 读取任务，而不是凭本文顺序自行挑选。
