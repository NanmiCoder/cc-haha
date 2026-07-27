# 贡献指南

提交 PR 前请先确认改动影响面，再运行对应的确定性检查。外部贡献者不需要提供真实模型账号或额度。

## 1. 按影响面运行本地检查

```bash
bun run check:impact
```

`check:impact` 会列出这次改动选中的检查。先运行对应的窄命令；准备声明 PR-ready、改动风险较高，或维护者需要复现完整 CI 时，再运行统一入口：

```bash
bun run verify
```

`bun run verify` 会按改动路径执行被选中的 policy、产品、契约、持久化和 coverage lane，但不会调用真实模型。小范围贡献无需在本机重复所有无关模块；GitHub PR gate 会再次执行并严格核对 selected / skipped 状态。

`git push` 不再自动运行本地质量门禁。需要质量检查时请手动运行 `bun run quality:push` 或 `bun run verify`；完整覆盖率仍以 `bun run verify` 为准。

只改了某个模块时可以用窄命令快速迭代：

| 改动范围 | 快速验证 |
| --- | --- |
| CLI / Server / 工具 | `bun run check:server` |
| 桌面端 | `bun run check:desktop` |
| IM Adapter | `bun run check:adapters` |
| 桌面 Electron / 原生打包 | `bun run check:native` |
| Provider / runtime / proxy | `bun run check:provider-contract` |
| 桌面聊天 / WebSocket / 会话 | `bun run check:chat-contract` |
| 持久化格式与迁移 | `bun run check:persistence-upgrade` |
| 文档 | `bun run check:docs` |

门禁失败时，查看最新质量报告和对应 lane 日志定位问题：

```
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/logs/<lane>.log
```

## 2. 用户可见或跨进程桌面改动需要手工测试

改动涉及用户可见 UI、跨 WebSocket/进程流程、Electron host 或 native/packaging 时，除了自动门禁外，还应在真机上验证相关流程。纯样式、纯工具或已有组件单元测试能够完整证明的改动，不要求重复无关流程：

- 起本地服务 `SERVER_PORT=3456 bun run src/server/index.ts`
- 起桌面端 `cd desktop && bun run dev`
- 验证改动涉及的交互流程：页面渲染、按钮/表单行为、弹窗、快捷键、多窗口等
- 必要时打本地 macOS 包 `desktop/scripts/build-macos-arm64.sh` 做完整验证

## 3. PR 必须附上影响范围和测试说明

每个 PR 的描述里必须包含：

- **影响范围**：改了哪些模块（desktop / server / adapter / native / docs / provider / agent-loop）
- **测试说明**：跑了哪些测试、覆盖率情况、手工测试了哪些流程（用户可见或跨进程桌面改动需有真机记录）
- **剩余风险**：已知未覆盖的边界或需要后续跟进的点

provider/runtime、agent-loop、文件编辑、权限、session 等核心路径必须先通过离线 mock/fixture/contract 测试。真实模型验证只由拥有可信 secrets 和额度的维护者在高风险合并或发版前运行：

```bash
bun run quality:providers
bun run quality:smoke --provider-model <provider:model>
```

来自 fork 的 PR 不会获得仓库 secrets，也不应被要求运行真实模型。贡献者只需在 PR 中明确写 `live model: not run (untrusted fork / no provider)`；这不是确定性 PR gate 的失败理由。

## 更多

完整质量门禁和覆盖率说明见 [贡献指南](docs/internals/contributing.md)；`AGENTS.md` 仅保留 Agent 的高信号入口与路由。
