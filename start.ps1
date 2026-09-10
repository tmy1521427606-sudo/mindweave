$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.Sockets.TcpListener]::new(
  [System.Net.IPAddress]::Loopback,
  0
)
try {
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
} finally {
  $listener.Stop()
}
$url = "http://127.0.0.1:$port/"
$databasePath = [System.IO.Path]::GetFullPath((Join-Path $siteRoot 'var\cognitive-daily.sqlite'))
$chatConfigured = -not [string]::IsNullOrWhiteSpace($env:ARK_API_KEY) -and -not [string]::IsNullOrWhiteSpace($env:DOUBAO_CHAT_MODEL)
$webSearchConfigured = -not [string]::IsNullOrWhiteSpace($env:TAVILY_API_KEY)
$chatStatus = if ($chatConfigured) { '豆包：已配置' } else { '豆包：未配置' }
$webSearchStatus = if ($webSearchConfigured) { '联网搜索：已配置' } else { '联网搜索：未配置' }

$serverOutput = [System.IO.Path]::GetTempFileName()
$serverError = [System.IO.Path]::GetTempFileName()
$server = $null
Push-Location $siteRoot
try {
  try {
    $server = Start-Process -FilePath node -ArgumentList @('.\server.mjs', '--port', $port) -WorkingDirectory $siteRoot -WindowStyle ([System.Diagnostics.ProcessWindowStyle]::Hidden) -PassThru -RedirectStandardOutput $serverOutput -RedirectStandardError $serverError
  } catch {
    throw '本地服务未能启动，请检查 Node.js 是否可用后重试。'
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $health = Invoke-WebRequest -Uri "${url}api/health" -TimeoutSec 1
      if ($health.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
    }
    if ($server.HasExited) {
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) {
    throw '本地服务未能启动，请检查 Node.js 和端口后重试。'
  }

  Start-Process $url
  Write-Host "知脉 MindWeave 已打开：$url"
  Write-Host $chatStatus
  Write-Host $webSearchStatus
  Write-Host "知识库：$databasePath"
  Wait-Process -Id $server.Id
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $serverOutput, $serverError -ErrorAction SilentlyContinue
  Pop-Location
}
