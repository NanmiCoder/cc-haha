---
name: debug-tools
description: Use SCE Editor MCP debug tools to start and stop normal editor debugging, start debug without compiling after manually building and deploying GameEntry.dll, run full resource statistics plus Humanoid animation bake before debug, and inspect the launched client through runtime_call_tool.
whenToUse: 当需要启动/停止 SCE 编辑器调试、执行资源统计、或通过 runtime_call_tool 检查运行时状态时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# SCE DebugTools MCP Skill

Use this skill when an AI agent needs to start or stop an editor debug session from MCP, choose between full compile debug and "debug without compile", run resource statistics plus Humanoid animation bake before debug, or inspect the live debug client through Runtime MCP.

## Tools

| Tool | Purpose |
|------|---------|
| `debug_start` | Runs the editor's normal debug flow: save map, compile GameEntry, then start debug. |
| `debug_start_no_compile` | Runs the editor's "debug without compile" flow: save map and start debug, but skip compile/deploy. |
| `debug_stop` | Requests the editor debug host to destroy the currently running embedded debug game. |
| `resource_statistics_generate_animations` | Runs Client-Resource resource statistics, refreshes `ref/model_animation.json`, and generates Humanoid baked animations into project `res/anim`. |
| `debug_start_with_resource_statistics` | Runs resource statistics and Humanoid animation bake first, then starts editor debug. Supports `skip_compile`. |
| `runtime_call_tool` | Calls one Runtime MCP tool inside the currently running debug client. The inner runtime tools are not listed in outer MCP `tools/list`. |

`debug_start` and `debug_start_no_compile` require the full SCE Editor MCP with an editor helper. They are not a replacement for independent `TriggerMcpHost`, and they are not useful if no editor project is open.

## Launching Full Editor MCP On A Map

If the editor is not already open, start the full SCE Editor with the target map/project directory and an MCP port:

```powershell
$EditorExe = "E:\WasmSCE\星火编辑器 公司内网.exe"
$ProjectRoot = "E:\NE\Res\maps\MyMap"
Start-Process -FilePath $EditorExe -ArgumentList @(
  "--mcp-port=8765",
  "-map_path=$ProjectRoot"
)
```

For a locally built editor, use that build's `SCE.exe` path, for example `E:\NE\Urho\vs_bgfx_editor_2026\bin\SCE.exe`. The full editor uses `-map_path=<ProjectRoot>` to load a map on startup. Do not use `-1map_path`; that form is only a local shortcut convention some users may use to disable an argument temporarily, not an automation contract.

Do not confuse this with `TriggerMcpHost`, whose standalone command line uses `--map`, or with pure client runtime debugging, whose spawned client process also contains `-map_path=<ProjectRoot>` but is not the full editor.

## Choosing The Start Tool

Use `debug_start` when the editor should own the whole build-and-launch flow. The MCP call confirms that the flow was requested; compile logs are not returned as structured MCP diagnostics, so inspect editor/build logs if launch fails.

Use `debug_start_no_compile` only after the agent or user has already built both configurations and deployed the latest DLLs into the runtime AppBundle. This is faster and is the right loop after small code edits when you want to control the build step yourself.

Use `debug_start_with_resource_statistics` when a debug session needs fresh resource statistics or Humanoid animation bake output before launch. Typical symptoms: a skill animation such as `dash.ani` is requested, official Humanoid source animation exists, but the project has no corresponding baked file under `res/anim/<ModelName>/...`.

Use `resource_statistics_generate_animations` when you only need to refresh `ref/model_animation.json` and baked Humanoid animations, without launching the game.

Do not spam either start tool. Wait for the editor/debug client to settle, then use `runtime_call_tool` to verify the runtime is reachable.

Use `debug_stop` after a debug verification run when the embedded editor game should be closed. Editor-internal debugging does not launch a separate game process that agents should kill manually.

```json
{ "tool": "debug_stop", "arguments": {} }
```

## Logs

For editor-internal debug runs, inspect wasm logs under the editor runtime directory:

- Server wasm logs: `E:\WasmSCE\logs\server`
- Client wasm logs: `E:\WasmSCE\logs\client`
- Lua/editor host logs are siblings under `E:\WasmSCE\logs`, such as `lua`, `game`, and `CSharp`.

When looking for script-side smoke output, search the newest server/client wasm logs first. Use `Game.FlushLogs()` in smoke code before ending a run when immediate log inspection matters.

## Humanoid Animation Bake Flow

For editor-debug animation failures, first distinguish source animation from baked animation:

1. Check whether the original Humanoid animation exists, for example `anim/.../dash.ani`.
2. Check whether the project contains the baked output under `res/anim/<ModelName>/...`.
3. If the source exists but the baked output is missing, call:

```json
{ "tool": "debug_start_with_resource_statistics", "arguments": {} }
```

To skip the later GameEntry compile after the resource step:

```json
{ "tool": "debug_start_with_resource_statistics", "arguments": { "skip_compile": true } }
```

If no launch is needed:

```json
{ "tool": "resource_statistics_generate_animations", "arguments": {} }
```

After the command, inspect `ref/model_animation.json`, `res/anim/<ModelName>/...`, the editor information panel, and the newest client log. Runtime logs now try to distinguish "original Humanoid animation missing" from "original exists but baked animation missing".

## No-Compile Build And Deploy

From the map project root:

```powershell
$ProjectRoot = "D:\Maps\MyMap"
dotnet build (Join-Path $ProjectRoot "src\GameEntry.csproj") -c Server-Debug
dotnet build (Join-Path $ProjectRoot "src\GameEntry.csproj") -c Client-Debug
Copy-Item -LiteralPath (Join-Path $ProjectRoot "src\bin\Server-Debug\net9.0\GameEntry.dll") -Destination (Join-Path $ProjectRoot "AppBundle\managed\GameEntry.dll") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "src\bin\Client-Debug\net9.0\GameEntry.dll") -Destination (Join-Path $ProjectRoot "ui\AppBundle\managed\GameEntry.dll") -Force
```

Then call:

```json
{ "tool": "debug_start_no_compile", "arguments": {} }
```

If the copy step is skipped, the launched client/server can run an old `GameEntry.dll` even though `dotnet build` just succeeded.

For the same open project, replacing `GameEntry.dll` does not require restarting the editor. Build and copy the DLLs, then call `debug_start_no_compile` again; the next debug run loads the current files.

When overriding framework DLLs such as `GameGraph.dll` during editor debugging, set `project/use_local_appbundle_config.txt` to `2` and copy the replacement DLLs into `AppBundle/managed` and `ui/AppBundle/managed`. Value `2` keeps the normal editor/update wasm runtime and base AppBundle, but loads same-name local DLL overrides. Use value `3` only for a full local AppBundle run where DLLs, BCL payload, and wasm files all come from the project AppBundle and the editor/update payload is skipped.

## Runtime MCP Inspection

After `debug_start` or `debug_start_no_compile`, call runtime tools through the outer MCP bridge:

```json
{
  "tool": "runtime_call_tool",
  "arguments": {
    "name": "debug.ping",
    "arguments": {},
    "port": 18765,
    "timeout_ms": 5000
  }
}
```

Useful runtime tool names commonly include:

- `debug.ping`: verify the client Runtime MCP bridge is reachable.
- `debug.list_tools`: list runtime tools registered inside the client.
- `debug.capture_screenshot`: save a live client screenshot.
- `ui.snapshot`: read the current GameUI control tree.
- `ui.find`: locate controls by text, name, type, or id.
- `ui.get_rect`: get one control's screen pixel rectangle.

Always prefer `debug.list_tools` as the source of truth for the current client. Project-specific tools may appear there, and unavailable tools should not be guessed.

If the outer editor MCP does not expose `runtime_call_tool`, use the project or SDK `ai/tools/Invoke-SceRuntimeMcp.ps1` fallback:

```powershell
.\ai\tools\Invoke-SceRuntimeMcp.ps1 -Ping -Wait
.\ai\tools\Invoke-SceRuntimeMcp.ps1 -ListTools
.\ai\tools\Invoke-SceRuntimeMcp.ps1 -Tool debug.capture_screenshot -ArgumentsJson '{"path":"RuntimeMcpScreenshots/ui.png","overwrite":true,"maxWidth":1280,"maxHeight":720}'
```

## Recommended Loop

1. Modify code or data.
2. Build and deploy DLLs yourself if using `debug_start_no_compile`; call `debug_start_with_resource_statistics` if resource statistics or Humanoid animation bake must run before launch; otherwise call `debug_start`.
3. Call `runtime_call_tool` with `debug.ping`.
4. Call `debug.list_tools`, then the specific runtime inspection tool.
5. Use screenshots, UI snapshots, logs, and runtime tool results as evidence before making the next change.
6. Call `debug_stop` to close the embedded editor debug game when the automated run is finished.

## Error Handling

For all MCP calls, check outer `result.isError` first.

`debug_start` and `debug_start_no_compile` usually return plain text. `runtime_call_tool` forwards the runtime response; if the inner runtime tool returns `{ "success": false, ... }`, the outer call marks `isError` and the `content[0].text` should be parsed as JSON.

Common failures:

- `Editor helper not available`: the full editor MCP is not attached to an open editor project.
- `client_runtime_unavailable`: no debug client is listening on the selected runtime bridge port, or debug startup has not finished.
- `debug_stop` only requests shutdown through the editor host. It does not forcibly kill external processes. The runtime bridge may still answer `debug.ping` after stop; treat `debug:false` with empty `game` / `map_path` as an inactive debug state rather than proof that the embedded game is still running.
- Stale DLL behavior after `debug_start_no_compile`: rebuild and copy both Server-Debug and Client-Debug `GameEntry.dll` files into AppBundle.
- Humanoid baked animation still missing after `debug_start_with_resource_statistics`: inspect `ref/model_animation.json`; if the requested animation is not listed, the model data or skill animation reference did not enter resource statistics.

## Related

- [SCE Editor MCP 工具速查](../../SCE_EDITOR_MCP_TOOLS.md)
- [纯客户端调试启动 Skill](../client-only-debug/SKILL.md)
- [Invoke-SceRuntimeMcp.ps1](../../tools/Invoke-SceRuntimeMcp.ps1)
