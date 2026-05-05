# 贡献指南

感谢你帮助改进 yuanclaw。

完整贡献指南包含本地检查、真实模型 baseline、质量门禁报告和 PR 要求：

- 中文：[docs/guide/contributing.md](docs/guide/contributing.md)
- English：[docs/en/guide/contributing.md](docs/en/guide/contributing.md)

大多数贡献者在提交 PR 前应先运行：

```bash
bun install
bun run quality:pr
```

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

质量报告会写入 `artifacts/quality-runs/<timestamp>/`。
