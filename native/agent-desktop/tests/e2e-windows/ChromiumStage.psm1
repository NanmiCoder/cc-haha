#Requires -Version 5.1

<#
    ChromiumStage.psm1 - R14 precondition staging for the Chromium scenario,
    kept out of `scenarios/` so it is not subject to rule08 (every scenario
    file must call `Register-Legs`) or rule09 (every entry-point call must
    be lexically enclosed in `Enter-Stage`) - neither rule is meaningful for
    a module that implements primitives rather than authoring legs, the same
    reasoning `DesktopLease.psm1`/`BoundedProcess.psm1` are exempted from
    rule10 for. `scenarios/Chromium.ps1` still wraps every call here in its
    own `Enter-Stage` block, holding R13's discipline lexically even where
    the gate does not force it structurally.

    Nothing here touches a command envelope field (`.ok`/`.error`/
    `.disposition`/`.data`) or invokes the staged `agent-desktop.exe` -
    every action is a raw file write, `Start-Process`/`Get-Process` read,
    raw-Win32 foreground staging (`NativeDesktop.psm1`'s
    `Set-NativeForegroundWindow`/`Wait-NativeForegroundToSettle`, the same
    AttachThreadInput dance `crate::system::fixture::test_support::stage_foreground`
    uses), or real keystroke synthesis (`SendKeys`, which injects through
    `keybd_event`, never a posted message), matching R14's "the system
    under test is never its own oracle" for exactly the actions that decide
    whether content is staged: launching the target, picking its vault, and
    opening its note.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'NativeDesktop.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'ChromiumNative.psm1') -Force -Global

$script:ObsidianJsonPath = Join-Path $env:APPDATA 'obsidian\obsidian.json'
$script:ObsidianJsonBackupPath = $null
$script:ObsidianJsonBackedUp = $false

function Test-ChromiumTargetAvailable {
    <# The one target this box carries (A24-5/A24-6/A24-12): Obsidian,
       Electron. No browser is present under this grounding (G5). #>
    [CmdletBinding()]
    param()
    $obsidianExe = Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe'
    return (Test-Path -LiteralPath $obsidianExe -PathType Leaf)
}

function Get-ChromiumObsidianExePath {
    [CmdletBinding()]
    param()
    return (Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe')
}

function New-ChromiumScratchVault {
    <# A fresh vault every call (a GUID-suffixed directory), never a reused
       one - measured live building U12's probe: a reused vault directory
       can carry stale Obsidian-side state (its own app-registry cache)
       that outlives a fresh `.obsidian/app.json`, so "fresh" means a
       directory Obsidian has never seen, not merely an empty one. 30
       sections of heading + paragraph + two task-list checkboxes each
       measured (`A24-11`) at 234 nodes at depth >= 12 below the document
       root - comfortably past R18's 150-node floor. #>
    [CmdletBinding()]
    param()
    $vault = Join-Path ([IO.Path]::GetTempPath()) ('e2e-chromium-vault-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $vault -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $vault '.obsidian') -Force | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $vault '.obsidian\app.json'), '{"newFileLocation":"root","alwaysUpdateLinks":false}', $utf8NoBom)

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# E2E Chromium Content Note')
    $lines.Add('')
    for ($i = 1; $i -le 30; $i++) {
        $lines.Add("## Section $i")
        $lines.Add('')
        $lines.Add("Paragraph $i with **bold text**, *italic text*, and a [link](https://example.invalid/$i).")
        $lines.Add('')
        $lines.Add("- [ ] task item $i alpha")
        $lines.Add("- [ ] task item $i bravo")
        $lines.Add('')
    }
    [IO.File]::WriteAllText((Join-Path $vault 'content-note.md'), ($lines -join "`r`n"), $utf8NoBom)
    return $vault
}

function Set-ChromiumSoleVaultRegistry {
    <# Overwrites the real per-user `obsidian.json` so the vault Obsidian
       auto-opens on launch is deterministically this scratch vault -
       measured live: a command-line vault path argument is not honoured
       once any OTHER vault is already registered `"open": true"`, and
       Obsidian instead restores whichever vault its registry names. Backed
       up to a FILE, never held only in a variable, so a crash before
       `Restore-ChromiumVaultRegistry` runs still leaves a recoverable copy
       on disk. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$VaultPath)
    $parent = Split-Path -Parent $script:ObsidianJsonPath
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (Test-Path -LiteralPath $script:ObsidianJsonPath) {
        $script:ObsidianJsonBackupPath = Join-Path ([IO.Path]::GetTempPath()) ('e2e-chromium-obsidian-json-backup-' + [guid]::NewGuid().ToString('N') + '.json')
        Copy-Item -LiteralPath $script:ObsidianJsonPath -Destination $script:ObsidianJsonBackupPath -Force
        $script:ObsidianJsonBackedUp = $true
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $vaultKey = [guid]::NewGuid().ToString('N').Substring(0, 16)
    <# JSON escaping of a single literal backslash needs a two-character
       replacement ('\\' as a JSON string escape) - a four-character
       replacement over-escapes, decoding back to a doubled backslash
       between every path segment. Windows/Electron path resolution
       tolerates the doubled separator (measured live: the vault still
       opened), but the registry file this writes is not the JSON its own
       comment claims it to be, so it is corrected here regardless. #>
    $vaultEscaped = $VaultPath -replace '\\', '\\'
    $registry = '{"vaults":{"' + $vaultKey + '":{"path":"' + $vaultEscaped + '","ts":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"open":true}}}'
    [IO.File]::WriteAllText($script:ObsidianJsonPath, $registry, $utf8NoBom)
}

function Restore-ChromiumVaultRegistry {
    [CmdletBinding()]
    param()
    if ($script:ObsidianJsonBackedUp -and $script:ObsidianJsonBackupPath -and (Test-Path -LiteralPath $script:ObsidianJsonBackupPath)) {
        Copy-Item -LiteralPath $script:ObsidianJsonBackupPath -Destination $script:ObsidianJsonPath -Force
        Remove-ItemRecoverable -Path $script:ObsidianJsonBackupPath | Out-Null
    }
    $script:ObsidianJsonBackedUp = $false
    $script:ObsidianJsonBackupPath = $null
}

function Stop-ChromiumAllObsidian {
    [CmdletBinding()]
    param()
    Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue | ForEach-Object {
        try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
}

function Start-ChromiumObsidianOnVault {
    <# Kills any running Obsidian first - a running instance forwards argv
       to itself and ignores the registry `Set-ChromiumSoleVaultRegistry`
       just wrote - then launches and waits for a titled top-level window
       naming the vault's own folder leaf. The title carries the vault
       folder name only, never a full path, staying inside the corpus's
       safety envelope. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$VaultPath, [int]$TimeoutSeconds = 20)
    Stop-ChromiumAllObsidian
    Start-Sleep -Seconds 2
    $obsidianExe = Get-ChromiumObsidianExePath
    if (-not (Test-Path -LiteralPath $obsidianExe -PathType Leaf)) { return $null }
    $launched = Start-Process -FilePath $obsidianExe -PassThru
    $vaultLeaf = Split-Path -Leaf $VaultPath
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $proc = $null
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Contains($vaultLeaf) } |
            Select-Object -First 1
        if ($proc) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $proc) { return $null }
    return [pscustomobject]@{ ProcessId = $proc.Id; VaultLeaf = $vaultLeaf }
}

function Open-ChromiumNoteByQuickSwitch {
    <# Ctrl+O, type the note stem, Enter - through `SendKeys`, which injects
       via `keybd_event`: real synthesized input the OS delivers through
       normal input processing, never a message posted directly into a
       window's queue. Verified by title change, never assumed.

       Foreground is staged with `Set-NativeForegroundWindow`
       (AttachThreadInput + `AllowSetForegroundWindow`), never bare
       `AppActivate`: `AppActivate` is a bare `SetForegroundWindow`, and by
       the time this scenario runs the harness process has been alive
       through every earlier scenario - including Acceptance.ps1's own
       focus-steal legs - with no real user input of its own, which is
       exactly the "long-lived harness process loses the recent-input
       standing SetForegroundWindow requires" failure
       `Set-NativeForegroundWindow`'s own doc-comment measured live. A
       silently-declined `AppActivate` sends Ctrl+O/the note stem/Enter to
       whatever window Windows left in the foreground instead, so the
       quick-switch keystrokes land nowhere near Obsidian and the note never
       becomes the active tab.

       A leading `Invoke-ChromiumNativeEscape` guards a second, distinct
       failure of the same shape: measured live on this box, a stray shell
       popup (Explorer's own taskbar jump list, `ShellExperienceHost`) can
       be left holding the desktop foreground - by anything, including a
       stray right-click from an earlier automated run, not this suite's
       own doing - and `AttachThreadInput`/`AllowSetForegroundWindow` do
       not out-rank it; `Set-NativeForegroundWindow` returns false against
       it every time. A real Escape keystroke is exactly what dismisses
       that class of popup and costs nothing when there was nothing to
       dismiss, so it runs unconditionally rather than only after a first
       failed attempt is observed. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][string]$NoteStem, [int]$TimeoutSeconds = 10)
    Add-Type -AssemblyName System.Windows.Forms
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
    Invoke-ChromiumNativeEscape
    [void](Set-NativeForegroundWindow -WindowHandle $proc.MainWindowHandle)
    [void](Wait-NativeForegroundToSettle -RequiredStableReads 3 -BudgetSeconds 5)
    if ((Get-NativeForegroundWindowHandle) -ne $proc.MainWindowHandle) { return $false }
    [System.Windows.Forms.SendKeys]::SendWait('^o')
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait($NoteStem)
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowTitle -and $p.MainWindowTitle.StartsWith($NoteStem)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Get-ChromiumWindowRect {
    <# Raw `BoundingRectangle` off a live UIA element for the process's main
       window - the independent geometry a content-area right-click needs
       to target, read without going through the product. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { return $null }
    try {
        $ae = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        $r = $ae.Current.BoundingRectangle
        return [pscustomobject]@{ Left = [int]$r.Left; Top = [int]$r.Top; Right = [int]$r.Right; Bottom = [int]$r.Bottom }
    } catch {
        return $null
    }
}

function Test-ChromiumMenuFamilyReachable {
    <# Mirrors `uia_menu_reachable`'s UIA half: a root-level child of the
       pid with a reachable Menu/MenuBar/MenuItem descendant, read through
       `System.Windows.Automation` directly rather than the product. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
        $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
        $menuFamily = New-Object System.Windows.Automation.OrCondition(@(
                (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Menu)),
                (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuBar)),
                (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))
            ))
        foreach ($c in $children) {
            try {
                if ($null -ne $c.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $menuFamily)) { return $true }
            } catch { }
        }
    } catch { }
    return $false
}

function Find-ChromiumOtherInstalledShells {
    <# Deferral item 4's host-wide search, re-run this attempt rather than
       trusted from an earlier one: the standard install locations for
       every Chromium-family browser and Electron shell this corpus already
       names. #>
    [CmdletBinding()]
    param()
    $pf = $env:ProgramFiles
    $pfx86 = ${env:ProgramFiles(x86)}
    $lad = $env:LOCALAPPDATA
    $candidates = @(
        @{ Path = (Join-Path $pf 'Microsoft\Edge\Application\msedge.exe'); Name = 'edge' }
        @{ Path = (Join-Path $pf 'Google\Chrome\Application\chrome.exe'); Name = 'chrome' }
        @{ Path = (Join-Path $pfx86 'Google\Chrome\Application\chrome.exe'); Name = 'chrome_x86' }
        @{ Path = (Join-Path $pf 'BraveSoftware\Brave-Browser\Application\brave.exe'); Name = 'brave' }
        @{ Path = (Join-Path $lad 'Microsoft\Teams\current\Teams.exe'); Name = 'teams' }
        @{ Path = (Join-Path $lad 'Programs\Microsoft VS Code\Code.exe'); Name = 'vscode' }
        @{ Path = (Join-Path $lad 'slack\slack.exe'); Name = 'slack' }
    )
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($c in $candidates) {
        if ($c.Path -and (Test-Path -LiteralPath $c.Path -PathType Leaf)) { [void]$found.Add($c.Name) }
    }
    return [pscustomobject]@{ Searched = @($candidates | ForEach-Object { $_.Name }); Found = @($found) }
}

Export-ModuleMember -Function @(
    'Test-ChromiumTargetAvailable',
    'Get-ChromiumObsidianExePath',
    'New-ChromiumScratchVault',
    'Set-ChromiumSoleVaultRegistry',
    'Restore-ChromiumVaultRegistry',
    'Stop-ChromiumAllObsidian',
    'Start-ChromiumObsidianOnVault',
    'Open-ChromiumNoteByQuickSwitch',
    'Get-ChromiumWindowRect',
    'Test-ChromiumMenuFamilyReachable',
    'Find-ChromiumOtherInstalledShells'
)
