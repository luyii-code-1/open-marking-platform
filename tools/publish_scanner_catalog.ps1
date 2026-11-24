# Run with PowerShell 7 on the Windows publisher account.
param([Parameter(Mandatory)][int]$Revision, [string]$Dotnet='dotnet', [switch]$InitializeKey)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$market=Join-Path $root 'scanner-plugins/market'
$keyDir=Join-Path $env:LOCALAPPDATA 'OpenMarkingPlatform/Publisher'
$keyPath=Join-Path $keyDir 'scanner-market-key.dpapi'
$public=Join-Path $market 'public-key.txt'
$ecdsa=[Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
if ($InitializeKey) {
    if ((Test-Path $keyPath) -or (Test-Path $public)) {throw 'Signing key already exists'}
    [void][IO.Directory]::CreateDirectory($keyDir)
    $secret=[Security.Cryptography.ProtectedData]::Protect($ecdsa.ExportPkcs8PrivateKey(),$null,'CurrentUser')
    [IO.File]::WriteAllBytes($keyPath,$secret)
    [IO.File]::WriteAllText($public,[Convert]::ToBase64String($ecdsa.ExportSubjectPublicKeyInfo()))
} else {
    $key=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyPath),$null,'CurrentUser')
    $read=0
    $ecdsa.ImportPkcs8PrivateKey($key,[ref]$read)
}
if ([Convert]::ToBase64String($ecdsa.ExportSubjectPublicKeyInfo()) -ne [IO.File]::ReadAllText($public).Trim()) {throw 'Signing key mismatch'}
$catalogPath=Join-Path $market 'catalog.json'
if (Test-Path $catalogPath) {
    $previous=[IO.File]::ReadAllText($catalogPath) | ConvertFrom-Json
    $prior=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($previous.payload)) | ConvertFrom-Json
    if ($Revision -le $prior.revision) {throw 'Increase the catalog revision'}
}
$packages=Join-Path $market 'packages'
[void][IO.Directory]::CreateDirectory($packages)
$entries=@(foreach ($plugin in (Get-Content (Join-Path $market 'plugins.json') -Raw | ConvertFrom-Json)) {
    $project=Join-Path $root ('scanner-plugins/'+$plugin.project)
    & $Dotnet build $project -c Release --nologo | Out-Host
    if ($LASTEXITCODE) {throw 'Plugin build failed'}
    $dll=Join-Path $project ('bin/Release/net10.0-windows/'+$plugin.project+'.dll')
    $hash=(Get-FileHash $dll -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $packages ($hash+'.b64')),[Convert]::ToBase64String([IO.File]::ReadAllBytes($dll)))
    @{id=$plugin.id;name=$plugin.name;version=$plugin.version;description=$plugin.description;sha256=$hash}
})
$payload=[Text.Encoding]::UTF8.GetBytes((@{format=1;revision=$Revision;plugins=$entries}|ConvertTo-Json -Compress -Depth 4))
$sig=$ecdsa.SignData($payload,[Security.Cryptography.HashAlgorithmName]::SHA256)
[IO.File]::WriteAllText($catalogPath,(@{payload=[Convert]::ToBase64String($payload);signature=[Convert]::ToBase64String($sig)}|ConvertTo-Json))
