param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $repoRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { $pythonPath = 'python' }
Push-Location $repoRoot
try {
    & $pythonPath -m compileall -q server deploy
    if ($LASTEXITCODE -ne 0) { throw '后端语法检查失败' }
    Push-Location (Join-Path $repoRoot 'web')
    try {
        if (-not $SkipBuild) {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
        }
        foreach ($check in @('tools/test-network-policy.mjs','tools/test-auto-update.mjs','tools/test-build-version.mjs')) {
            & node $check
            if ($LASTEXITCODE -ne 0) { throw "关键检查失败：$check" }
        }
    } finally { Pop-Location }
} finally { Pop-Location }
Write-Output '项目验证通过，可部署云端。'
