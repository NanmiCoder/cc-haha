---
description: 启动 SCE 编辑器调试或无编辑器客户端调试
argument-hint: "[--no-compile] [--client-only]"
---

使用 $ARGUMENTS 决定调试模式：

1. **默认**（无参数）：调用 `spark2_debug_start` 启动完整编辑器调试
2. **--no-compile**：调用 `spark2_debug_start_no_compile`（适用于已手动构建的场景）
3. **--client-only**：读取 `client-only-debug` 技能，使用 `Start-SceClientOnlyDebug.ps1` 无编辑器启动

流程：
- 确认项目双端编译通过
- 部署 DLL 到 AppBundle（client-only 模式需要手动 Copy-Item）
- 启动调试
- 等待 Runtime MCP 可用后，可执行 `spark2_runtime_call_tool` 进行运行时验证
