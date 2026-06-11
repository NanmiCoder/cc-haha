/**
 * Smart "Install all" script builder.
 *
 * The naive "Install all" path injects each install command as a
 * separate line through the PTY. That path has a fatal flaw on
 * Windows: when winget/scoop installs a tool into a directory that's
 * added to PATH, the running shell's PATH is NOT updated — so the
 * very next probe still reports "uvx not found" even though it just
 * got installed. Users see "successfully installed uv" followed by
 * "uvx: not found" and reasonably conclude the install broke.
 *
 * This module fixes that by emitting ONE Base64-encoded PowerShell
 * script that handles the whole flow inside a single PowerShell
 * process:
 *
 *   1. For each missing command:
 *      - Skip if already on PATH (handles repeat-clicks + partial state)
 *      - Walk the install options in declared order
 *      - For each option, first probe the manager itself (winget,
 *        scoop, choco) — skip the option if that manager isn't
 *        present, instead of letting the user see a cryptic
 *        "winget: command not found"
 *      - Run the install
 *      - Reload PATH from the registry (machine + user) into the
 *        current PowerShell process
 *      - Re-probe the command; if now present, mark this row done;
 *        else continue to the next option
 *      - If all options exhaust without success, mark the row failed
 *   2. Print a colored summary at the end.
 *
 * The rendered script is shown literally in the user's terminal
 * (encoded form, but the live progress output is plain text), so the
 * "watched automation" guarantee from the original Install-all
 * design is preserved — nothing happens off-screen.
 *
 * Currently Windows-only. Other platforms fall through to the
 * existing per-command injection path in
 * `terminalCommandInjection.ts`.
 */

import type {
  PluginPrerequisiteInstallStep,
  PluginPrerequisiteRow,
} from '../types/plugin'

export type SmartInstallPlanEntry = {
  /** The host command we want available on PATH (e.g. "uvx", "java"). */
  command: string
  /** Ordered list of installation attempts. */
  options: PluginPrerequisiteInstallStep[]
}

/**
 * Reduce a list of `PluginPrerequisiteRow`s to a smart-install plan
 * for the given platform. Skips rows that are already installed and
 * rows with no install steps for this platform.
 */
export function buildSmartInstallPlan(
  rows: ReadonlyArray<PluginPrerequisiteRow>,
  platform: 'win32' | 'darwin' | 'linux',
): SmartInstallPlanEntry[] {
  const plan: SmartInstallPlanEntry[] = []
  for (const row of rows) {
    if (row.installed) continue
    const steps = row.install?.[platform]
    if (!steps || steps.length === 0) continue
    plan.push({ command: row.command, options: steps })
  }
  return plan
}

/**
 * Escape a single-quoted PowerShell string literal. PowerShell
 * single-quoted strings only need escaping for the single quote
 * itself (doubled to ''). Used when inlining user-supplied install
 * commands into the script template.
 */
function psSingleQuote(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Some winget commands in plugin manifests omit the non-interactive
 * accept flags. The script appends them automatically so a fresh
 * winget invocation doesn't hang waiting for license confirmation.
 * Idempotent — re-adding flags that are already present is harmless.
 */
function ensureWingetNonInteractive(cmd: string): string {
  let next = cmd
  if (!/--accept-source-agreements/i.test(next)) next += ' --accept-source-agreements'
  if (!/--accept-package-agreements/i.test(next)) next += ' --accept-package-agreements'
  return next
}

/**
 * Build the PowerShell script text. Returned verbatim — caller
 * encodes for transport. The script intentionally has no external
 * file dependencies so it runs from a fresh `powershell.exe`
 * invocation with no profile.
 */
export function buildSmartInstallScript(
  plan: ReadonlyArray<SmartInstallPlanEntry>,
): string {
  if (plan.length === 0) {
    return '# nothing to install\n'
  }

  const planLiterals = plan
    .map((entry) => {
      const optionLiterals = entry.options
        .map((opt) => {
          const cmd =
            opt.manager.toLowerCase() === 'winget'
              ? ensureWingetNonInteractive(opt.cmd)
              : opt.cmd
          return `    @{ manager = '${psSingleQuote(opt.manager)}'; cmd = '${psSingleQuote(cmd)}' }`
        })
        .join('\n')
      return `  @{ command = '${psSingleQuote(entry.command)}'; options = @(
${optionLiterals}
  ) }`
    })
    .join('\n')

  return `
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

function Update-PathFromRegistry {
  try {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $combined = @($machine, $user) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd(';') }
    $env:Path = ($combined -join ';')
  } catch {}
}

function Test-Cmd($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Try-OneOption($cmd, $manager, $shellCmd) {
  Write-Host ''
  Write-Host ('  -> trying ' + $manager) -ForegroundColor Cyan
  Write-Host ('     $ ' + $shellCmd) -ForegroundColor DarkGray

  switch -Regex ($manager) {
    '^winget$'   { if (-not (Test-Cmd 'winget'))   { Write-Host '     skipped: winget not on PATH (install App Installer from Microsoft Store)' -ForegroundColor Yellow; return $false } ; break }
    '^scoop$'    { if (-not (Test-Cmd 'scoop'))    { Write-Host '     skipped: scoop not on PATH (https://scoop.sh)' -ForegroundColor Yellow; return $false } ; break }
    '^choco$'    { if (-not (Test-Cmd 'choco'))    { Write-Host '     skipped: chocolatey not on PATH (https://chocolatey.org)' -ForegroundColor Yellow; return $false } ; break }
    '^msys2?$'   { if (-not (Test-Cmd 'pacman'))   { Write-Host '     skipped: msys2/pacman not on PATH (https://www.msys2.org)' -ForegroundColor Yellow; return $false } ; break }
  }

  try {
    Invoke-Expression $shellCmd
  } catch {
    Write-Host ('     install threw: ' + $_.Exception.Message) -ForegroundColor Red
  }
  $exit = $LASTEXITCODE
  Update-PathFromRegistry

  if (Test-Cmd $cmd) {
    Write-Host ('     OK ' + $cmd + ' is now on PATH') -ForegroundColor Green
    return $true
  }
  Write-Host ('     X ' + $cmd + ' still not on PATH (exit ' + $exit + ')') -ForegroundColor Red
  return $false
}

$plan = @(
${planLiterals}
)

Write-Host ''
Write-Host ('=' * 65) -ForegroundColor DarkGray
Write-Host '  cc-haha smart installer' -ForegroundColor White
Write-Host ('  Checking ' + $plan.Count + ' missing prerequisite(s)') -ForegroundColor White
Write-Host ('=' * 65) -ForegroundColor DarkGray

Update-PathFromRegistry

$results = [ordered]@{}
foreach ($entry in $plan) {
  $cmd = $entry.command
  Write-Host ''
  Write-Host ('-> ' + $cmd) -ForegroundColor White

  if (Test-Cmd $cmd) {
    Write-Host '   already installed (skipping)' -ForegroundColor Green
    $results[$cmd] = 'already-installed'
    continue
  }

  $installed = $false
  foreach ($opt in $entry.options) {
    if (Try-OneOption $cmd $opt.manager $opt.cmd) {
      $installed = $true
      $results[$cmd] = ('installed-via-' + $opt.manager)
      break
    }
  }

  if (-not $installed) {
    Write-Host ('   FAILED: none of the install options produced ' + $cmd) -ForegroundColor Red
    $results[$cmd] = 'failed'
  }
}

Write-Host ''
Write-Host ('=' * 65) -ForegroundColor DarkGray
Write-Host '  Summary' -ForegroundColor White
Write-Host ('=' * 65) -ForegroundColor DarkGray
foreach ($k in $results.Keys) {
  $status = $results[$k]
  $color = if ($status -eq 'failed') { 'Red' } elseif ($status -like 'installed-*' -or $status -eq 'already-installed') { 'Green' } else { 'Yellow' }
  Write-Host ('  ' + $k.PadRight(14) + ' : ' + $status) -ForegroundColor $color
}

$failedCount = @($results.Values | Where-Object { $_ -eq 'failed' }).Count
Write-Host ''
if ($failedCount -gt 0) {
  Write-Host ('  ' + $failedCount + ' prerequisite(s) still missing.') -ForegroundColor Yellow
  Write-Host '  Open the cc-haha plugin modal again to see install hints, or visit' -ForegroundColor Yellow
  Write-Host '  each tool homepage for manual install.' -ForegroundColor Yellow
} else {
  Write-Host '  All prerequisites satisfied. Reload the plugin to start its MCP servers.' -ForegroundColor Green
}
Write-Host ''
`
}

/**
 * Encode a UTF-16LE PowerShell script body for use with
 * `powershell.exe -EncodedCommand`. PowerShell expects
 * UTF-16LE → Base64. Browser environments don't have a direct
 * UTF-16 → bytes path, so we hand-build the byte array.
 */
function encodePowerShellCommand(script: string): string {
  // UTF-16LE: 2 bytes per code unit, little-endian.
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const codeUnit = script.charCodeAt(i)
    bytes[i * 2] = codeUnit & 0xff
    bytes[i * 2 + 1] = (codeUnit >> 8) & 0xff
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/**
 * Compose the final terminal-injectable command line. Returned
 * string ends WITHOUT a trailing newline / `\r` — the caller (e.g.
 * `injectInstallScriptIntoNewTerminal`) appends `\r` itself.
 *
 * Uses `-NoProfile` to avoid surprises from a user's profile.ps1 +
 * `-ExecutionPolicy Bypass` so the encoded script runs even when
 * the machine policy is `Restricted`.
 */
export function buildSmartInstallCommandLine(
  plan: ReadonlyArray<SmartInstallPlanEntry>,
): string {
  const script = buildSmartInstallScript(plan)
  const encoded = encodePowerShellCommand(script)
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}
