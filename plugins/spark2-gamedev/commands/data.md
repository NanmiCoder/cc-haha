---
description: SCE 数据编辑器快捷操作（创建/修改/查询 GameData）
argument-hint: "<operation> [type] [name]"
---

使用 $ARGUMENTS 执行数据编辑操作。

支持的 operation：
- `list <type>` — 列出指定类型的数据条目
- `get <type> <name>` — 获取某条目详情
- `create <type>` — 通过 MCP 创建新数据条目
- `edit <type> <name>` — 编辑已有条目
- `schema` — 查看可用数据类型 schema

流程：
1. 读取 `data-editor` 技能获取 MCP 工具使用模式
2. 通过 `spark2_data_*` / `spark2_gamedata_*` 工具执行操作
3. 如果编辑器未运行，提示用户启动 SCE 编辑器并打开项目
