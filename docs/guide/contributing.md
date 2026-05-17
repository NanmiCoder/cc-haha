# 贡献指南与本地质量门禁

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

## 普通 PR 必跑门禁

普通贡献者和 AI Coding Agent 在提交 PR 前统一运行：

```bash
bun run verify
```

`bun run verify` 是一键入口，等价于 `bun run quality:pr`。这个门禁不调用真实大模型，适合所有人本地运行。它会先生成 impact report，再按改动范围真实执行被选中的本地门禁：policy、desktop、server、adapters、native、docs、quarantine 和覆盖率。命令失败就说明当前分支还不能提交 PR 或 push。

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

覆盖率门禁同时执行四件事：按源码口径统计覆盖率、执行 baseline ratchet、报告 75-80%+ 的目标差距，并对新增/变更的可执行生产代码行执行 changed-line coverage。当前 baseline 记录在 `scripts/quality-gate/coverage-baseline.json`，CI 会优先对比 base branch 的 baseline，新增 PR 不允许覆盖率下降超过允许窗口。`coverage-baseline.json` 或 `coverage-thresholds.json` 变更必须由维护者加 `allow-coverage-baseline-change` 后才能合并。Quarantine 条目必须有 owner、reviewAfter 和 exitCriteria；reviewAfter 过期后默认 server/coverage gate 会阻断，直到维护者处理。

## AI Coding Agent 修复循环

给 AI 写代码时，可以直接把这段作为验收指令：

```text
Run `bun run verify`. If it fails, read the latest
`artifacts/quality-runs/<timestamp>/report.md` and the relevant lane log,
fix the missing tests, coverage failures, type/lint/build errors, or docs/native
failures, then rerun `bun run verify` until it passes. Do not lower coverage
baselines or thresholds unless a maintainer explicitly requested it.
```

Agent 应按这个顺序处理失败：

1. 先看 `artifacts/quality-runs/<timestamp>/report.md` 的 Summary 和 Result Matrix，定位失败 lane。
2. 如果是 `Path-aware PR checks` 失败，优先看是否缺同区域测试、是否动了 CLI core、是否动了 coverage policy；不要用 override 绕过普通功能 PR。
3. 如果是 `Coverage gate` 失败，打开 `artifacts/coverage/<timestamp>/coverage-report.md` 或 `coverage-report.json`，优先修 `changedLines.failures` 和 `failures`；`targetGaps` 是技术债提示，新改动应让触达区域变好。
4. 如果是 desktop/server/adapters/native/docs 失败，读对应 `artifacts/quality-runs/<timestamp>/logs/<lane>.log`，补测试或修构建，再跑相关窄命令。
5. 窄命令通过后，最后必须再跑一次 `bun run verify`。只有最终 Summary 是 `failed=0`，才可以说 ready。

外部参考口径：

- [Google Testing Blog](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)：60% acceptable、75% commendable、90% exemplary；changed/per-commit coverage 90% 是合理下限。
- [Microsoft Visual Studio / Azure DevOps 文档](https://learn.microsoft.com/en-us/visualstudio/test/using-code-coverage-to-determine-how-much-code-is-being-tested)：团队通常以约 80% 为目标，典型项目要求可为 75%，生成代码可以放宽。
- [ChromiumOS EC](https://chromium.googlesource.com/chromiumos/platform/ec/+/main/docs/code_coverage.md)：新增或变更行要求至少 80% 覆盖。

## Feature Quality Contract

所有新功能、bugfix 和行为变化都必须带着可验证证据交付。这条规则同时约束人和 AI Coding Agent：

- 先声明变更面：`desktop`、`server`、`adapter`、`native`、`docs`、`provider/runtime`、`agent-loop` 或 `release`。
- `desktop/src`、`src/server`、`src/tools`、`src/utils`、`adapters` 下的生产代码变更必须同 PR 带同区域测试；除非维护者显式加 `allow-missing-tests`。
- 纯逻辑写单元测试；server/API/provider/runtime 写 API 或 request-shape 测试；桌面 UI/store/API 写 Vitest/Testing Library；跨 UI、WebSocket、provider proxy、native sidecar、发布打包的用户流程要补 E2E 或 agent-browser smoke。
- agent loop、工具调用、provider 路由、模型选择、文件编辑、权限、会话恢复、桌面聊天改动，PR 内必须有 mock/fixture 测试；有 provider 条件时还要给 live smoke 或 baseline 证据。
- 覆盖率是功能的一部分。本项目按 Google/Microsoft 风格执行：生成物/构建产物不计入产品覆盖率，维护中的产品区域要逐步达到 75-80%+，新增或变更的可执行生产代码行必须满足 `coverage-thresholds.json` 里的 changed-line coverage 门槛。
- 不要为了过门禁随便降低 `coverage-baseline.json` 或 `coverage-thresholds.json`；确实要改时必须有 `allow-coverage-baseline-change` 和原因。历史低覆盖区域是技术债，新 PR 至少要让触达区域更好。
- PR 描述必须写清楚：改了哪些文件、补了哪些测试、coverage 报告路径、E2E/live 报告路径或 blocker、剩余风险。

## 本机 Push 前门禁

Git hook 不能提交到远端自动生效，所以每个 clone 需要安装一次：

```bash
bun run hooks:install
```

安装后，每次 `git push` 都会先运行快速本地门禁（内部是 `bun run quality:push`）。它复用 PR gate 的 impact/policy/路径检查，但默认跳过耗时的 coverage lane；完整覆盖率仍保留在 `bun run verify`、`bun run quality:pr` 和 CI。如果单元测试、文档/native/adapter 等按路径选中的快速门禁失败，push 会被本机 hook 阻断。

维护者或有模型额度的贡献者可以把真实 provider smoke 和桌面 agent-browser smoke 也纳入 push 前门禁：

```bash
bun run quality:providers
bun run hooks:install -- --live-provider-model minimax:main:minimax-main
```

需要每次 push 前跑完整 live baseline 时使用：

```bash
bun run hooks:install -- --live-provider-model minimax:main:minimax-main --live-mode baseline
```

这些选项写入本机 `.git/config` 的 `quality.prePush*` 配置，不会提交 provider selector 或密钥。`smoke` 模式覆盖真实 provider 连通性和桌面 UI 聊天 smoke；`baseline` 模式会额外跑全部真实 Coding Agent baseline case。

维护者级 override 也必须显式写入本机配置，hook 才会传给 `quality:push`：

```bash
bun run hooks:install -- --allow-cli-core-change --allow-coverage-baseline-change
```

这只影响当前 clone，不会提交到仓库；PR 侧仍然需要对应 label。

## PR CI 合并门禁

`.github/workflows/pr-quality.yml` 会在 PR `opened`、`synchronize`、`reopened`、`ready_for_review`、`labeled`、`unlabeled` 时触发。流程先运行 `change-policy`，根据变更文件决定是否需要 desktop、server、adapter、native、docs 和 coverage lane。最后的 `pr-quality-gate` 会汇总所有被选中的 job：选中 job 失败则 `pr-quality-gate` 失败，未选中的 job 可以是 skipped。

仓库侧应在 GitHub branch protection / ruleset 中保护 `main`，并把 `pr-quality-gate` 设为 required status check。这样本机 hook 防止低质量 push，PR 侧防止低质量 merge。

## 按改动范围补充测试

根据你改动的区域补充运行：

```bash
bun run check:server      # 服务端 API、WebSocket、provider、会话等测试
bun run check:desktop     # 桌面端 lint、Vitest、生产构建
bun run check:adapters    # IM adapter 测试
bun run check:native      # 桌面 sidecar 与 Tauri native 检查
bun run check:docs        # 文档构建，使用 npm ci + docs:build
bun run check:quarantine  # quarantine owner、退出条件和复审日期
bun run check:coverage    # root、desktop、adapters 覆盖率报告和 ratchet 门禁
```

如果只改了很窄的文件，也可以先跑对应的定向测试，但 PR 前仍应跑 `bun run verify`。

生产代码改动必须带对应测试文件：`desktop/src/**`、`src/server/**`、`src/tools/**`、`src/utils/**`、`adapters/**` 变更如果没有同区域测试，会触发阻断。只有维护者确认不适合自动化测试时，才能使用 `allow-missing-tests`。覆盖率 baseline/threshold 变更同样需要维护者确认并加 `allow-coverage-baseline-change`。

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

`provider` selector 来自桌面端「Settings > Providers」里保存的本机配置。别人 clone 代码后不需要知道你的 provider UUID，也不需要使用你的供应商；他们可以在自己的桌面端添加 provider 后运行 `bun run quality:providers` 选择自己的模型。

如果没有保存 provider，也可以用环境变量跑一条 unsaved provider smoke：

```bash
QUALITY_GATE_PROVIDER_BASE_URL=https://example.com \
QUALITY_GATE_PROVIDER_API_KEY=... \
QUALITY_GATE_PROVIDER_MODEL=model-id \
QUALITY_GATE_PROVIDER_API_FORMAT=openai_chat \
bun run quality:gate --mode baseline --allow-live
```

## 什么时候必须跑 Baseline

以下改动建议跑 live baseline：

- 桌面聊天、会话恢复、WebSocket、CLI bridge
- provider/model/runtime 选择
- 权限、工具调用、文件编辑、任务执行
- agent-browser smoke、Computer Use、Skills、MCP
- release 前或风险较大的跨模块重构

如果没有模型额度，至少运行 `bun run verify`，并在 PR 里说明未跑 live baseline 的原因。

## Release 门禁

发版前使用 release 模式：

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

release 模式会组合 PR checks、baseline catalog、live baseline、desktop smoke 和 native checks。发版报告同样写入 `artifacts/quality-runs/<timestamp>/`。线上 release workflow 在打包矩阵前会先跑 `quality:gate --mode pr` 作为非 live 预检，并上传 `release-quality-gate` artifact；真实 live release gate 仍需要维护者用可用 provider 显式运行。

release 模式下 live lane 不允许静默跳过。缺少 provider、真实模型额度或外部账号时，门禁会失败，并要求在发版记录里明确 blocker。

## PR 提交流程

1. 新建普通产品分支，例如 `fix/session-reconnect` 或 `feat/provider-quality-gate`。
2. 安装依赖并完成改动。
3. 为行为变化补测试。
4. 运行相关定向测试。
5. 可选但推荐：运行 `bun run hooks:install`，让后续 push 自动卡住失败门禁。
6. 运行 `bun run verify`。
7. 对高风险改动运行 live baseline。
8. 在 PR 描述里写清楚用户影响、测试命令、覆盖率/质量报告 summary、已知风险。

## 常见问题

### 没有 provider 可以跑吗？

可以跑普通门禁：

```bash
bun run verify
```

只有 live baseline 需要真实模型。先在桌面端 Settings > Providers 添加自己的 provider，再运行：

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
