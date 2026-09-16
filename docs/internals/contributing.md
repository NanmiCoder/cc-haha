---
title: 参与贡献与质量门禁
nav_title: 参与贡献
description: 本地安装、影响面检查、质量门禁、测试要求与 PR 提交流程。
order: 14
---

# 参与贡献与质量门禁

这份文档说明贡献代码前应该如何在本地安装、开发、测试和运行质量门禁。目标是让维护者和贡献者都能在提交 PR 前回答一个问题：这次改动有没有破坏核心 Coding Agent 工作流。

## 环境准备

项目根目录使用 Bun：

```bash
bun install
```

如果改动涉及 `desktop/`，也安装桌面端依赖：

```bash
cd desktop
bun install
```

如果改动涉及 `adapters/`，或者要运行 `check:adapters` / `check:native`，安装 adapter 依赖：

```bash
cd adapters
bun install
```

不要提交本地运行产物，例如 `artifacts/quality-runs/`、`node_modules/`、`desktop/node_modules/`。

## 四层门禁分工

| 层级 | 触发 | 运行内容 | 约束 |
| --- | --- | --- | --- |
| 本地迭代 | 手动 | 最窄的相关测试；`bun run check:impact` 选中的命令 | 秒级反馈 |
| PR（必过） | `pull_request` | impact 选中的确定性 lane，含 `check:agent-flow` | 无模型、无 provider、无 secret、fork 可跑 |
| 全量 | 维护者手动触发（`workflow_dispatch`） | 全部确定性 lane（不做路径选择）+ 模块图健康度 + `check:desktop-ui-smoke` | 仍然无模型、无 secret |
| Release | 维护者手动 `bun run quality:release`（**不是** `release-desktop.yml`） | PR + 全量层全部内容 + native/打包 smoke + 维护者授权的真实 provider baseline | 真实模型只在此层，且需显式授权 |

注意：`release-desktop.yml` 按设计**不跑任何质量门禁**——打 tag 不应被 `bun run verify` 阻塞，`scripts/pr/release-workflow.test.ts` 有守卫测试锁定这一点。因此发版前的质量证据来自「合并进来的那些 PR」+ 维护者手动跑的全量层 + `quality:release`。全量层刻意不设定时：跑不跑、什么时候跑由维护者决定，`pr-quality-workflow.test.ts` 会拦住重新加回 `schedule:` 的改动。

分层原则：**PR 只跑改动能影响到的范围**，因此它天然无法覆盖"没有 PR 碰过的检查"和"只有全套一起跑才暴露的问题"——这两个盲区交给手动触发的全量层；**真实模型/额度只出现在 Release 与维护者手动 smoke**，任何贡献者在没有 provider 的情况下都必须能跑通 PR 层的全部门禁。

## 普通 PR 的影响面检查

先让仓库按变更路径列出需要运行的检查：

```bash
bun run check:impact
```

选择是**依赖感知**的：除了改动文件自身的路径前缀，还会把「谁 import 了这些文件」纳入检查范围（`scripts/pr/module-graph.ts`）。这修掉了纯前缀路由的漏检，例如改 `src/shared/modelReasoning.ts` 会选中 `check:desktop`（`desktop/src/lib/runtimeSelection.ts` 直接 import 它），改 `desktop/src/lib/browserSafePort.ts` 会选中 `check:native`（`desktop/electron/services/sidecarManager.ts` import 它，而 `desktop/tsconfig.json` 并不编译 `desktop/electron/`）。报告的 `## Cross-surface impact` 会指名是哪个 importer 触发了额外检查。

依赖图只**放宽检查选择**，不影响 area 标签和任何 blocking 规则——改一个 hub 文件不会因此要求你为没碰过的文件补测试。图构建失败时会选中全部 surface 并打印告警，不会静默退回前缀路由。

## 无模型的端到端 Agent 门禁

```bash
bun run check:agent-flow       # 真实 server + 真实 WebSocket + mock CLI
bun run check:desktop-ui-smoke # 真实桌面 UI + 真实权限对话框 + mock CLI
```

两条通道都不需要 provider、凭据或公网。`check:agent-flow` 覆盖新建 Session → 选运行时 → 首轮流式 → 工具调用 → 权限批准/拒绝 → 工具失败 → API 错误 → 中断 → 断线重连权限重放 → 会话恢复。`check:desktop-ui-smoke` 在真实浏览器里点真实的 Allow 按钮，需要 `agent-browser` 与已安装的 desktop 依赖，缺失时会打印原因并跳过。

`agent-browser` 只属于这条已提交的 lane（在 Linux CI 上以 headless 方式运行）以及维护者手动执行的 `desktop/scripts/e2e-*-agent-browser.sh`。临时的浏览器操作（手动验证、截图、探索性 UI 检查）请走 `ego-browser` skill，不要因为仓库里出现 `agent-browser` 就把它当通用浏览器工具。

所有会启动真实 server 的 quality-gate lane 都跑在沙箱配置目录里（`scripts/quality-gate/sandbox.ts`），并在结束时校验没有写过开发者真实的 `~/.claude`；写了就判定 lane 失败。

开发时运行 impact report 选中的窄命令即可。需要声明 PR-ready 或完整验证时，直接使用统一入口，无需先单独执行其全部 lane：

```bash
bun run verify
```

`bun run verify` 等价于 `bun run quality:pr`，会按改动范围执行被选中的 policy、desktop、server、adapter、native、provider contract、chat contract、persistence、docs 和 coverage lane。它不调用真实大模型。小范围外部贡献者不需要在本机运行无关模块；GitHub CI 会再次执行精确的 path-aware gate。

主质量报告会内嵌当前测试范围、结果矩阵、覆盖率摘要，并链接完整 coverage/JUnit/log artifact：

```text
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/report.json
artifacts/quality-runs/<timestamp>/junit.xml
artifacts/quality-runs/<timestamp>/logs/*.log
artifacts/coverage/<timestamp>/coverage-report.md
artifacts/coverage/<timestamp>/coverage-report.json
```

PR 描述里请贴出你实际运行的命令和 summary。`quality:pr` / `quality:verify` 仍然保留给习惯显式质量命名的用户，但推荐文档和 AI prompt 都使用 `bun run verify`。

覆盖率门禁同时执行四件事：按源码口径统计覆盖率、执行 baseline ratchet、报告 75-80%+ 的目标差距，并对新增/变更的可执行生产代码行执行 changed-line coverage。当前 baseline 记录在 `scripts/quality-gate/coverage-baseline.json`，CI 会优先对比 base branch 的 baseline，新增 PR 不允许覆盖率下降超过允许窗口。`coverage-baseline.json` 或 `coverage-thresholds.json` 变更必须由维护者加 `allow-coverage-baseline-change` 后才能合并。Quarantine 只用于维护者的 baseline/release 追踪，不得隐藏确定性的 provider/chat 契约测试；当前普通 PR gate 不依赖 quarantine 才能通过。

## AI Coding Agent 修复循环

任务的完成标准是实现目标行为、运行当前 diff 必需的验证，并修复由本次改动造成的失败。任务范围内的本地编辑、隔离 fixture 检查和相关失败修复无需逐步请求批准；提交、推送、发布、仓库设置及真实模型额度仍遵循根 `AGENTS.md` 的授权边界。

`bun run check:impact` 用于确定检查范围；普通任务运行选中的检查，需要 PR-ready/full validation 时直接使用 `bun run verify`，不必先单独重复执行其全部 lane。修复期间先重跑受影响的窄检查，交付时补齐最终 diff 的所需证据。没有后续改动或未解决风险时，不要反复运行已经通过的检查。无关的现有失败或环境阻塞应准确报告，而不是为了让结果变绿擅自扩大修改范围。

需要诊断失败时，按失败类型查阅相应证据：

| 失败类型 | 证据与处理 |
| --- | --- |
| Lane 失败 | `artifacts/quality-runs/<timestamp>/report.md` 的 Summary / Result Matrix，以及 `logs/<lane>.log` |
| Path-aware PR checks | 核对同区域测试、CLI core 和 coverage policy；维护者 override 需要明确决定 |
| Coverage gate | `artifacts/coverage/<timestamp>/coverage-report.md` 或 `.json`；修复 `changedLines.failures` / `failures`，`targetGaps` 是技术债提示 |
| 构建、类型、lint、文档或 native | 修复对应日志指出的本次变更问题，重跑受影响检查 |

只有最终 diff 的 `bun run verify` 报告通过，才能声明 PR-ready/full validation。不要通过降低 coverage baseline/threshold 或改写测试预期掩盖失败。

## 回归测试设计

同区域测试文件是门禁的最低信号，测试还需要证明实际行为：

- **驱动状态迁移。** 需要验证迁移时，通过 `handleServerMessage`、真实 store action 或用户事件产生状态，避免直接 `setState` 写出本应由迁移生成的结果。初始化 fixture 仍可直接设置状态。
- **断言行为不变量。** 断言用户应看到哪个会话或模型的数据，而不是抄下当前屏幕的字符串；测试输入和预期应由预期行为契约支撑，不为掩盖失败而修改。
- **覆盖丢弃与保留两个方向。** 验证去重、合并和过滤规则应丢弃及应保留的情况。消息去重尤其要拦住 replay、保留真实重复；透传上游 `uuid` / `toolUseId` 等身份，避免用文本猜测身份。
- **跨边界测试连接点。** server、store、component 分别通过并不能证明消息真正驱动了 UI；通过真实入口验证有风险的连接，避免 mock 被测模块本身。

覆盖率报告也有边界：`desktop/vitest.config.ts` 只采集 `src/**`，不包含 Electron main process。仓库现有 Bun coverage baseline 中分支总数为 0，`coverage.ts` 把 `0/0` 显示为 100%；这不代表测到了全部分支。查看当前配置和报告，不把历史覆盖率数字当作新改动的证明。

### 覆盖率参考

外部参考口径：

- [Google Testing Blog](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)：60% acceptable、75% commendable、90% exemplary；changed/per-commit coverage 90% 是合理下限。
- [Microsoft Visual Studio / Azure DevOps 文档](https://learn.microsoft.com/en-us/visualstudio/test/using-code-coverage-to-determine-how-much-code-is-being-tested)：团队通常以约 80% 为目标，典型项目要求可为 75%，生成代码可以放宽。
- [ChromiumOS EC](https://chromium.googlesource.com/chromiumos/platform/ec/+/main/docs/code_coverage.md)：新增或变更行要求至少 80% 覆盖。

## 维护 Agent 指导

根 `AGENTS.md` 保留项目约束与入口，专项规则留在对应目录，解释和示例按需放到文档。共享指导应适用于贡献者使用的不同模型；能力升级后重新核对重复流程和宽泛停止条件，不能据此跳过现行安全或 CI 契约。这次整理参考了 Eric Provencher 的 [Rethinking skills and prompts for GPT-6 Astra](https://x.com/pvncher/status/2095991462416490862)（2026-09-04）。

仓库技能的描述只写适用任务和必要的区分信息，操作细节放正文或引用文件。多工作流技能用短入口路由；避免为了覆盖更多关键词而扩大触发范围。模型默认值、工具格式和压缩行为属于产品实现，更新相关文档前应先核对源码。

## Feature Quality Contract

所有新功能、bugfix 和行为变化都必须带着可验证证据交付。这条规则同时约束人和 AI Coding Agent：

- 先声明变更面：`desktop`、`server`、`adapter`、`native`、`docs`、`provider/runtime`、`agent-loop` 或 `release`。
- 可执行 JS/TS 生产代码变更必须同 PR 带同区域测试；`scripts/pr/change-policy.ts` 分别检查 `desktop/src/`、`src/server/`、其余 `src/` 和 `adapters/` 四个区域，除非维护者显式加 `allow-missing-tests`。文案或 CSS 等非可执行文件不因这一规则单独要求新增测试，仍需完成 impact 选中的检查。
- 纯逻辑写单元测试；server/API/provider/runtime 写 API 或 request-shape 测试；桌面 UI/store/API 写 Vitest/Testing Library；跨 UI、WebSocket、provider proxy、native sidecar、发布打包的用户流程要补 E2E 或桌面 UI smoke。
- agent loop、工具调用、provider 路由、模型选择、文件编辑、权限、会话恢复、桌面聊天改动，PR 内必须有 mock/fixture 测试；live smoke 或 baseline 仅在确定性检查通过且维护者明确授权额度后运行。发现本机 provider 不代表获得授权，未运行时如实说明。
- 覆盖率是功能的一部分。本项目按 Google/Microsoft 风格执行：生成物/构建产物不计入产品覆盖率，维护中的产品区域要逐步达到 75-80%+，新增或变更的可执行生产代码行必须满足 `coverage-thresholds.json` 里的 changed-line coverage 门槛。
- 不要为了过门禁随便降低 `coverage-baseline.json` 或 `coverage-thresholds.json`；确实要改时必须有 `allow-coverage-baseline-change` 和原因。历史低覆盖区域是技术债，新 PR 至少要让触达区域更好。
- PR 描述必须写清楚：改了哪些文件、补了哪些测试、coverage 报告路径、E2E/live 报告路径或 blocker、剩余风险。

## 本机 Push 前提醒

push 不再自动运行本地质量门禁。需要质量检查时，请手动运行：

```bash
bun run quality:push
```

`bun run quality:push` 复用 PR gate 的 impact/policy/路径检查，但默认跳过耗时的 coverage lane；完整覆盖率仍保留在 `bun run verify`、`bun run quality:pr` 和 CI。

仍然可以安装本机 pre-push hook，但它只打印非阻塞提醒，不会卡住 `git push`：

```bash
bun run hooks:install
```

拥有可信仓库环境和模型额度的维护者可以手动运行真实 provider smoke 和桌面 agent-browser smoke：

```bash
bun run quality:providers
bun run quality:smoke -- --provider-model minimax:main:minimax-main
```

需要完整 live baseline 时使用：

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

## PR CI 合并门禁

`.github/workflows/pr-quality.yml` 会在 PR `opened`、`synchronize`、`reopened`、`ready_for_review`、`labeled`、`unlabeled` 时触发。`scope-plan` 不安装依赖，只负责稳定地产生影响面计划；`policy-enforcement` 独立安装锁定依赖并执行 policy，因此 policy 失败也不会吞掉产品测试结果。产品 job 只依赖 `scope-plan`，按路径选择 desktop、server、adapter、native、provider contract、chat contract、persistence、docs 和 coverage lane。最后的 `pr-quality-gate` 会严格核对每个 job：选中的必须 success，未选中的必须 skipped，cancelled 或缺失结果都不能误判为通过。

仓库侧应在 GitHub branch protection / ruleset 中保护 `main`，并把 `pr-quality-gate` 设为 required status check。CODEOWNERS 要求维护者审查 workflow、quality policy 以及 provider/WebSocket 等高风险边界；本机 hook 只做提醒，真正阻止低质量 merge 的是 PR gate。

## 按改动范围补充测试

根据你改动的区域补充运行：

```bash
bun run check:server      # 服务端 API、WebSocket、provider、会话等测试
bun run check:desktop     # 桌面端 lint、Vitest、生产构建
bun run check:adapters    # IM adapter 测试
bun run check:native      # 桌面 sidecar、Electron host 与 package-smoke 检查
bun run check:provider-contract # Provider/runtime/proxy 的离线契约测试
bun run check:chat-contract     # WebSocket、会话与桌面 chat store 契约测试
bun run check:persistence-upgrade # 持久化迁移和旧 fixture 兼容性
bun run check:docs        # 独立安装、构建并检查 site/ React 文档站
bun run check:quarantine  # 维护者 baseline/release quarantine 审计
bun run check:coverage    # root、desktop、adapters 覆盖率报告和 ratchet 门禁
```

如果只改了很窄的文件，先跑对应的定向测试即可；只有在声明 PR-ready/full validation 时才需要本地再跑 `bun run verify`，托管 CI 仍会执行所有被选中的必需 lane。

可执行 JS/TS 生产代码改动必须带对应测试文件；同区域划分见上文 Feature Quality Contract 和 `scripts/pr/change-policy.ts`，缺失时会触发阻断。只有维护者确认不适合自动化测试时，才能使用 `allow-missing-tests`。覆盖率 baseline/threshold 变更同样需要维护者确认并加 `allow-coverage-baseline-change`。

## 真实模型 Baseline

`quality:baseline` 用来跑真实 Coding Agent 任务：启动本地服务端、创建隔离 fixture、让模型通过聊天修代码、跑测试，并保存 transcript、diff、verification log 和报告。它还会对 provider 进行 live smoke：已保存或当前激活的 OpenAI-compatible provider 会验证连通性、proxy 转换和流式 proxy 结果；env-only provider smoke 只验证上游连通性和转换管线。

默认命令不会调用真实模型：

```bash
bun run quality:baseline
```

要真正跑模型，必须显式加 `--allow-live` 并选择本机 provider。

先列出本机可用 provider 和可复制参数：

```bash
bun run quality:providers
```

输出示例：

```text
Saved providers:
  MiniMax
    selector: minimax
    main: MiniMax-M2.7-highspeed
      --provider-model minimax:main:minimax-main
```

复制输出里的参数运行 baseline：

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

如果只需要跑 provider smoke 和桌面 agent-browser smoke，而不跑全部 baseline case，可以使用：

```bash
bun run quality:smoke --provider-model minimax:main:minimax-main
```

可以一次跑多个模型：

```bash
bun run quality:gate --mode baseline --allow-live \
  --provider-model codingplan:main:codingplan-main \
  --provider-model minimax:main:minimax-main
```

`provider` selector 来自桌面端「设置 → 服务商」里保存的本机配置。别人 clone 代码后不需要知道你的 provider UUID，也不需要使用你的供应商；他们可以在自己的桌面端添加 provider 后运行 `bun run quality:providers` 选择自己的模型。

如果没有保存 provider，也可以用环境变量跑一条 unsaved provider smoke：

```bash
QUALITY_GATE_PROVIDER_BASE_URL=https://example.com \
QUALITY_GATE_PROVIDER_API_KEY=... \
QUALITY_GATE_PROVIDER_MODEL=model-id \
QUALITY_GATE_PROVIDER_API_FORMAT=openai_chat \
bun run quality:gate --mode baseline --allow-live
```

## 什么时候必须跑 Baseline

以下改动在确定性 contract/E2E 通过后，建议由可信维护者补跑 live baseline：

- 桌面聊天、会话恢复、WebSocket、CLI bridge
- provider/model/runtime 选择
- 权限、工具调用、文件编辑、任务执行
- agent-browser smoke、Computer Use、Skills、MCP
- release 前或风险较大的跨模块重构

来自 fork 的外部 PR 不会获得仓库 secrets，也不要求贡献者自费调用模型。请在 PR 里写明 `live model: not run (untrusted fork / no provider)`；高风险变更由维护者在合并或发版前补跑 live baseline。没有 live 证据不应让确定性 PR lane 产生随机失败。

## Release 门禁

发版前使用 release 模式：

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

release 模式会组合 PR checks、baseline catalog、live baseline、native checks，并用当前平台 canonical release artifact 跑 `package-smoke --package-kind release`。发版报告同样写入 `artifacts/quality-runs/<timestamp>/`。`release-desktop.yml` 只负责构建与发布，不运行 `bun run verify`；发版前质量证据来自 PR 门禁及维护者显式运行的全量检查和 release gate。

release 模式下 live lane 不允许静默跳过。缺少 provider、真实模型额度或外部账号时，门禁会失败，并要求在发版记录里明确 blocker。

## 发版与自动更新

桌面端版本号的唯一来源是 `desktop/package.json`。正式发布要求版本号、Git tag 和 `release-notes/vX.Y.Z.md` 三者严格一致。

应用内更新由 `electron-updater` 驱动，产物托管在 GitHub Releases：

| 平台 | 安装/更新目标 | Metadata |
|---|---|---|
| macOS arm64 / x64 | `dmg` 首次安装，`zip` 供 Squirrel.Mac 更新 | `latest-mac.yml` |
| Windows x64 / ARM64 | NSIS `.exe` | `latest.yml` |
| Linux x64 | `.AppImage` 自动更新，`.deb` 供手动安装 | `latest-linux.yml` |
| Linux arm64 | `.AppImage` 自动更新，`.deb` 供手动安装 | `latest-linux-arm64.yml` |

Release workflow 先在各平台 matrix 里生成 `latest*.yml`，把同名 metadata 临时改名为 `latest-<platform>.yml`，最后由 `scripts/release-update-metadata.ts` 合并回 electron-updater 期望的标准文件名。不要改成各 matrix job 直接发布 GitHub Release，否则 metadata 会互相覆盖。

### 签名 Secrets

macOS 的签名与公证依赖以下 GitHub Actions repository secrets：

```text
MACOS_CERTIFICATE
MACOS_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

`MACOS_CERTIFICATE` 是 Developer ID Application `.p12` 的 base64 内容。项目不发布 `.pkg`，不需要 Developer ID Installer 证书。

Windows 签名是可选项：

```text
WINDOWS_CERTIFICATE
WINDOWS_CERTIFICATE_PASSWORD
```

缺少 Windows 签名时自动更新仍然可用，只是用户可能看到 SmartScreen 提示。

### 发版前检查

```bash
bun run scripts/release.ts <version> --dry
bun test scripts/pr/release-workflow.test.ts scripts/release-update-metadata.test.ts scripts/quality-gate/package-smoke/index.test.ts
bun run check:policy
```

正式执行 `bun run scripts/release.ts <version>` 前，先确认对应的 `release-notes/v<version>.md` 已经存在。

### 验证一条真实更新链路

每次发版至少验证一次从上一个正式版升上来的完整路径：

1. 安装 GitHub Release 里的上一个正式版。
2. 推 tag，让 `Release Desktop` workflow 完整通过。
3. 打开旧版本，等待启动后的自动检查，或在设置里手动检查更新。
4. 确认提示新版本，下载完成后安装并重启。
5. 重启后确认「关于」里的版本号正确，且服务商、会话、Skills、Agents、记忆、自定义宠物和自定义数据目录仍然可用。
6. 确认历史附件上下文、子 Agent 详情和任务状态可以恢复；打开桌宠，验证悬浮窗口与当前会话导航。

各平台的重点不同：macOS 要确认 release job 走的是签名产物且启动策略检查通过；Windows 要确认 `latest.yml`、`.exe`、`.exe.blockmap` 都在 Release 资产里，未签名时的 SmartScreen 提示不代表 updater 失败；Linux 优先用 AppImage 验证自动更新，`.deb` 只作手动安装包发布。

## PR 提交流程

1. 新建普通产品分支，例如 `fix/session-reconnect` 或 `feat/provider-quality-gate`。
2. 安装依赖并完成改动。
3. 为行为变化补测试。
4. 运行相关定向测试。
5. 可选：运行 `bun run hooks:install`，让后续 push 显示非阻塞提醒。
6. 如果要声明 PR-ready/full validation，运行 `bun run verify`。
7. 高风险改动由可信维护者运行 live baseline；外部贡献者记录未运行原因即可。
8. 在 PR 描述里写清楚用户影响、测试命令、覆盖率/质量报告 summary、已知风险。

## 常见问题

### 没有 provider 可以跑吗？

可以。运行影响面检查和它选中的确定性命令：

```bash
bun run check:impact
```

`bun run verify` 也不需要真实模型；只有 live baseline 需要。维护者可以先在桌面端 设置 → 服务商 添加自己的 provider，再运行：

```bash
bun run quality:providers
```

### provider selector 冲突怎么办？

如果两个 provider 名称生成了相同 selector，`quality:providers` 会退回输出 provider ID。直接复制它给出的 `--provider-model ...` 即可。

### 模型 ID 里带冒号怎么办？

优先使用角色选择，例如：

```bash
--provider-model custom:haiku:custom-haiku
```

脚本会把 `haiku` 解析成本机 provider 配置里的真实模型 ID。
