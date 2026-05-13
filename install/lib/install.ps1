# install/lib/install.ps1 — PowerShell helpers for install.ps1 (T2.4).
# Functions: Write-Log, Write-Ok, Write-Err, Confirm-Action, Install-Tool,
#            Test-NodeOk, Start-AgentMail. Designed to be dot-sourced.

function Write-Log {
  param([Parameter(Mandatory=$true)][string]$Message)
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  if (Test-Path Variable:script:LogFile) { $line | Out-File -FilePath $script:LogFile -Append -Encoding utf8 }
  Write-Host $line
}

function Write-Ok  { param([string]$Message) Write-Log "[OK] $Message" }
function Write-Err { param([string]$Message) Write-Log "[ERR] $Message"; Write-Error $Message -ErrorAction Continue }

# Confirm-Action: returns $true under -Noninteractive or on Y/empty reply.
function Confirm-Action {
  param([Parameter(Mandatory=$true)][string]$Prompt)
  if (Test-Path Variable:script:Noninteractive) {
    if ($script:Noninteractive) { return $true }
  }
  $reply = Read-Host -Prompt "$Prompt [Y/n]"
  return ($reply -eq '' -or $reply -match '^[Yy]')
}

# Install-Tool: dispatch via winget or scoop. Throws if neither is present.
function Install-Tool {
  param([Parameter(Mandatory=$true)][string]$Name)
  $pkg = if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget' }
         elseif (Get-Command scoop  -ErrorAction SilentlyContinue) { 'scoop' }
         else { throw "Neither winget nor scoop found — install one and retry" }
  switch ($pkg) {
    'winget' { winget install --id "burningportra.$Name" --silent --accept-source-agreements --accept-package-agreements }
    'scoop'  { scoop install $Name }
  }
}

# Test-NodeOk: returns $true iff node is on PATH and major version >= 20.
function Test-NodeOk {
  $nodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }
  if (-not (Get-Command $nodeBin -ErrorAction SilentlyContinue)) {
    Write-Err "node not found — install with 'winget install OpenJS.NodeJS.LTS' or nvm-windows"
    return $false
  }
  $raw = & $nodeBin -v 2>$null
  if (-not $raw) { Write-Err "could not read node version"; return $false }
  if ($raw -notmatch '^v(\d+)') { Write-Err "could not parse node version: $raw"; return $false }
  $major = [int]$Matches[1]
  if ($major -lt 20) {
    Write-Err "Node $major < 20 — install with 'winget install OpenJS.NodeJS.LTS' or nvm-windows"
    return $false
  }
  Write-Ok "Node $raw"
  return $true
}

# Start-AgentMail: idempotent start of `am serve-http --port 8765` with
# 2-second poll on /health/liveness. Returns $true on success.
function Start-AgentMail {
  param([string]$LogDir = (Join-Path $HOME '.agent-flywheel'), [int]$Port = 8765)
  $url = "http://127.0.0.1:$Port/health/liveness"
  if (Test-AgentMailHealth -Url $url) {
    Write-Ok "agent-mail already running on :$Port"
    return $true
  }
  if (-not (Get-Command am -ErrorAction SilentlyContinue)) {
    Write-Err "am binary not found — install via 'winget install burningportra.agent-mail' (or use WSL2)"
    return $false
  }
  $logFile = Join-Path $LogDir 'agent-mail.log'
  Start-Process -WindowStyle Hidden -FilePath 'am' -ArgumentList 'serve-http','--port',"$Port" -RedirectStandardOutput $logFile -RedirectStandardError $logFile | Out-Null
  for ($i = 0; $i -lt 10; $i++) {
    if (Test-AgentMailHealth -Url $url) {
      Write-Ok "agent-mail HTTP service started on :$Port"
      return $true
    }
    Start-Sleep -Milliseconds 200
  }
  Write-Err "agent-mail did not respond on :$Port after 2s — see $logFile"
  return $false
}

function Test-AgentMailHealth {
  param([Parameter(Mandatory=$true)][string]$Url)
  try {
    $resp = Invoke-WebRequest -Uri $Url -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    return ($resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}
