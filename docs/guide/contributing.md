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

## 普通 PR 的影响面检查

先让仓库按变更路径列出需要运行的检查：

```bash
bun run check:impact
```

开发时运行 impact report 选中的窄命令即可。准备声明 PR-ready、改动风险较高，或需要完整复现托管 CI 时，再运行统一入口：

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

给 AI 写代码时，可以直接把这段作为验收指令：

```text
Run `bun run check:impact`, then run the selected focused checks. If the task
requires PR-ready/full validation, run `bun run verify`. If it fails, read the latest
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
5. 窄命令通过后，如果要声明 PR-ready/full validation，再跑一次 `bun run verify`。只有最终 Summary 是 `failed=0`，才可以这样声明。

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

release 模式会组合 PR checks、baseline catalog、live baseline、native checks，并用当前平台 canonical release artifact 跑 `package-smoke --package-kind release`。发版报告同样写入 `artifacts/quality-runs/<timestamp>/`。线上 release workflow 在打包矩阵前会先跑 `bun run verify` 作为非 live 预检；真实 live release gate 仍需要维护者用可用 provider 显式运行。

release 模式下 live lane 不允许静默跳过。缺少 provider、真实模型额度或外部账号时，门禁会失败，并要求在发版记录里明确 blocker。

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

`bun run verify` 也不需要真实模型；只有 live baseline 需要。维护者可以先在桌面端 Settings > Providers 添加自己的 provider，再运行：

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
