# Pester tests for install.ps1 / install/lib/install.ps1 (T2.4).
# Run with: pwsh -Command "Invoke-Pester install/test/test-install-ps1.Tests.ps1"

BeforeAll {
  $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
  $script:InstallPs1 = Join-Path $script:RepoRoot 'install.ps1'
  $script:InstallSh  = Join-Path $script:RepoRoot 'install.sh'
  $script:LibPs1     = Join-Path $script:RepoRoot 'install/lib/install.ps1'
}

Describe 'install.ps1 file presence and shape' {
  It 'install.ps1 exists at repo root' {
    Test-Path $script:InstallPs1 | Should -BeTrue
  }
  It 'install/lib/install.ps1 helper library exists' {
    Test-Path $script:LibPs1 | Should -BeTrue
  }
  It 'declares the four parity flags' {
    $content = Get-Content $script:InstallPs1 -Raw
    $content | Should -Match '\[switch\]\$Noninteractive'
    $content | Should -Match '\[switch\]\$SkipLaunch'
    $content | Should -Match '\[switch\]\$SkipMcpRegister'
    $content | Should -Match '\[switch\]\$SkipAgentMail'
  }
  It 'requires PowerShell 7+' {
    (Get-Content $script:InstallPs1 -Raw) | Should -Match '#Requires -Version 7'
  }
  It 'parses without syntax errors' {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($script:InstallPs1, [ref]$null, [ref]$errors)
    $errors | Should -BeNullOrEmpty
    [void][System.Management.Automation.Language.Parser]::ParseFile($script:LibPs1, [ref]$null, [ref]$errors)
    $errors | Should -BeNullOrEmpty
  }
}

Describe 'install.ps1 Windows-specific concerns' {
  It 'flags WSL2 recommendation' {
    (Get-Content $script:InstallPs1 -Raw) | Should -Match 'WSL2'
  }
  It 'flags NTM as tmux-only on native Windows' {
    (Get-Content $script:InstallPs1 -Raw) | Should -Match 'NTM is tmux'
  }
  It 'prints the three CC handoff commands' {
    $ps1 = Get-Content $script:InstallPs1 -Raw
    $ps1 | Should -Match '/plugin marketplace add'
    $ps1 | Should -Match '/plugin install agent-flywheel@agent-flywheel'
    $ps1 | Should -Match '/agent-flywheel:flywheel-setup'
  }
}

Describe 'install/lib/install.ps1 helper functions' {
  BeforeAll {
    . $script:LibPs1
  }
  It 'exposes Write-Log' { Get-Command Write-Log -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Write-Ok'  { Get-Command Write-Ok  -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Write-Err' { Get-Command Write-Err -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Install-Tool' { Get-Command Install-Tool -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Test-NodeOk' { Get-Command Test-NodeOk -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Start-AgentMail' { Get-Command Start-AgentMail -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
  It 'exposes Confirm-Action' { Get-Command Confirm-Action -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty }
}

Describe 'Test-NodeOk version parsing' {
  BeforeAll {
    . $script:LibPs1
    $script:Noninteractive = $true  # so Write-Log doesn't choke
    $script:LogFile = Join-Path ([System.IO.Path]::GetTempPath()) "test-install-ps1.log"
  }
  It 'rejects node v18' {
    $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("node18-" + [guid]::NewGuid())) -Force
    $stub = Join-Path $tmp 'node.ps1'
    "Write-Output 'v18.0.0'" | Set-Content -Path $stub
    # Path-based stub via NODE_BIN env override
    $env:NODE_BIN = $stub
    try {
      Test-NodeOk | Should -BeFalse
    } finally {
      Remove-Item env:NODE_BIN -ErrorAction SilentlyContinue
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  It 'accepts node v20' {
    $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("node20-" + [guid]::NewGuid())) -Force
    $stub = Join-Path $tmp 'node.ps1'
    "Write-Output 'v20.10.0'" | Set-Content -Path $stub
    $env:NODE_BIN = $stub
    try {
      Test-NodeOk | Should -BeTrue
    } finally {
      Remove-Item env:NODE_BIN -ErrorAction SilentlyContinue
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
