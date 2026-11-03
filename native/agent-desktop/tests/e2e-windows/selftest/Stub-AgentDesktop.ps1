#Requires -Version 5.1

<#
    Stub-AgentDesktop.ps1 - canned-envelope stand-in for agent-desktop.exe,
    reachable only from selftest/. Emits scripted JSON from a per-test rule
    table (AGENT_DESKTOP_E2E_STUB_SCRIPT: a .psd1 with a `Rules` array of
    `{ Match, Responses }`), matching the joined argument line against each
    rule's wildcard `Match` pattern in file order and returning the next
    entry in that rule's `Responses` queue (clamped to the last entry once
    exhausted). Call counts are persisted per rule in
    AGENT_DESKTOP_E2E_STUB_STATE, a small JSON file, because each invocation
    is a fresh child process with no memory of the last one - this is what
    lets a self-test script a status that changes only on, say, the third
    read.
#>

$ErrorActionPreference = 'Stop'

$scriptPath = $env:AGENT_DESKTOP_E2E_STUB_SCRIPT
if (-not $scriptPath -or -not (Test-Path -LiteralPath $scriptPath)) {
    Write-Output '{"version":"2.3","ok":false,"command":"stub","error":{"code":"INTERNAL","message":"Stub-AgentDesktop: AGENT_DESKTOP_E2E_STUB_SCRIPT is not set or missing"}}'
    exit 1
}

$config = Import-PowerShellDataFile -Path $scriptPath
$argv = $args -join ' '

$matchedRule = $null
foreach ($rule in $config.Rules) {
    if ($argv -like $rule.Match) { $matchedRule = $rule; break }
}
if (-not $matchedRule) {
    $escaped = $argv -replace '"', '\"'
    Write-Output ('{{"version":"2.3","ok":false,"command":"stub","error":{{"code":"INTERNAL","message":"Stub-AgentDesktop: no rule matched argv [{0}]"}}}}' -f $escaped)
    exit 1
}

$statePath = $env:AGENT_DESKTOP_E2E_STUB_STATE
$state = @{}
if ($statePath -and (Test-Path -LiteralPath $statePath)) {
    $raw = Get-Content -LiteralPath $statePath -Raw
    if ($raw) {
        $parsed = $raw | ConvertFrom-Json
        foreach ($property in $parsed.PSObject.Properties) { $state[$property.Name] = [int]$property.Value }
    }
}

$callIndex = 0
if ($state.ContainsKey($matchedRule.Match)) { $callIndex = $state[$matchedRule.Match] }
$responses = $matchedRule.Responses
$responseIndex = [Math]::Min($callIndex, $responses.Count - 1)
$state[$matchedRule.Match] = $callIndex + 1

if ($statePath) {
    ($state | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statePath -Encoding UTF8
}

Write-Output $responses[$responseIndex]
exit 0
