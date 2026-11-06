#requires -Version 5.1
<#
.SYNOPSIS
    Verifies that the Superpowers skills ClinicPad depends on are installed.

.DESCRIPTION
    Checks the global OpenCode (~/.agents/skills) and Claude Code (~/.claude/skills)
    skill directories for every required skill. Does not install anything and does
    not modify the repo.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\check-superpowers.ps1

.EXAMPLE
    .\scripts\check-superpowers.ps1 -Verbose

.OUTPUTS
    Exit code 0 when every required skill is found in at least one location.
    Exit code 1 when any skill is missing.
#>
[CmdletBinding()]
param(
    [string[]]$SkillRoots,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$requiredSkills = @(
    'brainstorming',
    'writing-plans',
    'executing-plans',
    'test-driven-development',
    'systematic-debugging',
    'verification-before-completion',
    'requesting-code-review',
    'receiving-code-review',
    'using-git-worktrees',
    'finishing-a-development-branch'
)

if (-not $SkillRoots -or $SkillRoots.Count -eq 0) {
    $SkillRoots = @(
        (Join-Path $HOME '.agents/skills'),
        (Join-Path $HOME '.claude/skills')
    )
}

$existingRoots = @($SkillRoots | Where-Object { Test-Path -LiteralPath $_ })

if ($existingRoots.Count -eq 0) {
    Write-Host 'FAIL: No Superpowers skill directories found.' -ForegroundColor Red
    Write-Host 'Looked in:' -ForegroundColor Yellow
    $SkillRoots | ForEach-Object { Write-Host "  - $_" }
    Write-Host ''
    Write-Host 'Install Superpowers globally, then re-run this script.' -ForegroundColor Yellow
    exit 1
}

if (-not $Quiet) {
    Write-Host ''
    Write-Host 'ClinicPad - Superpowers check' -ForegroundColor Cyan
    Write-Host ('Skill roots: ' + ($existingRoots -join '; '))
    Write-Host ''
}

$results = foreach ($skill in $requiredSkills) {
    $found = $null
    foreach ($root in $existingRoots) {
        $candidate = Join-Path $root $skill
        $skillFile = Join-Path $candidate 'SKILL.md'
        if ((Test-Path -LiteralPath $candidate -PathType Container) -and (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
            $found = $candidate
            break
        }
    }

    [pscustomobject]@{
        Skill  = $skill
        Found  = [bool]$found
        Path   = $found
    }
}

if (-not $Quiet) {
    foreach ($row in $results) {
        if ($row.Found) {
            Write-Host ('  [OK]   ' + $row.Skill) -ForegroundColor Green
        }
        else {
            Write-Host ('  [MISS] ' + $row.Skill) -ForegroundColor Red
        }
    }
    Write-Host ''
}

$missing = @($results | Where-Object { -not $_.Found })
$foundCount = $results.Count - $missing.Count

if ($missing.Count -eq 0) {
    if (-not $Quiet) {
        Write-Host ("PASS: {0}/{1} required skills found." -f $foundCount, $results.Count) -ForegroundColor Green
        Write-Host 'Workflow: brainstorming -> writing-plans -> executing-plans -> TDD -> verification.' -ForegroundColor DarkGray
    }
    exit 0
}

Write-Host ("FAIL: {0}/{1} required skills found; {2} missing." -f $foundCount, $results.Count, $missing.Count) -ForegroundColor Red
Write-Host 'Missing:' -ForegroundColor Yellow
$missing | ForEach-Object { Write-Host ('  - ' + $_.Skill) }
Write-Host ''
Write-Host 'See docs/SETUP.md section 6 for install guidance.' -ForegroundColor Yellow
exit 1
