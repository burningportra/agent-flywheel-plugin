#Requires -Version 7
<#
.SYNOPSIS
  install.ps1 — bootstrap agent-flywheel on a fresh Windows machine.

.DESCRIPTION
  Native-Windows parity for install.sh. Logical step order matches install.sh:
    1. OS detect (WSL2 recommendation)
    2. Claude Code (winget/scoop install hint)
    3. Required CLIs (br, bv, cm, dcg — NTM is tmux-only and omitted here)
    4. Node check (>= 20)
    5. agent-mail HTTP service start
    6. CC commands handoff
    7. Optional Claude Code launch

.PARAMETER Noninteractive
  Run without prompts (CI mode).
.PARAMETER SkipLaunch
  Skip starting Claude Code at the end.
.PARAMETER SkipMcpRegister
  Skip registering the MCP plugin (reserved for future use).
.PARAMETER SkipAgentMail
  Skip starting / installing agent-mail.
#>
param(
  [switch]$Noninteractive,
  [switch]$SkipLaunch,
  [switch]$SkipMcpRegister,
  [switch]$SkipAgentMail,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help $PSCommandPath -Detailed
  exit 0
}

$LogDir = Join-Path $HOME '.agent-flywheel'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogFile = Join-Path $LogDir 'install.log'

# Source the shared helper library.
. (Join-Path $PSScriptRoot 'install/lib/install.ps1')

Set-Variable -Name LogFile -Value $LogFile -Scope Script
Set-Variable -Name Noninteractive -Value ([bool]$Noninteractive) -Scope Script

Write-Log "install.ps1 started: $(Get-Date -Format 'o')"
Write-Log "flags: noninteractive=$Noninteractive skip_launch=$SkipLaunch skip_mcp_register=$SkipMcpRegister skip_agent_mail=$SkipAgentMail"

# Step 1: OS detect
Write-Log "Step 1: OS detect"
if (Get-Command wsl -ErrorAction SilentlyContinue) {
  Write-Log "INFO WSL2 detected. For full multi-agent swarm features, consider:"
  Write-Log "    wsl -e bash -c 'curl -sSL <url>/install.sh | bash'"
  Write-Log "  Continuing with native Windows install (NTM will be unavailable)."
}

# Step 2: Claude Code
Write-Log "Step 2: Claude Code"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  if (Confirm-Action "Claude Code not found. Open install instructions?") {
    Write-Log "Install instructions: https://docs.anthropic.com/en/docs/agents/claude-code"
  } else {
    Write-Log "Skipping Claude Code install"
  }
} else {
  Write-Ok "Claude Code already installed"
}

# Step 3: Required CLIs (NTM omitted — tmux-only)
Write-Log "Step 3: Required CLIs"
$missing = @()
foreach ($t in 'br','bv','cm','dcg') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $missing += $t }
}
if ($missing.Count -gt 0) {
  Write-Log "Missing tools: $($missing -join ', ')"
  if (Confirm-Action "Install $($missing.Count) tool(s) ($($missing -join ', '))?") {
    foreach ($t in $missing) {
      try { Install-Tool -Name $t } catch { Write-Err "Failed to install $t (continuing): $_" }
    }
  } else {
    Write-Log "Skipping required-CLI install"
  }
} else {
  Write-Ok "All required CLIs (br/bv/cm/dcg) already on PATH"
}
Write-Log "INFO NTM is tmux-based; not available on native Windows. Use WSL2 for parallel swarm."

# Step 4: Node check
Write-Log "Step 4: Node check"
if (-not (Test-NodeOk)) {
  Write-Err "Node 20+ required — install via 'winget install OpenJS.NodeJS.LTS' or nvm-windows"
}

# Step 5: agent-mail
Write-Log "Step 5: agent-mail"
if (-not $SkipAgentMail) {
  if (Confirm-Action "Start agent-mail HTTP service on :8765?") {
    try { Start-AgentMail -LogDir $LogDir } catch { Write-Err "agent-mail failed to start (continuing): $_" }
  } else {
    Write-Log "Skipping agent-mail start (declined)"
  }
} else {
  Write-Log "Skipping agent-mail start (--SkipAgentMail)"
}

# Step 6: CC commands handoff
Write-Log "Step 6: CC commands"
Write-Host @"

[OK] Bootstrap complete. Now inside Claude Code, run:

  /plugin marketplace add burningportra/agent-flywheel-plugin
  /plugin install agent-flywheel@agent-flywheel
  /agent-flywheel:flywheel-setup

"@

# Step 7: Launch
Write-Log "Step 7: Launch"
if (-not $SkipLaunch -and -not $Noninteractive -and (Get-Command claude -ErrorAction SilentlyContinue)) {
  if (Confirm-Action "Launch Claude Code now?") {
    Start-Process claude
  }
}

Write-Ok "install.ps1 complete"
