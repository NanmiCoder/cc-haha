#Requires -Version 5.1

<#
    Run-E2E.ps1 - the single process-terminating call in the scenario run
    tree. Scenario files return; only this script exits, and Write-Verdict
    never performs cleanup and never decides the exit code by itself - this
    script reads its boolean result and is the one place that turns it into
    a process exit code.

    Sequencing: isolated environment -> hashed read-only staged binary
    (R11) -> desktop lease (adopted or acquired, R15b) -> fixture launched
    detached and waited for by observation, never by a fixed sleep ->
    Preconditions -> Observation -> NonInterference -> Interaction ->
    Acceptance -> Reliability -> Surfaces -> ShellSurfaces ->
    TracePerformance -> Chromium -> SplitIntegrity -> CursorOverlay, with the
    fixture's process identity re-checked between each -> teardown ->
    Write-Verdict. The sequence array in Invoke-ScenarioSequence is the
    single source for the order.
#>
[CmdletBinding()]
param(
    [switch]$SelfTestSeedFailure,
    [string]$AgentDesktopBinary,
    [string]$FixtureBinary
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NativeDesktop.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NativeToken.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'StagedProcess.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'BoundedProcess.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'DesktopLease.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Harness.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Lib.psm1') -Force

$scenariosDir = Join-Path $PSScriptRoot 'scenarios'
. (Join-Path $scenariosDir 'Preconditions.ps1')
. (Join-Path $scenariosDir 'Observation.ps1')
. (Join-Path $scenariosDir 'NonInterference.ps1')
. (Join-Path $scenariosDir 'Interaction.ps1')
<#
    Acceptance.ps1 is dot-sourced before Surfaces.ps1
    deliberately: Surfaces.ps1's Invoke-SheetLifecycleLeg calls
    Get-MainFixtureWindowId, which Acceptance.ps1 defines and Surfaces.ps1
    does not redefine, so the load order is load-bearing.
#>
. (Join-Path $scenariosDir 'Acceptance.ps1')
. (Join-Path $scenariosDir 'Reliability.ps1')
. (Join-Path $scenariosDir 'Surfaces.ps1')
<#
    ShellSurfaces.ps1 registers explicitly like every scenario - the
    harness does not auto-discover, so an unregistered file is a silently
    skipped test. It takes no -App: the shell surfaces belong to the
    shell, not to the fixture.
#>
. (Join-Path $scenariosDir 'ShellSurfaces.ps1')
. (Join-Path $scenariosDir 'TracePerformance.ps1')
. (Join-Path $scenariosDir 'Chromium.ps1')
. (Join-Path $scenariosDir 'SplitIntegrity.ps1')
<#
    Registered last: it reaps its own renderer by session id in its
    own finally, but running after every other scenario keeps its (rare,
    force-killed-on-failure) leaks from ever being able to shadow an
    earlier scenario's own process/window observations.
#>
. (Join-Path $scenariosDir 'CursorOverlay.ps1')

$FixtureAppName = 'AgentDeskFixture.exe'

function Wait-ForFixtureReady {
    <# A newly spawned window is not steady the instant CreateProcess
       returns - polls `find --native-id fixture-root` to a deadline rather
       than sleeping a fixed duration. #>
    param([Parameter(Mandatory = $true)][string]$App, [int]$TimeoutSeconds = 20)
    $target = Find-Target -App $App -NativeId 'fixture-root' -TimeoutSeconds $TimeoutSeconds
    if (-not $target) {
        throw "Run-E2E.ps1: the fixture window never became observable within ${TimeoutSeconds}s"
    }
}

function Invoke-ScenarioSequence {
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)]$FixtureIdentity, [Parameter(Mandatory = $true)][string]$ManifestPath)
    $sequence = @(
        @{ Name = 'Preconditions'; Body = { Invoke-PreconditionsScenario -App $App -ManifestPath $ManifestPath } }
        @{ Name = 'Observation'; Body = { Invoke-ObservationScenario -App $App } }
        @{ Name = 'NonInterference'; Body = { Invoke-NonInterferenceScenario -App $App } }
        @{ Name = 'Interaction'; Body = { Invoke-InteractionScenario -App $App } }
        @{ Name = 'Acceptance'; Body = { Invoke-AcceptanceScenario -App $App } }
        @{ Name = 'Reliability'; Body = { Invoke-ReliabilityScenario -App $App } }
        @{ Name = 'Surfaces'; Body = { Invoke-SurfacesScenario -App $App } }
        @{ Name = 'ShellSurfaces'; Body = { Invoke-ShellSurfacesScenario } }
        @{ Name = 'TracePerformance'; Body = { Invoke-TracePerformanceScenario -App $App } }
        @{ Name = 'Chromium'; Body = { Invoke-ChromiumScenario } }
        @{ Name = 'SplitIntegrity'; Body = { Invoke-SplitIntegrityScenario -App $App } }
        @{ Name = 'CursorOverlay'; Body = { Invoke-CursorOverlayScenario -App $App } }
    )
    foreach ($scenario in $sequence) {
        if (-not (Test-FixtureProcessIdentity -Identity $FixtureIdentity)) {
            throw "Run-E2E.ps1: the fixture process identity changed before scenario '$($scenario.Name)' ran - it exited, crashed, or was replaced by a pid-recycled process"
        }
        Write-Host "Run-E2E.ps1: running scenario $($scenario.Name)"
        & $scenario.Body
    }
    if (-not (Test-FixtureProcessIdentity -Identity $FixtureIdentity)) {
        throw 'Run-E2E.ps1: the fixture process identity changed during the run'
    }
}

$exitCode = 1
$isolated = $null
$leaseHeld = $false
$fixtureHandle = $null
try {
    if ($SelfTestSeedFailure) {
        Register-Legs -Names @('seeded-failure')
        Add-Fail -Leg 'seeded-failure' -Reason 'Run-E2E.ps1 -SelfTestSeedFailure always fails, proving a failing leg reaches the process exit code'
        $ok = Write-Verdict
    } else {
        $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $sourceBinary = if ($AgentDesktopBinary) { $AgentDesktopBinary } else { Join-Path $repoRoot 'target\release\agent-desktop.exe' }
        $fixtureExe = if ($FixtureBinary) { $FixtureBinary } else { Join-Path $repoRoot 'tests\fixture-app-windows\build\AgentDeskFixture.exe' }
        $manifestPath = Join-Path (Split-Path -Parent $fixtureExe) 'AgentDeskFixture.ids.txt'

        $isolated = Enter-IsolatedEnvironment
        $stagedPath = Join-Path $isolated.SuiteRoot 'bin\agent-desktop.exe'
        $staged = Copy-ImmutableArtifact -Source $sourceBinary -Destination $stagedPath
        Set-TargetBinary -FilePath $staged.Path

        Enter-DesktopLease | Out-Null
        $leaseHeld = $true

        $noEffectInfo = Initialize-NoEffectWindow

        $fixtureEnvironment = @{}
        foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $fixtureEnvironment[[string]$entry.Key] = [string]$entry.Value }
        $fixtureEnvironment['AGENT_DESKTOP_FIXTURE_NO_ACTIVATE'] = '1'
        $fixtureHandle = Invoke-GuardedDetached -FilePath $fixtureExe -Environment $fixtureEnvironment
        $fixtureIdentity = Get-FixtureProcessIdentity -ProcessId $fixtureHandle.ProcessId
        if (-not $fixtureIdentity) {
            throw 'Run-E2E.ps1: the fixture process exited immediately after launch'
        }
        Wait-ForFixtureReady -App $FixtureAppName

        if (-not (Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $staged.Sha256)) {
            throw 'Run-E2E.ps1: the staged agent-desktop.exe hash no longer matches what was verified at staging time'
        }

        Invoke-ScenarioSequence -App $FixtureAppName -FixtureIdentity $fixtureIdentity -ManifestPath $manifestPath

        if (-not (Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $staged.Sha256)) {
            throw 'Run-E2E.ps1: the staged agent-desktop.exe hash changed during the run; the run is contaminated'
        }

        $ok = Write-Verdict -NoEffectWindowBootstrapUsed $noEffectInfo.BootstrapUsed
    }
    if ($ok) { $exitCode = 0 } else { $exitCode = 1 }
} catch {
    Write-Host "Run-E2E.ps1: aborting - $($_.Exception.Message)"
    $exitCode = 1
} finally {
    if ($fixtureHandle) { try { Stop-GuardedDetached -Handle $fixtureHandle } catch { Write-Warning "fixture teardown: $($_.Exception.Message)" } }
    if ($leaseHeld) { try { Exit-DesktopLease } catch { Write-Warning "lease teardown: $($_.Exception.Message)" } }
    if ($isolated) { try { Exit-IsolatedEnvironment } catch { Write-Warning "isolated-environment teardown: $($_.Exception.Message)" } }
}

exit $exitCode
