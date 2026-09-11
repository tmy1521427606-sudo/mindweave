import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startScript = path.join(siteRoot, "start.ps1");
const databasePath = path.join(siteRoot, "var", "cognitive-daily.sqlite");
function harness({ healthReady = true, serverOutput = "server output format changed", assertWindowStyles = false } = {}) {
  const serverExited = !healthReady;
  return `
$global:healthReady = $${healthReady}
$global:serverOutput = '${serverOutput.replace(/'/g, "''")}'
$global:server = [pscustomobject]@{ Id = 123; HasExited = $${serverExited} }
$global:stopped = $false
$global:nodeStarted = $false
$global:nodeWindowStyle = $null
$global:nodeNoNewWindow = $false
$global:browserStarted = $false
$global:browserWindowStyle = $null
$global:assertWindowStyles = $${assertWindowStyles}
function Start-Process {
  param(
    [Parameter(Position = 0)][string]$FilePath,
    [object[]]$ArgumentList,
    [string]$WorkingDirectory,
    [switch]$PassThru,
    [switch]$NoNewWindow,
    [string]$WindowStyle,
    [string]$RedirectStandardOutput,
    [string]$RedirectStandardError
  )
  if ($FilePath -like 'http://*') {
    $global:browserStarted = $true
    $global:browserWindowStyle = $WindowStyle
    return
  }
  if ($FilePath -eq 'node') {
    $global:nodeStarted = $true
    $global:nodeWindowStyle = $WindowStyle
    $global:nodeNoNewWindow = [bool]$NoNewWindow
    [System.IO.File]::WriteAllText($RedirectStandardOutput, $global:serverOutput)
    [System.IO.File]::WriteAllText($RedirectStandardError, '')
    return $global:server
  }
  throw "Unexpected process: $FilePath"
}
function node { Write-Output $global:serverOutput }
function Invoke-WebRequest {
  param([string]$Uri, [int]$TimeoutSec)
  if (-not $global:healthReady) { throw 'connection refused' }
  return [pscustomobject]@{ StatusCode = 200 }
}
function Wait-Process { param([int]$Id) }
function Stop-Process {
  param([int]$Id, [switch]$Force)
  $global:stopped = $true
  $global:server.HasExited = $true
}
function Remove-Item {
  param([Parameter(Position = 0)][string[]]$Path)
  $global:removedPaths = @($Path)
  foreach ($item in $Path) { [System.IO.File]::Delete($item) }
}
& '${startScript.replace(/'/g, "''")}'
if ($global:nodeStarted -and $global:healthReady -and -not $global:stopped) { throw 'server was not stopped during teardown' }
if ($global:assertWindowStyles -and ($global:nodeWindowStyle -ne 'Hidden' -or $global:nodeNoNewWindow)) { throw 'node helper must request WindowStyle Hidden without NoNewWindow' }
if ($global:assertWindowStyles -and (-not $global:browserStarted -or -not [string]::IsNullOrEmpty($global:browserWindowStyle))) { throw 'browser must remain a visible Start-Process call' }
if ($global:removedPaths.Count -ne 2 -or @($global:removedPaths | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw "startup cleanup left temporary files: $($global:removedPaths -join ', ')" }
`;
}

function startWith(env, options) {
  assert.equal(existsSync(startScript), true, "start script must exist before its PowerShell harness runs");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", harness(options)], {
    cwd: siteRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(existsSync(startScript), true, "PowerShell harness must not remove the start script");
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/);
}

test("start script reports the safe contract when server console output changes", () => {
  const lines = startWith({
    ARK_API_KEY: "fake-ark-key",
    DOUBAO_CHAT_MODEL: "fake-chat-model",
    TAVILY_API_KEY: "fake-tavily-key",
  });

  assert.match(lines[0], /^知脉 MindWeave 已打开：http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(lines.slice(1), [
    "豆包：已配置",
    "联网搜索：已配置",
    "日报生成：已配置",
    `知识库：${databasePath}`,
  ]);
  assert.equal(lines.join("\n").includes("fake-"), false);
  assert.equal(lines.join("\n").includes("server output format changed"), false);
});

test("start script marks missing provider configuration without exposing values", () => {
  const lines = startWith({ ARK_API_KEY: "", DOUBAO_CHAT_MODEL: "", TAVILY_API_KEY: "" });

  assert.equal(lines[1], "豆包：未配置");
  assert.equal(lines[2], "联网搜索：未配置");
  assert.equal(lines[3], "日报生成：未配置");
  assert.equal(lines.join("\n").includes("fake-"), false);
});

test("start script hides the Node helper while leaving the browser visible", () => {
  const lines = startWith({ ARK_API_KEY: "", DOUBAO_CHAT_MODEL: "", TAVILY_API_KEY: "" }, { assertWindowStyles: true });

  assert.equal(lines.length, 5);
  assert.equal(lines[1], "豆包：未配置");
  assert.equal(lines[2], "联网搜索：未配置");
});

test("start script fails clearly without claiming readiness when health is unavailable", () => {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", harness({ healthReady: false })], {
    cwd: siteRoot,
    encoding: "utf8",
    env: { ...process.env, ARK_API_KEY: "", DOUBAO_CHAT_MODEL: "", TAVILY_API_KEY: "" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /本地服务未能启动/);
  assert.equal(result.stdout.includes("知脉 MindWeave 已打开"), false);
});
