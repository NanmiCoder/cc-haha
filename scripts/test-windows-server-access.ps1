param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3456,
  [string]$Token = "",
  [string]$SessionId = "android-probe",
  [int]$TimeoutSeconds = 8,
  [string]$Origin = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function New-AuthHeaders {
  $headers = @{}
  if ($Token.Trim().Length -gt 0) {
    $headers["Authorization"] = "Bearer $Token"
  }
  if ($Origin.Trim().Length -gt 0) {
    $headers["Origin"] = $Origin
  }
  return $headers
}

function Test-HttpHealth {
  $url = "http://${HostName}:${Port}/health"
  Write-Step "HTTP health check: $url"

  try {
    $response = Invoke-WebRequest `
      -Uri $url `
      -Method GET `
      -Headers (New-AuthHeaders) `
      -TimeoutSec $TimeoutSeconds `
      -UseBasicParsing

    Write-Pass "HTTP reachable. Status=$($response.StatusCode)"
    if ($response.Content) {
      Write-Host $response.Content
    }
    return $true
  } catch {
    Write-Fail "HTTP health check failed: $($_.Exception.Message)"
    if ($_.Exception.Response) {
      Write-Host "HTTP status: $([int]$_.Exception.Response.StatusCode)"
    }
    return $false
  }
}

function Test-WebSocket {
  $encodedSession = [Uri]::EscapeDataString($SessionId)
  $wsUrl = "ws://${HostName}:${Port}/ws/$encodedSession"
  if ($Token.Trim().Length -gt 0) {
    $wsUrl = "${wsUrl}?token=$([Uri]::EscapeDataString($Token))"
  }

  Write-Step "WebSocket handshake: $wsUrl"

  $client = [System.Net.WebSockets.ClientWebSocket]::new()
  if ($Origin.Trim().Length -gt 0) {
    $client.Options.SetRequestHeader("Origin", $Origin)
  }

  $cts = [System.Threading.CancellationTokenSource]::new()
  $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))

  try {
    $task = $client.ConnectAsync([Uri]$wsUrl, $cts.Token)
    $task.GetAwaiter().GetResult()

    if ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      Write-Pass "WebSocket connected."
      return $true
    }

    Write-Fail "WebSocket state is $($client.State), expected Open."
    return $false
  } catch {
    Write-Fail "WebSocket connection failed: $($_.Exception.Message)"
    return $false
  } finally {
    $client.Dispose()
    $cts.Dispose()
  }
}

Write-Host "Windows server access probe"
Write-Host "Target: http://${HostName}:${Port}"
if ($Token.Trim().Length -gt 0) {
  Write-Host "Auth: Bearer token provided"
} else {
  Write-Host "Auth: no token"
}

$httpOk = Test-HttpHealth
$wsOk = Test-WebSocket

Write-Host ""
if ($httpOk -and $wsOk) {
  Write-Pass "Server is reachable over HTTP and WebSocket."
  exit 0
}

Write-Fail "Probe failed."
Write-Host ""
Write-Host "Hints:"
Write-Host "- If Android/LAN access is required, the Windows server must bind 0.0.0.0 or the Windows LAN IP, not 127.0.0.1."
Write-Host "- If host is not 127.0.0.1, set SERVER_ACCESS_TOKEN and pass -Token."
Write-Host "- Open Windows Firewall for TCP port $Port."
Write-Host "- Test from another device with the Windows LAN IP, for example: -HostName 192.168.1.10 -Port $Port."
exit 1
