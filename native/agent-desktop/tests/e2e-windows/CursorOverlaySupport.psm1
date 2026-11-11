#Requires -Version 5.1

<#
    CursorOverlaySupport.psm1 - pure, non-desktop-touching helpers for
    scenarios/CursorOverlay.ps1, split out purely to keep that scenario file
    under the 400-line cap (the same reason ChromiumStage.psm1 exists beside
    Chromium.ps1). Nothing here calls a Native*.psm1 entry point or
    Invoke-Guarded*/Invoke-Target directly at its OWN call sites other than
    Get-Target (not a rule09-tracked name), so rule09's Enter-Stage
    requirement - which scopes only to scenarios/** and walks the literal
    AST for named entry points - is unaffected by factoring these out; the
    actual native reads and product calls stay written directly inside
    CursorOverlay.ps1's own Enter-Stage bodies.

    No Import-Module of its own, deliberately: re-importing Harness.psm1 (or
    anything above it) with -Force would recreate those modules' script
    scopes and wipe DesktopLease.psm1's held-lease state, exactly the
    constraint LibShell.psm1 already documents for the same reason. The one
    function here that calls product code (Get-CursorOverlayElementCenter,
    via Get-Target) resolves it through the session state the importing
    suite already populated globally.
#>

Set-StrictMode -Version 2.0

function ConvertTo-CursorOverlayColorref {
    <#
    .SYNOPSIS
        A "#RRGGBB" string as the COLORREF (0x00bbggrr) GetPixel returns, so
        a leg compares its expected fill/rim colour against a real screen
        read without hand-computing byte order at every call site.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Hex)
    $clean = $Hex.TrimStart('#')
    if ($clean.Length -ne 6) { throw "ConvertTo-CursorOverlayColorref: '$Hex' is not a #RRGGBB colour" }
    $red = [Convert]::ToUInt32($clean.Substring(0, 2), 16)
    $green = [Convert]::ToUInt32($clean.Substring(2, 2), 16)
    $blue = [Convert]::ToUInt32($clean.Substring(4, 2), 16)
    return [uint32](($blue -shl 16) -bor ($green -shl 8) -bor $red)
}

function Get-CursorOverlayRestingPoint {
    <#
    .SYNOPSIS
        The primary monitor's work-area centre - mirrors
        crates/windows/src/system/cursor_overlay/monitors.rs's
        resting_point(), which is where the renderer places the cursor's
        pose on Enable, before any travel control ever arrives. This host is
        one monitor at one scale (A29-6), so .NET's own WorkingArea read
        needs no DPI correction to line up with the product's
        GetMonitorInfoW-derived work area.
    #>
    [CmdletBinding()]
    param()
    Add-Type -AssemblyName System.Windows.Forms
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    return [pscustomobject]@{
        X = [int]($area.Left + $area.Width / 2)
        Y = [int]($area.Top + $area.Height / 2)
    }
}

function Get-CursorOverlayInteriorOffsets {
    <#
    .SYNOPSIS
        A handful of points, relative to the cursor's pose (its dart's tip),
        that land inside the glyph's filled interior regardless of exact
        anti-aliasing at its edges - derived from
        crates/windows/src/system/cursor_overlay/geometry.rs's DART polygon
        (tip at local (1,5); the other three vertices put the polygon's own
        centroid around local (12,22)), spread across a few points rather
        than one exact pixel so the check does not depend on getting that
        derivation exactly right.
    #>
    [CmdletBinding()]
    param()
    return @(
        [pscustomobject]@{ X = 10; Y = 12 },
        [pscustomobject]@{ X = 14; Y = 18 },
        [pscustomobject]@{ X = 18; Y = 24 },
        [pscustomobject]@{ X = 10; Y = 28 },
        [pscustomobject]@{ X = 16; Y = 32 }
    )
}

function Get-CursorOverlayElementCenter {
    <#
    .SYNOPSIS
        The screen-space centre point of Target's own reported bounds -
        Get-Target -Property bounds -Raw, read the same way
        Interaction.ps1's focus oracle already reads bounds for its own
        independent cross-check.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Target)
    $bounds = Get-Target -Target $Target -Property 'bounds' -Raw
    return [pscustomobject]@{
        X = [int]([double]$bounds['x'] + [double]$bounds['width'] / 2)
        Y = [int]([double]$bounds['y'] + [double]$bounds['height'] / 2)
    }
}

function Get-CursorOverlayChildProcessesForSession {
    <#
    .SYNOPSIS
        Every agent-desktop.exe process whose command line carries both the
        --cursor-overlay-child argv flag and SessionId - the renderer's own
        reaper matcher: PowerShell 5.1 cannot read another process's
        environment block, so the child's argv (not its env marker) is the
        only channel a later process can enumerate from the outside.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$SessionId)
    $flagPattern = [regex]::Escape('--cursor-overlay-child')
    $sessionPattern = [regex]::Escape($SessionId)
    return @(Get-CimInstance Win32_Process -Filter "Name='agent-desktop.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $flagPattern -and $_.CommandLine -match $sessionPattern })
}

Export-ModuleMember -Function @(
    'ConvertTo-CursorOverlayColorref',
    'Get-CursorOverlayRestingPoint',
    'Get-CursorOverlayInteriorOffsets',
    'Get-CursorOverlayElementCenter',
    'Get-CursorOverlayChildProcessesForSession'
)
