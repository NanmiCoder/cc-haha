---
name: client-only-debug
description: Launch and diagnose SCE/WasiCore client-only debug mode without opening the editor. Use when an AI agent needs to start a pure client test process, verify UI/GameGraph/local tool behavior, compare editor-launched and standalone client debugging, or use the project-local docs/.client-only-debug.json launch config generated after opening the project in SCE Editor.
whenToUse: When launching WasiCore in client-only mode without the editor, verifying UI/GameGraph/local tool behavior, or diagnosing client-side issues independently.
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# SCE Client-Only Debug Skill

Use this skill to run a WasiCore map in pure client mode from an AI agent or shell. This starts the client runtime directly with `-client_only`; it does not start the editor UI, server, host connection, matchmaking, or CloudData.

## Preferred Tool

Prefer the project-local PowerShell helper when available. It is generated with this machine's launcher path and this project's client-only arguments:

```powershell
$ProjectRoot = "D:\Maps\MyMap"
$Script = Join-Path $ProjectRoot 'ai\tools\Start-SceClientOnlyDebug.ps1'
if (-not (Test-Path -LiteralPath $Script)) {
  $Script = Join-Path $ProjectRoot '.cursor\tools\Start-SceClientOnlyDebug.ps1'
}
if (-not (Test-Path -LiteralPath $Script)) {
  $Script = Join-Path "<WasiCoreSDK>" 'docs\ai\tools\Start-SceClientOnlyDebug.ps1'
}
$PowerShellExe = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if ([string]::IsNullOrWhiteSpace($PowerShellExe)) {
  $PowerShellExe = Get-Command powershell -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
}
& $PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script -ProjectRoot $ProjectRoot -ResolveOnly
& $PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script -ProjectRoot $ProjectRoot
```

If a project-local helper exists, prefer it. When using the SDK copy, always pass `-ProjectRoot`; the SDK copy only reads `docs\.client-only-debug.json`.
Replace `<WasiCoreSDK>` with the local SDK path before running the fallback command.

Use `-ResolveOnly` first when diagnosing path issues. It prints the selected executable, working directory, arguments, and log root without starting the game.
Current helpers also print the Runtime MCP bridge endpoint as `runtimeMcp.endpoint` and DLL freshness under `appBundleDeployment.*.needsDeploy`. The endpoint is a local SCE runtime TCP bridge, not a standalone standard MCP host.
After launch, prefer `clientProcessId` / `clientProcess` over `processId` when the fields are present. `processId` is kept for compatibility and may be the launcher process; the real game runtime is often a child `sce` process with `-client_only`, `-map_path=<ProjectRoot>`, and `-runtime_mcp_port=18765` in its command line.

## Launch Rules

Do not hard-code local install paths from another machine.

1. Prefer `<ProjectRoot>\ai\tools\Start-SceClientOnlyDebug.ps1`. It should already contain the launcher path and arguments.
2. `<ProjectRoot>\.cursor\tools\Start-SceClientOnlyDebug.ps1` is a compatibility mirror for Cursor-style workspaces; use it only when `ai\tools` is absent.
3. If using the SDK helper, it reads `<ProjectRoot>\docs\.client-only-debug.json`; it does not search the editor installation.
4. Treat `<ProjectRoot>\docs\.editor-root`, `.editor-api-version`, and `.editor-launcher` as compatibility records for troubleshooting only.
5. If the project-local helper or launch config is missing or stale, ask the user to open the project once in SCE Editor. Do not scan entire disks.

Paths may contain spaces and non-ASCII names; pass executable paths and arguments as separate values, not by raw string concatenation.

## Required Arguments

The client-only command must include:

```text
-env=game
-editor_server_debug
-client_only
-editor_api_version=<api version, usually 2000>
-game=<ProjectName from project/map_settings.json>
-map_kind=0
-map_path=<ProjectRoot>
-runtime_mcp_port=18765
```

`-editor_server_debug` is intentionally required even though the mode is client-only. It marks the process as editor debug mode, makes `Game.IsDebugTestMode` true, and opens write permission for the main project `user_files`.

`-runtime_mcp_port=18765` is the default Runtime MCP bridge port used by the editor. Older generated launch configs may omit it; the client can still open the default port later during Wasmtime startup, but including it makes the launch contract explicit.

Optional arguments:

- `-debug`: show the client debug console/HUD if useful.
- `-width=<pixels>` and `-height=<pixels>`: set the startup client window size, for example `-ExtraArgs @('-width=1280', '-height=720')` when using the helper.
- Extra engine arguments can be appended with the helper's `-ExtraArgs`.

## Build And AppBundle Deployment

The helper only starts the client process. It does not build the C# project and does not copy the latest `GameEntry.dll` into the runtime AppBundle.

When launching from SCE Editor's normal debug button, the editor build flow compiles both sides and copies DLLs into:

- `AppBundle/managed/GameEntry.dll` for server-side runtime code.
- `ui/AppBundle/managed/GameEntry.dll` for client-side runtime code.

When launching directly from an AI agent or shell after `dotnet build`, do the deploy step yourself before starting the client:

```powershell
$ProjectRoot = "D:\Maps\MyMap"
dotnet build (Join-Path $ProjectRoot "src\GameEntry.csproj") -c Server-Debug
dotnet build (Join-Path $ProjectRoot "src\GameEntry.csproj") -c Client-Debug
Copy-Item -LiteralPath (Join-Path $ProjectRoot "src\bin\Server-Debug\net9.0\GameEntry.dll") -Destination (Join-Path $ProjectRoot "AppBundle\managed\GameEntry.dll") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "src\bin\Client-Debug\net9.0\GameEntry.dll") -Destination (Join-Path $ProjectRoot "ui\AppBundle\managed\GameEntry.dll") -Force
```

If this copy step is skipped, the standalone client may run an older DLL even though `dotnet build` succeeded. This can produce misleading runtime symptoms, including Lua or UI initialization errors that do not match the code just compiled.

## Runtime Behavior

In C# client code:

```csharp
if (Game.IsClientOnly)
{
    // UI fake data, GameGraph preview, model/scene tests, local editor tools.
}
```

Client-only mode cannot use Entity, Unit, CloudData, server triggers, server AI, or client-to-server gameplay messages. Pure presentation Actor types such as `ActorSound`, `ActorModel`, and `ActorParticle`, plus GameGraph and UI, can be used for local preview flows.

When a client-only preview needs a game-data scene asset, call `Scene.GetOrCreate(ScopeData.GameDataScene.xxx).LoadClientOnly()` from a `#if CLIENT` and `Game.IsClientOnly` branch. If the preview should use the active GameMode's `DefaultScene`, prefer `Scene.LoadDefaultClientOnly()`. Projects that always need the default scene in client-only debug can set `AutoLoadDefaultSceneInClientOnly = true` on `GameDataGameMode`; it is off by default so UI-only and low-level GameGraph tests stay lightweight.

The main project `user_files` directory is writable in this mode because the launch includes `-editor_server_debug`. Dependency `deps/<lib>/user_files` directories and the AppBundle root remain read-only.

## Runtime MCP Inspection

When the editor MCP exposes `runtime_call_tool`, use it after the client-only process has started to inspect the live client instead of guessing from code or user descriptions.

Useful runtime tools:

- `debug.ping`: verify that the client runtime bridge is reachable and that `client_only` is true.
- `debug.list_tools`: list runtime tools registered inside the client, including project-specific tools.
- `debug.capture_screenshot`: save a live client screenshot to an explicit path for visual inspection. Pass `maxWidth` and `maxHeight` when a 1080p or 720p downscaled image is enough; omit them when inspecting fine text or pixel-level details.
- `ui.snapshot`: read the current GameUI control tree, including text, visibility, and pixel rects.
- `ui.find`: locate controls by text, name, type, or id.
- `ui.get_rect`: get one control's screen pixel position and size for layout adjustment.

If `runtime_call_tool` is not visible in the current AI tool list, use `ai/tools/Invoke-SceRuntimeMcp.ps1` as the direct TCP fallback. For example, run `ai/tools/Invoke-SceRuntimeMcp.ps1 -Ping -Wait`, then `ai/tools/Invoke-SceRuntimeMcp.ps1 -ListTools`, then call the needed runtime tool with `-Tool` and `-ArgumentsJson`.

For UI or local preview tasks, prefer this loop: build, deploy DLLs to AppBundle, launch client-only debug, call `debug.ping`, call `debug.capture_screenshot`, call `debug.list_tools`, call `ui.snapshot` or `ui.find`, adjust the UI code, then repeat. This gives the AI agent immediate runtime evidence of the game state and UI layout.

Canvas-only rendering may not appear in the GameUI control tree. In that case, use `debug.capture_screenshot` as the primary signal and only use UI tools for the surrounding GameUI controls.

## Verification

After launch, inspect logs under the selected executable's working directory:

```text
<WorkingDirectory>/logs/client
<WorkingDirectory>/logs/lua
<WorkingDirectory>/logs/game
```

The helper's JSON output includes `workingDirectory` and `logsRoot`; inspect logs from that location instead of guessing an install path.

Useful log keywords:

- `Client-only mode`
- `RunMode=ClientOnly`
- `WASI user_files main preopen`
- `writable[1]`

If the window is closed, the client process should exit. If a residual `SCE`/`sce` process remains, inspect the newest client/lua logs before killing it.
If an older helper reports a `processId` that exits quickly, do not conclude the client is gone until you have checked for a child or sibling `sce` process by command line. Use `Get-CimInstance Win32_Process` and filter on `-client_only`, `-map_path=<ProjectRoot>`, or `-runtime_mcp_port=18765`.
