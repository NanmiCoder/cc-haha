---
name: data-editor
description: SCE 数据编辑器 MCP 与 GameData 配置修改指南。覆盖 data_*、gamedata_*、ui_* 调用顺序，直接编辑 editor/data JSON、$id/$inherit/link 规则，以及保存与 DataGenerated 生成边界。
whenToUse: 当需要通过 MCP 创建/修改/查询 GameData 配置、操作数据编辑器、或直接编辑 editor/data JSON 文件时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# SCE 数据编辑器 Skill

## 何时使用

当任务涉及以下内容时使用本 Skill：

- 创建、查询、修改或删除 `editor/data/**/*.json` 里的 GameData 配置
- 使用 `data_*`、`gamedata_*`、`ui_*` MCP 工具操作数据编辑器
- 处理 `$id`、`$inherit`、Link 字符串路径、继承覆盖、本地字段等数编机制
- 判断某张 GameData 表应该由数据定义，还是由 `src/**/*.cs` 代码定义
- 修改数据后需要同步 `src/DataGenerated/**`

## 优先选择 MCP

如果编辑器或 MCP Host 正在运行，优先用 MCP：

- `ui_*` 读取当前数据编辑器上下文
- `data_*` 读写 DataManager 表、条目、字段、继承状态
- `gamedata_*` 查询 GameData 类型 schema，或生成 `src/DataGenerated`

`Invoke-SceMcp.ps1` 是 HTTP MCP 单次 `tools/call` 入口，可以调用 `data_*`、`gamedata_*`、`ui_*`、`trigger_*` 等已注册工具。脚本在地图工程根的 `ai/tools/` 下时可自动推断工程根；如果从 SDK 模板 `docs/ai/tools/` 运行，需要传 `-ProjectRoot` 指向地图工程根。

推荐调用方式：写一个临时 JSON，包含 `baseUrl`、`tool`、`arguments`，用 `-RequestJsonPath` 调脚本，最后删除临时文件。

```powershell
$MapRoot = "D:\YourSceMap"
$McpScript = Join-Path $MapRoot 'ai\tools\Invoke-SceMcp.ps1'
$TempRequest = Join-Path $env:TEMP ("sce-data-mcp-" + [Guid]::NewGuid().ToString("n") + ".json")
$PowerShellExe = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if ([string]::IsNullOrWhiteSpace($PowerShellExe)) {
  $PowerShellExe = Get-Command powershell -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
}
@'
{ "baseUrl": "http://127.0.0.1:8765/", "tool": "data_list_tables", "arguments": {} }
'@ | Set-Content -LiteralPath $TempRequest -Encoding utf8
try {
  & $PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $McpScript -RequestJsonPath $TempRequest
} finally {
  if (Test-Path -LiteralPath $TempRequest) { Remove-Item -LiteralPath $TempRequest -Force }
}
```

成功返回时先看外层 `result.isError`。业务结果通常在 `result.content[0].text`，多数是 JSON 字符串。写操作不要并行；连续修改时等上一个工具返回后再调用下一个。

## 自然语言一键做完整地图

MCP 工具必须保持通用。即使用户说“做一张某某玩法地图”，也不要新增玩法专用工具；AI 应该把自然语言拆成通用 plan，再调用通用 MCP：

1. 读取上下文：`ui_get_editor_state`、`data_list_tables`、`gamedata_list_types`、`trigger_get_api_schema`
2. 数据侧一键创建：`workflow_create_map_from_plan`
3. 触发侧创建逻辑：`trigger_create_folder`、`trigger_create_class`、`trigger_create_function`、`trigger_create_trigger`
4. 保存与生成：`data_save`、`gamedata_generate_code`、`trigger_save`
5. 项目校验：`gamedata_validate_project`、`trigger_validate_project`

自然语言只负责描述目标玩法；MCP 参数里用通用字段表达：

- `contentRoot`：本玩法的数据目录名，例如 `AutoBattle1v1`
- `tables`：需要的 GameData 表规格
- `entries`：单位、技能、配置、GameMode、生成器等条目规格
- `links` / `attachments`：条目之间的字段引用和追加挂接
- `gameMode`：玩法入口配置
- `save`、`generateCode`、`validate`：是否保存、生成和校验

示例骨架：

```json
{
  "tool": "workflow_create_map_from_plan",
  "arguments": {
    "contentRoot": "AutoBattle1v1",
    "entries": [
      {
        "kind": "unit",
        "entryName": "Footman",
        "displayName": "Footman",
        "stats": { "maxHp": 420, "attack": 18, "moveSpeed": 270 }
      },
      {
        "kind": "spawner",
        "entryName": "FootmanSpawner",
        "displayName": "Footman Spawner",
        "spawnEntries": ["Footman"],
        "spawnIntervalSeconds": 15,
        "spawnCount": 2
      },
      {
        "kind": "config",
        "entryName": "EconomyConfig",
        "category": "Config",
        "fields": { "InitialGold": 500, "IncomeIntervalSeconds": 10, "IncomeGold": 50 }
      }
    ],
    "gameMode": {
      "entryName": "AutoBattleMode",
      "displayName": "Auto Battle 1v1",
      "players": [{ "id": 1 }, { "id": 2 }],
      "teams": [{ "id": 1 }, { "id": 2 }]
    },
    "save": true,
    "generateCode": true,
    "validate": true
  }
}
```

如果某个玩法需要“兵营、商店、刷怪点、波次、经济”等概念，优先用 `workflow_create_spawner`、普通 `kind: "config"` 条目和 `links` 表达。不要把玩法名写进 MCP 工具名。

## 工具速查

| 类别 | 工具 |
|------|------|
| UI 上下文 | `ui_get_editor_state`、`ui_get_current_table`、`ui_get_selected_entry`、`ui_get_selected_field` |
| 表与条目查询 | `data_list_tables`、`data_get_table`、`data_list_entries`、`data_get_entry` |
| 表与条目创建 | `data_create_table`、`data_create_entry` |
| 模板与批量创建 | `data_list_templates`、`data_create_from_template` |
| 字段级修改 | `data_get_field`、`data_set_field`、`data_set_fields`、`data_insert_field`、`data_move_field`、`data_remove_field` |
| 继承与本地覆盖 | `data_get_inherit`、`data_get_local_data`、`data_get_base_data`、`data_get_field_status`、`data_reset_field`、`data_reset_entry` |
| GameData 类型与生成 | `gamedata_list_types`、`gamedata_get_type_schema`、`gamedata_get_generated_symbols`、`gamedata_generate_code` |
| Link、资源与引用 | `data_list_link_candidates`、`data_find_references`、`data_resolve_entry_links`、`data_validate_links`、`resource_search` |
| 项目校验 | `gamedata_validate_entry`、`gamedata_validate_project` |
| 制作人工作流 | `workflow_create_content_folder`、`workflow_create_unit`、`workflow_create_ability`、`workflow_attach_ability_to_unit`、`workflow_create_spawner`、`workflow_create_game_mode`、`workflow_create_map_from_plan` |
| 触发器配合 | `trigger_get_api_schema`、`trigger_create_folder`、`trigger_create_class`、`trigger_create_function`、`trigger_create_trigger`、`trigger_save`、`trigger_validate_project` |
| 删除与移动 | `data_delete_entry`、`data_delete_table`、`data_move_table` |
| 保存与生成 | `data_save`、`gamedata_generate_code` |

`data_update_entry` 是危险工具：它会用完整 JSON 覆盖条目的本地数据。普通修改优先使用 `data_set_field` 或 `data_set_fields`。

## 标准工作流

### 1. 用户说“当前选中”或“这里”

1. `ui_get_editor_state`
2. 需要条目时调用 `ui_get_selected_entry`
3. 需要字段时调用 `ui_get_selected_field`
4. 再用返回的 `entryId` / `fieldPath` 调 `data_get_entry`、`data_get_field_status` 或字段级写入工具

如果 `editorOpen` 为 false，说明当前会话拿不到数据编辑器 UI；改用 `data_list_tables` / `data_list_entries` 根据路径和类型定位。

### 2. 修改已有条目字段

1. `data_get_entry` 读取目标条目，确认 `metaType`、`$inherit` 与当前值
2. `gamedata_get_type_schema` 查询该 `metaType` 的权威字段 schema
3. 对继承字段先用 `data_get_field_status` 判断是 `local`、`inherited` 还是 `default`
4. 小改用 `data_set_field`，多字段改动用 `data_set_fields`
5. `data_save` 保存源数据
6. 运行时需要更新 `ScopeData.*` 时调用 `gamedata_generate_code`，可传 `{ "saveData": true }`

### 3. 创建新条目

1. `data_list_tables` 找到目标表，或用 `data_get_table` 确认表路径和类型
2. `gamedata_list_types` / `gamedata_get_type_schema` 确认要创建的 GameData 类型和字段
3. 找一个相近条目或模板：`data_list_entries` 后 `data_get_entry`
4. 用 `data_create_entry` 创建，`entryData` 只放必要的 `$type`、`$inherit` 和少量初始字段
5. 用 `data_set_fields` 补齐本地覆盖字段
6. `data_save`，必要时 `gamedata_generate_code`

不要为了复刻模板而把继承来的字段全部写成本地字段；这会破坏模板继承的维护价值。

### 4. 修改 Link 字段

普通 Link 字段在 JSON 中是字符串路径，不是 `{"$ref": ...}`。

1. `gamedata_get_type_schema` 确认字段是否是 link，或看字段 schema 里的 `jsonType: "link"` / `linkTargetType`
2. `data_list_link_candidates` 传 `entryIdOrPath` 和 `fieldPath` 获取合法候选
3. 从候选的 `value` 中选择要写入的字符串
4. 用 `data_set_field` 或 `data_set_fields` 写入
5. 若要删除或替换目标条目，先对目标调用 `data_find_references`

常见 Link 字符串：

- 同一蓝图文件内引用其他节点：`$this.EntryName`
- 同库跨蓝图引用：相对逻辑路径或 `$GameDataRule.DefaultDisplayInfo.Root`
- 跨库稳定引用：`$id.EntryName`

### 5. 处理继承与本地覆盖

1. `data_get_inherit` 查看继承链
2. `data_get_base_data` 查看继承来的基础数据
3. `data_get_local_data` 查看本地覆盖
4. `data_get_field_status` 判断具体字段来源
5. 想恢复继承值时用 `data_reset_field`
6. 想清空全部本地覆盖时才用 `data_reset_entry`

`data_remove_field` 是删除本地字段；如果字段有继承值，通常应使用 `data_reset_field`。

### 6. 删除或移动前先查引用

删除条目、删除表、移动表或替换 Link 目标前，先运行：

```text
data_find_references -> 确认 referenceCount 为 0 或逐项处理引用 -> 再删除/移动 -> data_save -> gamedata_generate_code?
```

`data_find_references` 是字符串引用扫描，能发现常见 `entryId`、`$this.EntryName`、路径后缀和表路径引用。复杂脚本引用仍需要配合代码搜索。

## 数据来源边界

静态 GameData 配置只有两条合法来源：

- `editor/data/**` 源数据，包括直接编辑 JSON 和通过 `data_*` MCP 修改
- `src/**/*.cs` 代码定义，例如 `OnGameDataInitialization` 中 `new GameDataUnit(...)`

同一张 GameData 表只能选择一种静态来源。不要把 json-backed 条目做成薄壳，再在代码里对 `ScopeData.GameDataXxx.*.Data` 做静态补丁。

`src/DataGenerated/**` 只是生成投影，用来确认 `ScopeData.*` 名称和生成结果，不是主要维护入口。

## `$id` 规则

- 这里的 `$id` 指 JSON 顶层蓝图文件 ID，不是 MCP 的 `tableId` 或 `entryId`
- `$id` 标识整个蓝图文件，不是 Entry Name
- AI 直接创建新的 JSON 文件且不确定 `$id` 格式时，优先省略 `$id`
- 编辑器会在加载/保存时自动补合法且唯一的 `$id`
- 已存在的 `$id` 不要轻易修改，因为其他蓝图文件可能通过 `$id.EntryName` 引用它

推荐顺序：

1. 先创建新文件，不写 `$id`
2. 让编辑器加载或保存一次，自动补全 `$id`
3. 再读取实际 `$id`
4. 最后再填写其他蓝图文件里的跨蓝图引用

## 直接写 JSON 时的最低约束

只有 MCP 不可用、需要批量离线修改、或用户明确要求直接改 JSON 时，才直接编辑 `editor/data/**/*.json`。

- 一个 JSON 文件对应一个蓝图文件；文件内有 `Root`、`OtherEntry` 等 Entry
- `Root`、`OtherEntry` 等键名是 Entry Name
- 同一蓝图内引用优先 `$this.EntryName`
- 同库跨蓝图引用优先相对逻辑路径
- 跨库稳定引用优先 `$id.EntryName`
- `$inherit` 也是字符串路径
- `Metadata.json`、`EntryInfo.json`、`src/DataGenerated/**` 不要手动维护

正确顺序通常是：修改源数据 -> 让编辑器或 MCP 保存 -> 运行现有生成链刷新派生物。

## 常见错误

- 新建 JSON 时手写了错误格式的 `$id`
- 修改已有 `$id`，却没有同步更新 `$id.EntryName` 引用
- 把 `data_get_entry` 返回的展示性元数据当作源字段写回
- 直接用 `data_update_entry` 全量覆盖，误删本地字段或继承关系
- 给 Link 字段写 `{"$ref": ...}`，而不是写字符串路径
- 从 `DataGenerated` 反推错误模式，对 `.Data` 做静态 patch
- 同一张表一部分放在 JSON，一部分又放进 `OnGameDataInitialization`
