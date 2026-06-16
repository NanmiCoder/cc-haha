---
name: trigger-editor-mcp
description: SCE trigger MCP (trigger_*). Write temp JSON (tool+arguments), run ai/tools/Invoke-SceMcp.ps1 once per call, delete temp file; Host from docs/.editor-root; mapReady on GET /health.
---

# SCE 触发器编辑器 MCP Skill

## 概述

此 Skill 提供通过 MCP 协议操作 SCE 编辑器触发器系统的能力。触发器是游戏逻辑的可视化编程系统，支持事件驱动的脚本编写；与普通 **LibModule（触发器模块）** 并列还有 **Validator** 校验器模块，可用 MCP 创建其中的静态校验函数（见 **`trigger_create_validator`**）。

## 连接 MCP（优先 pwsh）

**本脚本是 HTTP MCP 的统一入口**（与 Cursor 内置 `trigger_*` 并行；命令行/CI 侧一律用此脚本起独立宿主）：**`GET /health`** → 若端口**无响应**则按工程 **`docs/.editor-root`** 定位 **`TriggerMcpHost.exe`** 并启动（工程根由 **`-ProjectRoot`** 传入，或脚本位于 **`<工程根>/ai/tools/`** 时**自动推断**为 **`ai` 的父目录**；旧版 **`<工程根>/.cursor/tools/`** 仍兼容）→ 轮询至 **`mapReady: true`**（独立 Host）→ **`POST` 一次** JSON-RPC **`tools/call`**。若端口**已有健康 MCP**，**不会**再启第二个实例，直接执行该次调用。**每次脚本进程只对应一个工具**；需要连续多个工具时，应**多次运行**脚本（或多次用 MCP），且写操作之间仍须**串行**、不可并行。

**项目根目录**：含 **`project.sce`**、**`docs/.editor-root`** 的 SCE **工程根**。脚本路径为 **`<工程根>/ai/tools/Invoke-SceMcp.ps1`**（推荐）时**不必**传 **`-ProjectRoot`**，也**不必**通过 **`docs/.sdk-version`** 查找脚本；示例 JSON 同目录：**`ai/tools/trigger-mcp-call.example.json`**（与 **[trigger-mcp-workflow.mdc](../../rules/trigger-mcp-workflow.mdc)** 一致）。WasiCoreSDK 内模板路径为 **`docs/ai/tools/`**，复制到地图工程根 **`ai/tools/`** 后使用。

| 参数 | 说明 |
|------|------|
| `-ProjectRoot` | **可选**。覆盖/指定工程根。未传且脚本在 **`ai/tools/`**（或兼容的 **`.cursor/tools/`**）下时自动推断；脚本在其它路径（如单独复制的 `tools/`）且需自动起 Host 时再传 |
| `-RequestJsonPath` | 请求 JSON：可选 **`baseUrl`**；**必须**含 **`tool`** 与可选 **`arguments`**（格式见 **`ai/tools/trigger-mcp-call.example.json`**）。**优先**：AI 先将内容写入**临时文件**再传此路径，运行结束后**删除**临时文件 |
| `-Tool` / `-ArgumentsJson` | 不用 JSON 文件时的单次快捷方式 |
| `-HealthOnly` | 只探测/起 Host 并等到就绪，输出 **`/health`** 快照，**不**调用工具（适合纯预热） |
| `-Port` | 未在 JSON 中指定 **`baseUrl`** 时的 MCP 端口，默认 **8765** |
| `-McpMode` | 启动宿主时的 **`--mcp-mode`**，默认 **`http`** |
| `-HostExtraArgs` | 追加给宿主进程的参数（如 **`--log-file=...`**） |

**推荐流程（AI / 自动化）**：按 **`ai/tools/trigger-mcp-call.example.json`** 的结构把本次调用的 **`baseUrl`（可选）、`tool`、`arguments`** 写入**临时 JSON**，用 **`-RequestJsonPath`** 调用 **`ai/tools/Invoke-SceMcp.ps1`**，在 **`finally`** 里 **`Remove-Item`** 删除临时文件。

```powershell
$MapRoot = "D:\YourSceMap"
$McpScript = Join-Path $MapRoot 'ai\tools\Invoke-SceMcp.ps1'
$TempRequest = Join-Path $env:TEMP ("sce-trigger-mcp-" + [Guid]::NewGuid().ToString("n") + ".json")
$PowerShellExe = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if ([string]::IsNullOrWhiteSpace($PowerShellExe)) {
  $PowerShellExe = Get-Command powershell -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
}
@'
{ "baseUrl": "http://127.0.0.1:8765/", "tool": "trigger_list_files", "arguments": { "env": "Common" } }
'@ | Set-Content -LiteralPath $TempRequest -Encoding utf8
try {
  & $PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $McpScript -RequestJsonPath $TempRequest
} finally {
  if (Test-Path -LiteralPath $TempRequest) { Remove-Item -LiteralPath $TempRequest -Force }
}
```

另可改用同目录示例做**只读**试跑：`-RequestJsonPath (Join-Path (Split-Path $McpScript -Parent) 'trigger-mcp-call.example.json')`（勿删除仓库内示例文件）。若脚本仍从 **`docs/ai/tools/`**（SDK 模板）运行，须传 **`-ProjectRoot`** 指向 SCE 地图根。

脚本成功时向 stdout 输出 JSON，字段 **`mcpBaseUrl`**、**`tool`**、**`result`**（来自 MCP 单次 **`tools/call`**）；RPC 错误会终止并抛错。

**在 Cursor 里**：若会话已有 **`trigger_*`** 且能调通 → **直接用 MCP 工具**。若无工具或连接失败 → **先执行上述脚本**（起 Host + 可完成 HTTP 调用）；要让 Cursor **长期**连同一端口，可在工作区根配置 **`.cursor/mcp.json`**（`url` 与 Host 的 `--mcp-port` / `--mcp-mode` 一致）并提示 **重载 MCP**。**禁止**只交代用户「自己开宿主」而不探测/启动（策略禁 shell 时除外）。

## 前提

- **两种端点**：完整 SCE 编辑器 MCP，或 **TriggerMcpHost**（exe 目录见工程 **`docs/.editor-root`**；独立宿主通过 **`ai/tools/Invoke-SceMcp.ps1`** 启动，**不要**手写 **`TriggerMcpHost.exe`** 命令行）。
- **独立 Host**：`trigger_*` 前须 **`/health`** 里 **`mapReady: true`**；`mapLoadPhase: loading` 时**不要**再启第二个实例。部分工具依赖编辑器 UI 时在独立 Host 上可能受限。

## 当前已注册的 `trigger_*` 工具（与 `MCPServer` / `TriggerEditorTools.Register` 对齐）

以下名称以外**没有**其它 `trigger_*` 工具。

| 类别 | 工具名 |
|------|--------|
| 列表 / 读取 | `trigger_list_files`、`trigger_get_file`、`trigger_list_validator_files`、`trigger_get_validator_file` |
| 搜索 | `trigger_search` |
| 创建 | `trigger_create_class`、`trigger_create_trigger`、`trigger_create_function`、`trigger_create_validator`、`trigger_create_variable`、`trigger_create_preset`、`trigger_create_custom_event`、`trigger_create_folder` |
| 重命名 / 删除 / 启用 / **仅改函数体** | `trigger_rename`、`trigger_delete`、`trigger_set_enabled`、**`trigger_replace_function_body`** |
| 保存 | `trigger_save` |
| 只读状态 / API | `trigger_get_editor_state`、`trigger_get_api_schema` |
| 校验 | `trigger_validate_project` |

**代码生成**：已无独立的 `trigger_generate_code` 工具。`trigger_create_*`、`trigger_delete`、`trigger_rename`、`trigger_set_enabled`、**`trigger_replace_function_body`** 等**写操作在成功返回前**会由 MCP **自动**将当前模型生成到 **`src/TriggerGenerated/`**（与编辑器内「生成代码」一致，含 Validator 子输出）。**`trigger_save`** 仍负责把触发器树等**持久化到地图工程**；与生成是不同步骤。

## 触发器系统概念

### 层次结构

**生成代码位置（`TriggerGenerated`）**：地图库下 **`src/TriggerGenerated/`** 为生成输出目录。按环境生成 **`common.cs` / `client.cs` / `server.cs`**；**Validator** 对应 **`src/TriggerGenerated/Validator/`** 下同名的环境文件。上述文件均在 **`namespace GameEntry`** 中。

**生成代码里的 `// path:` 注释**：若某段生成声明（如 **`Scope` 内静态字段**、部分 **`static` 成员**等）的**紧上方**有单行注释 **`// path: 文件名/文件夹/…/节点名`**，该字符串即编辑器资源树中对应节点的路径（与 MCP 的 **`nodePath` / `parentPath`** 一致，**`/`** 分隔）。便于在 **`TriggerGenerated`** 里反查该生成片段属于哪个模块文件下的哪个节点。

**普通 LibModule（触发器模块）**：编辑树节点类型含 `Trigger`、`Function`、`Variable`、`Class`、**`Preset`（预设/枚举）**、**`CustomEvent`（自定义事件类）** 等；触发器本体为 **`Trigger`**。

- **`Function` / `Variable`**：生成到 **`partial class Scope`**，即全局静态函数与全局静态字段。
- **`Trigger`**：生成的 `_Execute`、`ITrigger` 与初始化器等写入**同一** `TriggerGenerated` 环境文件中的 **`partial class Scope`**（与示例 `TriggerGenerated/common.cs` 结构一致）。
- **`Class`**：生成的类型在 **`GameEntry`** 命名空间下**直接**声明，**不**嵌套在 `Scope` 内。
- **`Preset`**：对应 C# **`enum`**，生成在 **`GameEntry`** 下（与 `Class` 同类顶层声明，非 `Scope` 内）。可用 MCP **`trigger_create_preset`** 从枚举源码创建。
- **`CustomEvent`**：须为 **`class 名(主构造参数) : Events.ITriggerEvent<自身>`** 形式，主构造进入模型 **`EventCreator`**。可用 MCP **`trigger_create_custom_event`** 从符合约定的源码创建。

```
LibModule (文件)
  └── Folder (文件夹，可嵌套)
      ├── Trigger (触发器)
      │   ├── Scenes (场景列表)
      │   ├── Events (事件列表)
      │   ├── Conditions (条件列表)
      │   ├── Variables (局部变量)
      │   └── Statements (动作语句)
      ├── Function (全局函数 → partial class Scope 中静态方法)
      ├── Variable (全局变量 → partial class Scope 中静态字段)
      ├── Class / Preset / CustomEvent（GameEntry 顶层类型，非 Scope 内）
      └── ...
```

**Validator 校验器**：根同样为 **`LibModule`**（独立校验器模块文件），但树内**仅允许** **`Folder`** 与 **`Function`**（无 `Trigger`、`Variable` 等）。生成代码在 **`TriggerGenerated/Validator/`** 对应环境文件中，**`namespace GameEntry`** 下的 **`public partial class Validator`** 内为静态校验方法（见示例 `TriggerGenerated/Validator/common.cs`）。

```
LibModule (文件，Validator 模块)
  ├── Folder (文件夹，可嵌套)
  │   ├── Folder (子文件夹，可继续嵌套)
  │   └── Function (校验函数 → partial class Validator 中静态方法)
  └── Function (根级校验函数，同上)
```

与上述 **普通 LibModule（触发器模块）** 并列，每个环境有独立的 **Validator 模块**（上表树）。`trigger_list_files` 只列出**触发器模块**侧 LibModule；**Validator 树**用 **`trigger_list_validator_files`** / **`trigger_get_validator_file`** 浏览；创建校验函数用 **`trigger_create_validator`**。对 Validator 内节点做 **`trigger_rename` / `trigger_delete` / `trigger_set_enabled` / `trigger_replace_function_body`** 时须传 **`scope: "validator"`**（路径规则与普通库相同：`校验器文件名/文件夹/函数名`；**`trigger_replace_function_body`** 另见 **`parentPath` + `functionName`** 说明）。**`trigger_search`** 的 **`scope`** 为 **`trigger`（默认）、`validator`、`all`**；返回项的 **`tree`** 为 **`"trigger"`** 或 **`"validator"`**（与 `scope` 含义对应，**不是**字符串 `library`）。

### 环境 (Env)

- `Common`: 通用环境（服务端和客户端共享）
- `Client`: 客户端专用
- `Server`: 服务端专用

## 路径格式

路径使用 `/` 分隔，格式为: `文件名/文件夹/节点名`

创建类工具中的 **`parentPath` 均可省略**。省略时：

- **`trigger_create_function`、`trigger_create_class`、`trigger_create_trigger`、`trigger_create_variable`、**`trigger_create_preset`**、**`trigger_create_custom_event`** 等**（普通 **LibModule / 触发器模块**）：节点落在当前地图库在对应 **`env`** 下的**普通模块根目录**（与只传 `env` 的 `trigger_create_function` 一致）。
- **`trigger_create_validator`**：节点落在该 **`env`** 下的 **Validator 模块根目录**（不是普通触发器模块根；若该环境无 Validator 模块则工具失败）。

**`trigger_create_folder`** 省略 `parentPath` 时可另传可选 **`env`**，不传则按 **Common**。传了 `parentPath` 时，`trigger_create_validator` 的路径须落在 **Validator 文件树**内（可用 **`trigger_list_validator_files`** 确认首段文件名）。

**`parentPath` 的合法根（与 `trigger_create_folder` 的配合）**：**`trigger_create_function` / `trigger_create_class` / `trigger_create_trigger` / `trigger_create_variable` / `trigger_create_preset` / `trigger_create_custom_event` 等**在传入**非空** **`parentPath`** 时，服务端按「**首段 = 当前 `env` 下资源列表里的 LibModule 文件名**」解析（与 **`trigger_list_files`** 返回的每个条目的 **`name` / `path`** 一致，例如 **`GameEntry`**、**`MainTriggers`**）；首段必须是**已存在的触发器模块文件节点**，再向下匹配文件夹。因此 **`parentPath` 的根绝不是「裸文件夹名」**——不能把「仅在某个 `env` 下、省略 `parentPath` 建出来的库根文件夹」当成与 LibModule 文件并列的根去拼路径。**仅传 `env`、不传 `parentPath` 的 `trigger_create_folder`** 会把文件夹挂到实现上的**环境模块根内容区**，该位置**不在**上述「首段 = LibModule 文件名」的解析链里；接着若把 **`parentPath` 写成该文件夹名单独一段**（如 `CodexMcpTest_xxx`），常见返回为 **`Cannot add to path: ... in env Common. Must be a file or folder.`**（与 **`TriggerEditorTools`** 中解析逻辑一致）。**稳定做法**：先 **`parentPath` = 已有 LibModule 文件名**（如 **`GameEntry`**），再在其下建文件夹，后续一律使用 **`GameEntry/子文件夹/...`**。**`trigger_create_folder` 成功响应中的 `path`** 标明服务端为本次文件夹计算的节点路径；**下一工具调用的 `parentPath` 必须以 `trigger_list_files` 中的文件名为首段**——若返回的 **`path`** 不含该前缀，**不要**把返回路径当作 **`trigger_create_*` 可用的根**；应以列表中的文件名为根重写路径，或自始即用 **`parentPath: "GameEntry"`**（或你工程里实际的文件名）建夹。文件夹仍是编辑器资源树里的**管理/分组**节点，与 **`namespace GameEntry`** 等生成代码布局**无**逐项对应（参见下文 **`trigger_create_folder`** 说明）。

**Validator 与 `scope`**：凡按 **`nodePath`** 在 **Validator 模块**内定位节点的写操作（**`trigger_rename`**、**`trigger_delete`**、**`trigger_set_enabled`**），必须 **`scope: "validator"`**；默认 **`trigger`** 仅在普通触发器模块树内解析。**`trigger_replace_function_body`** 使用 **`parentPath`** 定位父容器，在 Validator 内替换校验函数体时同样须 **`scope: "validator"`**（见该工具说明）。

**示例**:

- `MainTriggers` - 文件
- `MainTriggers/Combat` - 文件夹
- `MainTriggers/Combat/OnPlayerAttack` - 触发器

## 代码生成与「等价修改」（MCP 行为）

**`trigger_create_*` / `trigger_rename` / `trigger_delete` / `trigger_set_enabled` / `trigger_replace_function_body`** 等写入类工具在**业务成功返回前**会由 MCP **自动**执行与编辑器「生成代码」等价的流程，将 **`src/TriggerGenerated/`**（及 Validator 子目录等）**刷新到与当前内存模型一致**；**成功响应里仍不含 `codeGeneration` 诊断字段**（与旧版显式工具不同）。**`trigger_save`** 仍须单独调用，用于把触发器资源**写入地图工程**（与生成 C# 输出是不同步骤）。

**不要直接写触发器模型 JSON**：地图工程下的 **`editor/trigger/<env>/**/*.json`** 是触发编辑器模型的内部序列化，不是 AI 输出目标，也不是稳定的业务 DSL。创建或修改触发器逻辑时应传 C# 片段给 **`trigger_create_*`** / **`trigger_replace_function_body`**，再用 **`trigger_save`** 和 **`trigger_validate_project`** 收尾。

**仅函数体（不改名、不改签名）**：对**已有**的**静态函数**或 **Class 成员函数**，可用 **`trigger_replace_function_body`**：在 **`code`** 中声明名为 **`TempFunctionBody`** 的方法，**签名须与目标函数完全一致**（`static`/`async`、返回类型、参数列表等），工具只替换该节点的**函数体**；实现上等价于解析片段后写入模型再生成。详见下文 **`trigger_replace_function_body`**。

**其它节点或整体替换**：不能把已有触发器 / 整类 / 变量等的源码当作任意「打补丁」直接替换。典型等价流程仍是：**`trigger_delete`** 删除目标节点（必要时先 **`trigger_get_file`** 等把树形概要抄出备用，或从 **`src/TriggerGenerated/`** 对照现有生成代码）→ 在外部或对话中改好 **`code`** → 用对应的 **`trigger_create_*`** 以新 **`code`** 重建节点（上述步骤会自动刷新生成目录）→ **`trigger_save`** 持久化 → 在 **`src/TriggerGenerated/`** 中核对生成效果是否达到预期。

## 常见工作流

### 1. 创建新触发器

```
1. trigger_list_files - 查看现有文件结构
2. trigger_create_folder - 如需要，创建组织文件夹
3. trigger_create_trigger - 传入 env + 符合约定的 C#（见下文该工具说明）创建触发器（成功即已自动刷新生成目录）
4. trigger_save - 保存触发器数据到地图工程
5. （可选）在 IDE 中打开 src/TriggerGenerated/ 核对生成效果
```

### 2. 查找并修改触发器

```
1. trigger_search - 搜索目标触发器
2. trigger_get_file（可选）— 查看文件下节点树概要
3. 轻量修改：**`trigger_rename`**（仅改节点名）、**`trigger_set_enabled`** 等（成功即已自动刷新生成目录）
4. 仅改「已有静态函数 / 类成员函数」的函数体：**`trigger_replace_function_body`**（`code` 内方法名须为 TempFunctionBody，签名与目标一致；成功即已自动刷新生成目录）
5. 改触发器逻辑、整段新建类、或其它无法用语义化节点编辑覆盖的改动：见上文「代码生成与等价修改」（**`trigger_delete`** + **`trigger_create_*`**）
6. trigger_save - 保存更改
```

### 3. 清理未使用的触发器

```
1. trigger_search - 搜索候选触发器
2. trigger_set_enabled - 先禁用测试（成功即已自动刷新生成目录）
3. trigger_delete - 确认后删除（成功即已自动刷新生成目录）
4. trigger_save - 保存更改
```

### 4. 创建校验函数（Validator）

```
1. trigger_list_validator_files（可选 env）— 确认目标 env 下 Validator 模块与文件名
2. trigger_get_validator_file（可选）— 查看某 Validator 文件下已有文件夹/函数
3. trigger_create_validator — 传入 env、静态函数 code；parentPath 可省略（落到 Validator 根）或指向 Validator 文件树内路径（成功即已自动刷新生成目录）
4. trigger_save — 保存地图数据
5. 若需重命名/删除/禁用 Validator 内函数，或**仅替换校验函数体**：**`trigger_rename`** / **`trigger_delete`** / **`trigger_set_enabled`** / **`trigger_replace_function_body`** 须带 **`scope: "validator"`**；每次写操作成功即自动刷新生成目录，最后仍须 **`trigger_save`** 持久化
```

### 5. 创建 Preset（枚举预设）或 CustomEvent（自定义事件）

```
1. trigger_list_files / trigger_get_file（可选）— 确认目标文件与文件夹
2. trigger_create_preset 或 trigger_create_custom_event — 传 env + code（parentPath 可省略）；须符合 SKILL 中该工具的形态约定（成功即已自动刷新生成目录）
3. trigger_save — 保存地图数据
```

## 注意事项

1. **保存**: 修改后需要调用 `trigger_save` 将触发器数据写入地图工程
2. **代码生成**: 各写操作（创建、删除、重命名、启用/禁用、**替换函数体**等）**成功返回前** MCP 会自动刷新 **`src/TriggerGenerated/`**；无需再调已移除的 `trigger_generate_code`。若生成步骤失败，工具会以 **`isError`** 返回（节点可能已改内存，须按错误信息处理）
3. **环境分离**: 注意选择正确的环境 (Common/Client/Server)
4. **路径准确性**: 确保路径准确，区分大小写
5. **依赖库**: 如果修改了依赖库，需要设置 `saveDependLibs: true`
6. **MCP 传入的 C#（创建函数/校验函数/变量/类/触发器/预设枚举/自定义事件等，以及 `trigger_replace_function_body` 的 `code`）**: 语法层面基本按标准 C# 理解，主要须符合各写入工具的**声明形态、包装位置与节点约定**；详见下方 **「传入代码的形态约束」**。创建类工具在成功返回前**会**自动写 **`src/TriggerGenerated/`**；仍建议对照生成文件与传入 `code` 做人工校验，并在适当时机 **`trigger_save`**。
7. **串行调用**: 创建及会修改触发器状态的其它操作（重命名、删除、启用/禁用、**替换函数体**、保存等）**不要并行**，须等上一调用返回后再发起下一调用；详见下方 **「并发与调用顺序」**。

## 错误处理

### JSON-RPC 与 `tools/call` 结果（两层别混淆）

- **JSON-RPC 层**：`tools/call` **正常执行完毕**时，RPC 仍多为 **`result`** 对象（**不是** JSON-RPC 顶层的 **`error`**）。只有缺工具名、工具未注册、传输异常等才会走 JSON-RPC **`error`**。
- **MCP `tools/call` 的 `result` 体**：形如 **`{ "content": [...], "isError"?: boolean }`**（见 **`MCPToolCallResult`**）。**自动化必须先读 `isError`**：
  - **`isError === true`**：工具侧判定为失败；**再**把 **`content[0].text`** 当作 **JSON 字符串** 解析（见下节「业务失败体」）。
  - **`isError` 为 `false` 或省略**：工具正常返回；**`content[0].text`** 一般为 **JSON 字符串**（如 **`{ "success": true, ... }`** 或列表等），按成功路径解析即可。

### 业务成功体（`isError` 为假）

**`content[0].text`** 解析后常见：

```json
{ "success": true, "message": "...", ... }
```

（部分只读工具可能是 JSON 数组，无 `success` 字段，以具体工具为准。）

### 业务失败体（`isError` 为真，`trigger_*` 与注册表未找到工具）

自 **`TriggerEditorTools`** / **`ToolRegistry`** / **`MCPServer` 工具异常兜底** 起，**`content[0].text`** 为 **JSON 字符串**（UTF-8 文本），结构为：

```json
{
  "success": false,
  "message": "Cannot add to path: ...",
  "errorCode": "cannot_add_to_path",
  "details": { "parentPath": "...", "env": "Common" }
}
```

- **`message`**：人类可读说明（与旧版纯文本文案一致或为其超集）。
- **`errorCode`**：稳定机器可读码（**可选**；逐步覆盖）。常见：**`cannot_add_to_path`**（父路径无法解析）、**`folder_name_already_used`**、**`cannot_add_to_parent`**（如库根拒绝）、**`tool_not_found`**、**`tool_handler_exception`**。
- **`details`**：附加字段（**可选**），如 **`parentPath`**、**`env`**、**`name`**、**`tree`**（Validator）等。

**其它 MCP 工具集**（如 **`data_*`**）若仍返回**纯文本** `content[0].text`，以该工具实现为准；**`trigger_*`** 已统一为上述 JSON 失败体。

常见错误：

- **MCP 未连接 / 拒绝 / 超时** → 执行 **`ai/tools/Invoke-SceMcp.ps1`**（见文首示例，**无需** **`docs/.sdk-version`**）；需要 Cursor 长期连接时在工作区根配置 **`mcp.json`**（与 Host 端口一致）并提示重载。
- **「地图仍在加载」** → **`GET /health`** 等到 **`mapReady: true`**（`loading` 时不要启第二个 Host）。
- `Trigger editor not available` - 编辑器未打开触发器模块
- `Node not found: xxx` - 路径不存在
- `Cannot add to path: xxx in env ... Must be a file or folder.` — 普通库下 **`parentPath` 首段不是该 `env` 的 LibModule 文件名**（须与 **`trigger_list_files`** 一致），或路径无法解析到文件/文件夹；常见于把「仅 `env`、无 `parentPath` 的 `trigger_create_folder`」得到的**单层文件夹名**当作 **`parentPath` 根**。处理见上文 **「`parentPath` 的合法根」** 与 **`trigger_create_folder`**。Validator 侧文案为 **`... Validator tree`**。
- 当前地图在指定环境下**没有 Validator 模块** - 无法使用 `trigger_create_validator`（详见工具返回文案）

---

# MCP 工具参考

## 调用工具之前

**`trigger_*`** 仅在端点就绪且地图已加载时有意义；独立 Host 以 **`/health` 的 `mapReady`** 为准。连不上时优先文首 **PowerShell 脚本**；**`loading`** 时轮询 **`/health`**，勿重复启 Host。

## 并发与调用顺序（会修改触发器时）

**所有创建类、创建触发器、创建 Preset/CustomEvent、创建文件夹、重命名、删除、启用/禁用、替换函数体（`trigger_replace_function_body`）**（即会改动触发器编辑器内节点与数据结构的 MCP 调用）**不得并行**：必须**等上一个调用完全结束**（收到返回）后，再发起下一个。同一时刻只应有一个此类工具在执行。

同理，**会修改触发器状态**的其它工具（如 **重命名、删除、启用/禁用、替换函数体、保存** 等）与创建类操作**混用**时，也应**串行**调用，避免多路并发导致状态不一致。

只读查询（如 `trigger_list_files`、**`trigger_list_validator_files`**、`trigger_get_file`、`trigger_search` 等）在实现允许的前提下可与上述串行要求分开考虑；但若与写操作穿插，仍建议**先完成写操作再查询**，或严格按「一写一读」顺序，由调用方自行保证。

---

## 查询操作

### `trigger_list_files`

列出所有触发器文件。

**参数**:

- `env` (可选): 环境过滤 - "Common", "Client", "Server"

**示例调用**:

```json
{ "env": "Common" }
```

**返回**:

```json
[
  { "name": "MainTriggers", "path": "MainTriggers", "env": "Common", "nodeCount": 15 },
  { "name": "ClientUI", "path": "ClientUI", "env": "Client", "nodeCount": 8 }
]
```

---

### `trigger_get_file`

获取文件的详细内容。

**参数**:

- `filePath` (必需): 文件名

**示例调用**:

```json
{ "filePath": "MainTriggers" }
```

---

### `trigger_list_validator_files`

列出当前地图在指定环境下的 **Validator 校验器模块**文件（与普通 `trigger_list_files` 对称，**不包含**触发器模块侧 LibModule）。

**参数**:

- `env` (可选): 环境过滤 - "Common", "Client", "Server"；省略则返回三个环境的 Validator 文件

**返回**: 与 `trigger_list_files` 相同结构（`name`、`path`、`env`、`nodeCount`）。

---

### `trigger_get_validator_file`

获取 **Validator 侧**某一文件的树形概要（与 `trigger_get_file` 对称，仅在 **`GetValidatorFileList`** 中按文件名查找）。

**参数**:

- `filePath` (必需): Validator 模块中的**文件名**（路径首段，与 `trigger_create_validator` 的 `parentPath` 首段一致）

**返回**: 与 `trigger_get_file` 类似；另含 **`"tree": "validator"`** 便于区分。

---

### `trigger_search`

搜索节点。

**参数**:

- `query` (必需): 搜索关键词
- `nodeType` (可选): 与资源树节点 **CLR 类型名**一致；MCP Schema 枚举为 **`Trigger`**、**`Function`**、**`Variable`**、**`Class`**、**`CustomEvent`**、**`All`**（未列入枚举的节点类型如 **`Preset`** 时，可用 **`All`** 再在结果里按 **`type`** 筛选，或以宿主实际校验为准）
- `env` (可选): 环境过滤
- `scope` (可选): **`trigger`**（默认，仅普通触发器模块树）、**`validator`**（仅 Validator 模块树）、**`all`**（两者；结果总数仍受服务端上限约束，通常最多约 50 条）。**勿**使用已废弃的 `library` 字符串。

**返回**: 每项除 `name`、`type`、`path`、`env` 外，含 **`tree`**: **`"trigger"`** 或 **`"validator"`**（`scope` 为 `all` 时用于区分）。

**示例调用**:

```json
{ "query": "Player", "nodeType": "Trigger" }
```

```json
{ "query": "IsValid", "nodeType": "Function", "scope": "validator", "env": "Common" }
```

---

## 触发器支持的 C# 语法范围

通过 MCP 写入的 `code` 会由**触发器编辑器**解析，再生成回 C#。现在不要再把它理解成“只支持一小部分 C# 语法”的白名单系统：常见 C# 语法通常都应按标准 C# 书写和解析。若工具返回错误，优先排查**声明形态、包装位置、目标节点、命名空间、依赖引用、签名匹配**等问题，而不是先假定某个语法天然不支持。

### LINQ、容器与 BCL API

- **LINQ 不再列为禁用项**：查询表达式、`System.Linq` 扩展方法（如 `Where`、`Select`、`OrderBy`、`ToList`、`Any`、`First` 等）可以按普通 C# 使用；实际能否通过生成工程编译，取决于目标环境的 `using`、程序集引用和类型上下文。
- `System.Collections.Generic` 里的 **`List<T>`、`Dictionary<TKey,TValue>`、`HashSet<T>`** 等容器可按普通 C# 容器使用，包括成员访问、方法调用、索引器、集合初始化器等。BCL API 的可用性以目标生成工程实际引用和编译结果为准。

### 表达式与语句

- 默认按常规 C# 写：字面量、括号、赋值与复合赋值、算术/比较/逻辑运算、一元运算、`++` / `--`、条件访问 `?.`、空合并 `??`、三元 `?:`、强制转换、`as` / `is` / 模式匹配、`typeof` / `default`、字符串插值、数组/对象/集合初始化、元组、lambda、switch 表达式、`await` 等都不需要因为触发器而主动改写。
- 编辑器再生成代码时可能调整格式、展开部分写法、重排局部变量，或生成与手写不同但语义等价的代码；对照 `src/TriggerGenerated/` 核对语义即可。

### 如何确认「某系统 / API 是否可用」

- **`trigger_search`**：在**资源树**里按 **`query` 对节点名做子串匹配**（触发器 / 校验器下的 **Function、Class、Trigger** 等）。适合判断地图里**是否已有同名或含关键字的节点**可作参照；**不会**扫描函数体里的 API 文本。
- **更可靠的依据**：① **`trigger_create_*` / 编辑器**返回的**解析诊断**；② 在 **`src/TriggerGenerated/`** 或工作区对标识符做**全文搜索**，看是否已有同类调用；③ 必要时对生成工程做编译验证。API 能否使用通常由目标工程引用、命名空间和类型上下文决定。

---

## 传入代码的形态约束（解析与再生成）

通过 MCP **写入**的 C#（如 `trigger_create_function` / `trigger_create_validator` / `trigger_create_variable` / `trigger_create_class` / `trigger_create_trigger` / **`trigger_create_preset`** / **`trigger_create_custom_event`** 的 `code`）会由**触发器编辑器**解析为内部逻辑，再在保存/生成阶段**写回 C#**。语法层面基本按标准 C# 处理；为了让工具知道要创建哪类触发器节点，仍须满足各工具的**外层声明形态**和**包装约定**，例如函数须能放进 `Scope`，校验函数须能放进 `partial class Validator`，自定义事件须满足对应事件类约定。

创建类写操作在**业务成功返回前**会由 MCP **自动**刷新 **`src/TriggerGenerated/`**；**`trigger_save`** 仍用于将触发器树等**持久化到地图工程**（与生成输出是不同步骤）。**建议校验**：在资源管理器或 IDE 中打开上述目录下的 **`common.cs`、`client.cs`、`server.cs`**（按所选 `env` 关注对应文件；Validator 相关在子目录中）。用**本次创建的函数名、校验函数名、变量名、类名、触发器名、枚举名或自定义事件类名**搜索，将生成结果与 MCP 传入的 `code` **对照**，确认控制流与表达式是否**大体一致**（生成风格可能与手写略有差异，属正常现象）。

遇到解析、再生成或编译失败时，**以工具返回的错误或诊断为准**。多数情况下应先检查节点路径、声明签名、命名空间、引用、可见性、泛型约束和包装位置；确认为语法问题时再按诊断简化写法。

### 语句块结构

- 可按常规 C# 在需要的位置声明局部变量，不需要为了编辑器刻意把所有局部变量提前到块首。
- 再生成代码可能会按编辑器风格重排局部变量或格式，只要语义一致即可。

### 语句可用范围

- 按常规 C# 语句书写即可。解析失败时按返回信息定位：先确认外层包装和上下文，再按诊断改写。

### `for` 循环

- 可使用常规 `for` 写法，包括 `i++` / `++i` / `i--`、复合赋值以及常见循环条件。
- 如果某个复杂循环头触发诊断，再按工具提示拆成更简单的初始化、条件或迭代表达式。

### 表达式可用范围

- 表达式默认按标准 C# 处理；不需要主动避开 LINQ、lambda、条件访问、空合并、三元、字符串插值、强制转换或集合初始化等常见写法。
- API 可用性主要取决于生成工程的引用和命名空间。幂运算等库调用可直接使用 `System.Math.Pow` 等标准 API；如工具诊断或编译结果指出上下文缺失，再补引用或改写。

### 函数与字段

- **函数**（`trigger_create_function` 与 `trigger_create_validator`）：须为 `public static …`，并满足目标环境的返回类型、参数类型、泛型约束和引用要求。块体与表达式体都可按标准 C# 使用。
- **仅替换函数体**（`trigger_replace_function_body`）：`code` 为**单方法**，方法名**必须**为 **`TempFunctionBody`**，且与目标函数**签名一致**（见该工具说明）；其余形态约束与同环境 **`trigger_create_function` / `trigger_create_validator`** 一致。
- **静态字段**（`trigger_create_variable`）：字段声明须能放进 `Scope` 类；初始化式按常规 C# 解析。

### 小结

不要为了迎合过时的限制说法主动降级代码。先写清晰、合法的 C#；再用工具诊断和生成文件确认节点创建、再生成与编译结果。只有在诊断明确指出某处无法解析或无法映射时，才有针对性地简化写法。

---

## 创建操作

适用于：`trigger_create_function`、`trigger_create_validator`、`trigger_create_variable`、`trigger_create_class`、`trigger_create_trigger`、**`trigger_create_preset`**、**`trigger_create_custom_event`** 中的 **`code`**（其中 Preset/CustomEvent 的约定见各自工具小节）。**`trigger_replace_function_body`** 的 **`code`** 同样须遵守上一节 **「传入代码的形态约束（解析与再生成）」**（单方法、名为 `TempFunctionBody`）。类成员、触发器 `_Execute` 方法体与条件/语句按常规 C# 书写；**`trigger_create_custom_event`** 另须满足 **主构造 + `Events.ITriggerEvent<自身>`** 等解析器硬性约定（见下）。

### `parentPath` 与默认路径（创建）

凡带 **`parentPath`** 的创建类工具，该参数**一律可选**。未传或留空时，多数工具将节点添加到**当前地图库**在 **`env` 所指环境**下的**库模块根目录**（该环境下的顶层触发器文件列表根，与「只传 `env` 的 `trigger_create_function`」一致）。

- 已带 **`env`** 的工具（如 `trigger_create_function`、`trigger_create_class`、`trigger_create_trigger`、**`trigger_create_preset`**、**`trigger_create_custom_event`**）：省略 `parentPath` 时用该 **`env`** 的**普通库模块**根目录。
- **`trigger_create_validator`**：省略 `parentPath` 时，节点添加到该 **`env`** 下的 **Validator 模块根目录**（与普通 **LibModule（触发器模块）** 并列的校验器文件树；若当前地图在该环境下没有 Validator 模块，工具会报错）。
- **`trigger_create_folder`**：另带可选 **`env`**；仅在**省略 `parentPath`** 时使用。若也不传 **`env`**，则按 **Common** 环境的库根处理。**若要链式调用 `trigger_create_*`**，**不要**依赖「仅 `env`、无 `parentPath`」在库根创建的文件夹作为下一跳的 **`parentPath` 根**；见上文 **「`parentPath` 的合法根」** 与 **`trigger_create_folder`** 小节的链式示例与 **`path` 字段说明**。

传了 **`parentPath`** 时，仍为「文件名/文件夹/…」层级路径；`trigger_create_validator` 的路径应落在 **Validator 文件列表**（用 **`trigger_list_validator_files`** / **`trigger_get_validator_file`** 核对；若不确定路径，可先省略 `parentPath` 落到 Validator 根再整理）。未在文档里单独写「默认路径」的其它工具，均按普通库模块根目录规则理解即可。

---

### `trigger_create_class`

根据类源码创建 **Class** 节点（与 `trigger_create_function` 一致：`parentPath` 可选、`env` 与 `code` 必填）。成功后 MCP **自动**刷新生成代码至 **`src/TriggerGenerated/`**；**`trigger_save`** 用于持久化地图数据。解析器取源码中**首个** `class` / `struct` / `record` 声明，并解析成员与方法体（见 `ClassParser.ClassFromSymbolFull`）。**不要**把类型写在 `partial class Scope { }` 里（与 `trigger_create_function` 不同；`code` 会置于 `GameEntry` 命名空间而非 `Scope` 内）。

**参数**:

- `parentPath` (可选): 父节点路径（文件或文件夹）。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 类声明源码，例如 `"public class DamageHelper { public static int Add(int a, int b) { return a + b; } }"`。若未写 `namespace`，则自动加上 `namespace GameEntry;`（文件作用域命名空间）。类内成员与方法体按常规 C# 书写，并须遵守上文 **「传入代码的形态约束（解析与再生成）」**。

**示例调用**:

```json
{ "parentPath": "MainTriggers/Utils", "env": "Server", "code": "public class DamageHelper { public static int Add(int a, int b) { return a + b; } }" }
```

```json
{ "env": "Common", "code": "public class MyHelper { private static int X() { return 1; } }" }
```

**返回**（成功时）: `success`、`name`、`path`、`message`（无 `codeGeneration` 字段；成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_trigger`

根据单个触发器的 C# 代码创建 **Trigger** 节点（与 `trigger_create_class` 一致：`parentPath` 可选、`env` 与 `code` 必填）。成功后 MCP **自动**刷新生成代码；**`trigger_save`** 用于持久化。

**约定概要**：

- 源码中**第一个**类型声明为 `partial class Scope`（可带 `: GameCore.BaseInterface.IGameClass`）；若 `code` 仅含类体成员，工具会自动包进 `namespace GameEntry;` 与该 `Scope` 声明。
- 类内需要 **1 个 static 触发器属性或字段**，它的名字就是触发器名。
- 类内需要 **2 个同名配套函数**：`<触发器名>_Execute` 和 `<触发器名>_Initializer`。
- `<触发器名>_Execute` 就是**触发器触发后执行的函数**，直接写触发后的逻辑即可。
- `<触发器名>_Initializer` 只负责**给触发器赋值**，并通过 `AddEvent<T>(...)` **添加事件**。
- `_Initializer` 中通常会出现 `new Events.Trigger<T>(<名>_Execute, false)`；其中构造函数第二个参数仍须为字面量 `false`。

**参数**:

- `parentPath` (可选): 父节点路径（文件或文件夹）。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 完整片段或仅 `Scope` 类体。须遵守上文 **「传入代码的形态约束（解析与再生成）」**；`_Execute` 内语句与表达式按常规 C# 书写，直接写触发后要执行的逻辑即可，**以工具返回为准**。

**示例调用**（仅示意结构，事件类型与注册目标须与当前地图编译集一致）:

```json
{
  "parentPath": "MainTriggers/Combat",
  "env": "Common",
  "code": "private static async System.Threading.Tasks.Task<bool> OnUnitCreate_Execute(object sender, GameCore.Event.EventUnitCreate e) { Game.Logger.LogInformation(\"unit created\"); return true; } public static Events.ITrigger OnUnitCreate { get; set; } = null!; public static void OnUnitCreate_Initializer() { OnUnitCreate = new Events.Trigger<GameCore.Event.EventUnitCreate>(OnUnitCreate_Execute, false); OnUnitCreate.AddEvent<GameCore.Event.EventUnitCreate>(GameCore.GameSystem.Game.Instance); }"
}
```

**返回**（成功时）: `success`、`name`、`path`、`message`（无 `codeGeneration` 字段；成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_function`

创建新函数。

**参数**:

- `parentPath` (可选): 父节点路径。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 函数代码。代码会被放到 `Scope` 类中进行解析，且函数必须是静态函数。须遵守上文 **「传入代码的形态约束（解析与再生成）」**；语句与表达式按常规 C# 书写，**以工具返回为准**。

**示例调用**:

```json
{ "parentPath": "MainTriggers/Utils", "env": "Server", "code": "public static int CalculateDamage(int a, int b) { return a + b; }" }
```

```json
{ "env": "Common", "code": "public static System.Collections.Generic.List<int> BuildValues(int a, int b) { return new System.Collections.Generic.List<int> { System.Math.Max(a, b) }; }" }
```

**返回**（成功时）: `success`、`name`、`path`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_validator`

在 **Validator** 模块中创建**校验函数**节点。语义与 `trigger_create_function` 几乎相同：解析路径用 **`partial class Validator`**（而非 `Scope`），且必须是**静态函数**。成功后 MCP **自动**刷新生成输出（含 Validator 相关文件）；**`trigger_save`** 用于持久化。

**参数**:

- `parentPath` (可选): 父节点路径，须指向 **Validator 侧**的文件或文件夹。省略时添加到当前地图在该 **`env`** 下的 **Validator 模块根目录**（见上文「`parentPath` 与默认路径」）
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 校验函数代码。实现侧会包进 `GameEntry` 下的 `partial class Validator` 再解析（若 `code` 已含 `partial class Validator` 则不再嵌套）。须为静态函数，且须遵守上文 **「传入代码的形态约束（解析与再生成）」**；语句与表达式按常规 C# 书写，**以工具返回为准**。

**错误**（常见）: 当前地图在指定环境下**没有 Validator 模块**时，会返回明确错误（无法创建）。

**示例调用**:

```json
{ "parentPath": "ValidatorMain/Checks", "env": "Server", "code": "public static bool IsHpValid(int hp) { return hp >= 0; }" }
```

```json
{ "env": "Common", "code": "public static bool NonNegative(int x) { return x >= 0; }" }
```

**返回**（成功时）: `success`、`name`、`path`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_variable`

根据代码创建新变量。

**参数**:

- `parentPath` (可选): 父节点路径。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 变量声明代码。代码会被放到 `Scope` 类中进行解析，且必须是静态字段，例如 `"public static int PlayerScore = 0;"`。初始化表达式按常规 C# 解析，并须遵守上文 **「传入代码的形态约束（解析与再生成）」**；**以工具返回为准**。

**示例调用**:

```json
{ "parentPath": "MainTriggers/Global", "env": "Common", "code": "public static int PlayerScore = 0;" }
```

**返回**（成功时）: `success`、`name`、`path`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_preset`

根据 **枚举**源码创建 **`Preset`** 节点（与 `trigger_create_class` 一致：`parentPath` 可选、`env` 与 `code` 必填）。成功后 MCP **自动**刷新生成代码；**`trigger_save`** 用于持久化。解析器取源码中**首个** `enum` 声明（`PresetParser` / `ParsePresetFromCode`）。`code` 会置于 **`GameEntry`** 命名空间（若未写 `namespace` 则自动补 `namespace GameEntry;`，与 `trigger_create_class` 相同）。

**参数**:

- `parentPath` (可选): 父节点路径（文件或文件夹）。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 枚举声明源码，须含 `enum`；可用 `public enum`。枚举成员须为**带数值常量的 public/protected 字段**才会进入预设项（与解析器一致）。

**示例调用**（与单元测试 `Preset_CustomEvent_P.ParsePresetFromCode_Success_ChineseEnumMembers` 结构一致，可按项目改名）:

```json
{
  "env": "Common",
  "code": "public enum 测试预设值\n{\n    属性A,\n    属性B\n}"
}
```

```json
{
  "parentPath": "MainTriggers/Data",
  "env": "Common",
  "code": "public enum MyPreset { OptionA, OptionB }"
}
```

**返回**（成功时）: `success`、`name`、`path`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_custom_event`

根据源码创建 **`CustomEvent`** 节点（`parentPath` 可选、`env` 与 `code` 必填）。成功后 MCP **自动**刷新生成代码；**`trigger_save`** 用于持久化。**仅支持**下列形态，否则工具返回解析诊断（`ParseCustomEventFromCode`）：

- 源码中**第一个**类型声明须为 **`class`**（不支持 `interface` / `struct` / `record`）。
- **类名右侧须有主构造参数列表** `(...)`（可为 `()` 或带参数；多参数时按形参名匹配绑定主构造）。
- 须实现 **`Events.ITriggerEvent<当前类>`**，且泛型实参**必须为当前类自身**。
- 主构造对应的 **`Function` 只写入模型的 `EventCreator`**，**不**写入 `EventCreators`（与解析器设计一致）。

`code` 置于 **`GameEntry`**（未写 `namespace` 时自动补全，与 `trigger_create_class` 相同）。**不要**把该类写在 `partial class Scope { }` 内。

**参数**:

- `parentPath` (可选): 父节点路径。省略时见上文「`parentPath` 与默认路径」
- `env` (必需): 环境，支持 "Common" / "Client" / "Server"
- `code` (必需): 自定义事件类源码，须含与主构造参数对应的 **public 属性**（与生成器/编辑器习惯一致）。

**示例调用**（与单元测试 `Preset_CustomEvent_P.ParseCustomEventFromCode_Success_PrimaryCtorAndProperty` 结构一致；事件类型与项目引用须与当前地图编译集一致）:

```json
{
  "env": "Common",
  "code": "public class 测试事件(string 新参数) : Events.ITriggerEvent<测试事件>\n{\n    public string 新参数 { get; set; } = 新参数;\n}"
}
```

```json
{
  "parentPath": "MainTriggers/Events",
  "env": "Server",
  "code": "public class OnCustomSignal(string payload) : Events.ITriggerEvent<OnCustomSignal> { public string Payload { get; set; } = payload; }"
}
```

**返回**（成功时）: `success`、`name`、`path`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

### `trigger_create_folder`

在资源树中创建 **Folder** 节点，仅用于编辑器内分组；**不**改变生成代码中的命名空间或目录结构。成功后 MCP **自动**刷新生成代码；**`trigger_save`** 仍须单独调用以持久化。

**两种挂接位置**：

1. **省略 `parentPath`，只传（或默认）`env`**：文件夹挂在当前库在该环境下的**环境模块根内容**下。此类位置**不能**稳定地作为后续 **`trigger_create_*`** 的 **`parentPath`**——若下一调用把 **`parentPath` 写成仅该文件夹名**，通常会失败并返回 **`Cannot add to path: <parentPath> in env <Env>. Must be a file or folder.`**（首段必须是 **`trigger_list_files`** 中的 **LibModule 文件名**，见上文 **「`parentPath` 的合法根」**）。
2. **传入 `parentPath`**：父级为**已有 LibModule 文件名**或该文件下的文件夹路径；与后续创建工具使用的路径模型一致，**可链式使用**。

**成功返回**：JSON 中含 **`path`**（本次文件夹的节点路径字符串）。**给自动化 / AI 的用法**：应用 **`path` 判断文件夹落在哪条链上**——只有形如 **`某LibModule文件名/子路径/文件夹名`** 的 **`path`**，才适合直接（或截断到某一级文件夹）作为下一 **`parentPath`**。若 **`path`** 只有单层名字、且**不是** `trigger_list_files` 里的文件名，**不要**把它当作 **`trigger_create_*` 的根**；应改为 **`parentPath = "<列表中的文件名>"`** 后重新建夹或移动整理。

**参数**:

- `parentPath` (可选): 父节点路径（文件或文件夹）。省略时见上文「`parentPath` 与默认路径」
- `env` (可选): 仅在省略 `parentPath` 时生效，默认 Common
- `name` (必需): 文件夹名称

**示例调用**:

```json
{ "parentPath": "MainTriggers", "name": "AI" }
```

```json
{ "env": "Client", "name": "UIHelpers" }
```

**链式创建（推荐）**：假定 **`trigger_list_files`** 中已有 **`GameEntry`**（请按你地图实际文件名替换）。**串行**调用。

1. 在文件节点下建夹：

```json
{ "parentPath": "GameEntry", "name": "CodexMcpTest_181055" }
```

2. 用 **`GameEntry/…`** 作为父路径继续创建（示例为函数；其它 **`trigger_create_*`** 同理）：

```json
{ "parentPath": "GameEntry/CodexMcpTest_181055", "env": "Common", "code": "public static int Demo() { return 1; }" }
```

3. 按需 **`trigger_save`** 持久化；可用 **`trigger_search`** / **`trigger_get_file`** 核对完整路径（写操作成功时已自动刷新生成目录）。

**反例（易失败）**：`{ "env": "Common", "name": "CodexMcpTest_xxx" }` 后直接 `{ "parentPath": "CodexMcpTest_xxx", "env": "Common", ... }` —— **`parentPath` 根必须是 LibModule 文件名**，不能是仅库根下新建的文件夹名。

---

## 修改操作

### `trigger_rename`

重命名普通触发器树或 **Validator** 树中的节点（**不**修改节点内 C# 逻辑）。**已有函数仅改函数体**时优先用 **`trigger_replace_function_body`**；其它大范围改逻辑仍见上文「代码生成与等价修改」（**`trigger_delete`** + **`trigger_create_*`**）。

**行为要点**（与实现一致）：

- **`newName`** 会 **Trim**；与**同一父列表**下已有兄弟节点**不能重名**（与同目录 **`trigger_create_*`** 规则一致）；仅大小写或空白变化时若与自身等价则允许。
- 父节点须为列表容器；**根级 LibModule 文件**等无列表父级时**不能**通过本工具重命名（会返回错误）。
- 成功后 MCP **自动**刷新生成代码至 **`src/TriggerGenerated/`**；**`trigger_save`** 仍须单独调用以持久化地图数据。

**参数**:

- `nodePath` (必需): 节点路径
- `newName` (必需): 新名称
- `scope` (可选): **`trigger`**（默认，普通触发器模块树）或 **`validator`**（Validator 模块内路径）

**示例调用**:

```json
{ "nodePath": "MainTriggers/Combat/OldName", "newName": "NewName" }
```

```json
{ "nodePath": "ValidatorMain/Checks/OldFn", "newName": "NewFn", "scope": "validator" }
```

**返回**（成功时）: `success`、`oldName`、`newName`、`path`、`message`

---

### `trigger_delete`

删除节点。成功后 MCP **自动**刷新生成代码，**`src/TriggerGenerated/`** 与当前树一致（例如已删除符号会从生成代码中移除）；**`trigger_save`** 仍须单独调用以持久化。

**参数**:

- `nodePath` (必需): 节点路径
- `scope` (可选): **`trigger`**（默认，普通触发器模块树）或 **`validator`**（Validator 模块内路径）

**示例调用**:

```json
{ "nodePath": "MainTriggers/Combat/UnusedTrigger" }
```

```json
{ "nodePath": "ValidatorMain/UnusedFn", "scope": "validator" }
```

---

### `trigger_set_enabled`

启用或禁用节点。成功后 MCP **自动**刷新生成代码至 **`src/TriggerGenerated/`**；**`trigger_save`** 仍须单独调用以持久化。

**参数**:

- `nodePath` (必需): 节点路径
- `enabled` (必需): 是否启用
- `scope` (可选): **`trigger`**（默认）或 **`validator`**

**示例调用**:

```json
{ "nodePath": "MainTriggers/Debug/TestTrigger", "enabled": false }
```

```json
{ "nodePath": "ValidatorMain/SomeCheck", "enabled": false, "scope": "validator" }
```

---

### `trigger_replace_function_body`

**仅替换**已有 **静态函数**或 **Class 成员函数**的**函数体**（**不**改名、**不**改签名）。服务端用与创建函数相同的方式把 **`code`** 包进 **`partial class Scope`**（普通触发器模块）、**`partial class Validator`**（Validator 模块）或目标 **Class** 名（类成员方法），解析出首个方法；该方法在源码中**必须**命名为 **`TempFunctionBody`**，且 **`static` / `async`、返回类型、类型参数个数、参数类型与 `params` 等**须与资源树里 **`functionName`** 所指目标函数**完全一致**，否则工具报错。成功后 MCP **自动**刷新生成代码至 **`src/TriggerGenerated/`**；**`trigger_save`** 仍须单独调用以持久化。

**`parentPath`（必需）**：父容器路径（首段为 Lib 文件名，与 **`trigger_create_*`** 一致）：

- **Scope 内静态函数**（库根或文件夹下）：指向该函数所在的**文件**或**文件夹**（例如 `MainTriggers` 或 `MainTriggers/Utils`）。
- **Class 成员函数**：指向包含该方法的 **Class 节点**（例如 `MainTriggers/Helpers/MyClass`），**不是** `…/MyClass/方法名` 的完整节点路径。

**`functionName`（必需）**：资源树中要改体的函数的**真实名称**（不是 `TempFunctionBody`）。

**`env`（必需）**：`Common` / `Client` / `Server`。

**`code`（必需）**：单个方法声明片段；方法名须为 **`TempFunctionBody`**，函数体为新逻辑。须遵守上文 **「传入代码的形态约束（解析与再生成）」**。

**`scope`（可选）**：**`trigger`**（默认）或 **`validator`**。在 **Validator 模块**内替换校验函数时须 **`scope: "validator"`**。

**重载**：若同一父列表下存在多个同名重载，工具会用解析出的 **`TempFunctionBody`** 签名匹配**唯一**目标；0 个或多个匹配时会失败。

**示例调用**（普通库下某静态函数 `Calculate`，父路径为 `MainTriggers/Utils`）：

```json
{
  "parentPath": "MainTriggers/Utils",
  "functionName": "Calculate",
  "env": "Common",
  "code": "public static int TempFunctionBody(int a, int b) { return a * b; }"
}
```

**示例调用**（Validator 内函数 `IsNonNegative`）：

```json
{
  "parentPath": "ValidatorMain/Checks",
  "functionName": "IsNonNegative",
  "env": "Server",
  "scope": "validator",
  "code": "public static bool TempFunctionBody(int x) { return x >= 0; }"
}
```

**返回**（成功时）: `success`、`parentPath`、`functionName`、`path`（一般为 `parentPath/functionName`）、`scope`、`message`（成功返回前已自动刷新生成目录；**`trigger_save`** 仍须单独调用以持久化）。

---

## 保存与自动生成

写操作（**`trigger_create_*`**、**`trigger_delete`**、**`trigger_rename`**、**`trigger_set_enabled`**、**`trigger_replace_function_body`**）在**业务成功返回前**会由 MCP **自动**将当前模型生成到 **`src/TriggerGenerated/`**（与编辑器内「生成代码」一致）。**不再提供**独立的 **`trigger_generate_code`** 工具。

### `trigger_save`

保存触发器更改到地图工程（与上述自动生成是不同步骤；修改后仍应适时 **`trigger_save`**）。

**参数**:

- `saveDependLibs` (可选): 是否保存依赖库，默认 false

**示例调用**:

```json
{ "saveDependLibs": false }
```

---

### `trigger_get_editor_state`

获取编辑器状态。

**参数**: 无

**返回**:

```json
{
  "currentLib": "MainTriggers",
  "needsSave": true,
  "needsCodeGeneration": true,
  "lastCodeGeneration": "2024-01-15T10:30:00Z",
  "fileCount": { "Common": 5, "Client": 3, "Server": 2 }
}
```

whenToUse: 当需要通过 MCP 创建/编辑/查询触发器脚本、验证触发器项目、或操作触发器编辑器时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

## 测试工具（MCP Server）

以下 **`mcp_*`** 由 MCP Server **其它模块**注册，**不属于**上文 **`trigger_*`** 清单；是否可用取决于宿主是否暴露整套 MCP。

### `mcp_run_tests`

运行完整单元测试套件：

```json
{
  "category": "trigger",
  "verbose": true
}
```

`category`: `"all"` | `"data"` | `"trigger"`。

**返回**:

```json
{
  "summary": "10/12 tests passed",
  "totalTests": 12,
  "passed": 10,
  "failed": 2,
  "durationMs": 1234,
  "failedTests": [
    { "name": "TestName", "error": "Error message" }
  ]
}
```

### `mcp_test_quick`

快速验证 MCP 连接：

```json
{}
```

**返回**:

```json
{
  "summary": "Quick test: 4/4 passed",
  "passed": 4,
  "failed": 0,
  "tests": [
    { "test": "data_list_tables", "status": "PASS" },
    { "test": "trigger_list_files", "status": "PASS" }
  ]
}
```
