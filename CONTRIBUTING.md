# 贡献指南

感谢你帮助改进 Claude Code Haha。

完整贡献指南包含本地检查、真实模型 baseline、质量门禁报告和 PR 要求：

- 中文：[docs/guide/contributing.md](docs/guide/contributing.md)
- English：[docs/en/guide/contributing.md](docs/en/guide/contributing.md)

大多数贡献者和 AI Coding Agent 在提交 PR 前应先运行统一入口：

```bash
bun install
bun run verify
```

`bun run verify` 等价于 `bun run quality:pr`，会根据 impact report 一键执行被选中的 policy、desktop、server、adapters、native、docs、quarantine 和 coverage 门禁。命令非 0 退出就表示当前分支还不能提交 PR 或 push。

这个门禁会同时生成质量报告和覆盖率报告。主质量报告会内嵌当前测试范围、结果矩阵、覆盖率摘要，并链接完整 coverage/JUnit/log artifact：

```text
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/report.json
artifacts/quality-runs/<timestamp>/junit.xml
artifacts/quality-runs/<timestamp>/logs/*.log
artifacts/coverage/<timestamp>/coverage-report.md
```

覆盖率 baseline/threshold 变更需要维护者加 `allow-coverage-baseline-change`。CI 会优先用 base branch 的 baseline 做 ratchet 对比，避免 PR 自己降低 baseline 后绕过门禁。覆盖率口径参考 Google/Microsoft 的公开实践：维护中的产品区域向 75-80%+ 拉升，新增或变更的可执行生产代码行必须满足 changed-line coverage 门槛。
被 quarantine 的测试必须保留 owner、reviewAfter 和 exitCriteria；过期后 `check:quarantine`、`check:server`、`check:coverage` 都会阻断。

所有新功能和修复都必须遵守 `AGENTS.md` 里的 Feature Quality Contract：先说明变更面，再补同区域测试、覆盖率证据、必要的 E2E/live smoke 证据和剩余风险。AI Coding Agent 也要遵守 `.github/copilot-instructions.md`，不能只交生产代码不交测试证据。

给 AI 的修复循环可以直接写成：

```text
Run `bun run verify`. If it fails, read the latest quality report and lane log,
fix missing same-area tests, coverage failures, type/lint/build errors, or
docs/native failures, then rerun `bun run verify` until the final Summary has
failed=0. Do not lower coverage baselines or thresholds unless a maintainer
explicitly requested it.
```

常用定位路径：

- 总报告：`artifacts/quality-runs/<timestamp>/report.md`
- lane 日志：`artifacts/quality-runs/<timestamp>/logs/<lane>.log`
- 覆盖率报告：`artifacts/coverage/<timestamp>/coverage-report.md`
- 机器可读覆盖率：`artifacts/coverage/<timestamp>/coverage-report.json`

如果希望本机在 `git push` 前强制运行同一套门禁，安装仓库 Git hook：

```bash
bun run hooks:install
```

安装后，每次 push 都会先运行快速本地门禁（内部是 `bun run quality:push`）。它复用 PR gate 的 impact/policy/路径检查，但默认跳过耗时的 coverage lane；完整覆盖率仍保留在 `bun run verify`、`bun run quality:pr` 和 CI。维护者机器可以把真实模型/桌面 smoke 也纳入 pre-push：

```bash
bun run quality:providers
bun run hooks:install -- --live-provider-model <selector>:main
```

需要完整 live baseline 时加 `--live-mode baseline`。这个配置写入本机 `.git/config`，不会提交 provider 信息或密钥。

如果当前分支包含 CLI core 或 coverage policy 这类维护者级变更，本机 hook 也不会默认放行。维护者需要显式配置本 clone 的批准：

```bash
bun run hooks:install -- --allow-cli-core-change --allow-coverage-baseline-change
```

PR CI 由 `.github/workflows/pr-quality.yml` 在 PR 更新时触发。最后的 `pr-quality-gate` 会汇总所有被变更策略选中的 job；仓库 `main` 分支应在 GitHub branch protection / ruleset 中把 `pr-quality-gate` 设置成 required status check。

如果你在全新 clone 中运行 adapter 或 native 相关检查，还需要安装 adapter 依赖：

```bash
cd adapters
bun install
```

如果改动涉及桌面端聊天路径、provider/runtime 选择、CLI bridge、权限、工具、文件编辑或发布打包，还需要用你本地可用的模型提供商跑真实 baseline：

```bash
bun run quality:providers
bun run quality:gate --mode baseline --allow-live --provider-model <selector>:main
```

只想跑真实 provider/desktop smoke 时，可以使用：

```bash
bun run quality:smoke --provider-model <selector>:main
```

发版前使用 `quality:gate --mode release --allow-live`，live lane 不允许静默跳过；如果缺 provider、额度或外部账号，要在报告里明确写 blocker。
