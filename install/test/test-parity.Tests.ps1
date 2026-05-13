# install/test/test-parity.Tests.ps1 — Pester parity test for T2.4.
# Asserts install.ps1 and install.sh both cover the same 7 logical steps so
# the two installers don't drift over time.

Describe 'install.ps1 parity with install.sh' {
  BeforeAll {
    $repoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
    $script:ps1 = Get-Content (Join-Path $repoRoot 'install.ps1') -Raw
    $script:sh  = Get-Content (Join-Path $repoRoot 'install.sh')  -Raw
  }

  # Each of these phrases must appear in BOTH installers, so the high-level
  # step set stays in lockstep. The list mirrors plan T2.4 Step 5.
  It 'has step header "<phrase>" in both installers' -ForEach @(
    @{ phrase = 'Claude Code' }
    @{ phrase = 'Required CLIs' }
    @{ phrase = 'Node' }
    @{ phrase = 'agent-mail' }
    @{ phrase = 'Launch' }
    @{ phrase = 'OS detect' }
    @{ phrase = 'CC commands' }
  ) {
    param($phrase)
    $script:ps1 | Should -Match ([regex]::Escape($phrase))
    $script:sh  | Should -Match ([regex]::Escape($phrase))
  }

  It 'exposes the four parity flags on install.ps1' {
    $script:ps1 | Should -Match 'Noninteractive'
    $script:ps1 | Should -Match 'SkipLaunch'
    $script:ps1 | Should -Match 'SkipMcpRegister'
    $script:ps1 | Should -Match 'SkipAgentMail'
  }

  It 'flags NTM as unavailable on native Windows' {
    $script:ps1 | Should -Match 'NTM.*Windows|Windows.*NTM|tmux'
  }

  It 'recommends WSL2 in install.ps1' {
    $script:ps1 | Should -Match 'WSL2'
  }
}
