[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$InnoScript = Join-Path $ProjectRoot "src-tauri\installer\syncora-inno.iss"
$AppExe = Join-Path $ProjectRoot "src-tauri\target\release\app.exe"
$HelperExe = Join-Path $ProjectRoot "src-tauri\target\release\syncora-open.exe"
$BackendExe = Join-Path $ProjectRoot "backend\dist\syncora-backend.exe"

$Candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

$Iscc = $null
foreach ($Candidate in $Candidates) {
  if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
    $Iscc = $Candidate
    break
  }
}

if (-not $Iscc) {
  $Command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
  if ($Command) {
    $Iscc = $Command.Source
  }
}

if (-not (Test-Path -LiteralPath $InnoScript -PathType Leaf)) {
  throw "Script Inno nao encontrado: $InnoScript"
}

foreach ($Required in @($AppExe, $HelperExe, $BackendExe)) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "Arquivo de release ausente: $Required. Rode primeiro: npm run inno:build"
  }
}

if (-not $Iscc) {
  throw @"
Inno Setup 6 nao encontrado.

Instale pelo site oficial ou via winget:
  winget install JRSoftware.InnoSetup

Depois rode novamente:
  npm run inno:build
"@
}

Write-Host "Compilando instalador Inno com: $Iscc"
& $Iscc $InnoScript

if ($LASTEXITCODE -ne 0) {
  throw "ISCC falhou com codigo $LASTEXITCODE"
}

Write-Host "Instalador Inno gerado em: $(Join-Path $ProjectRoot 'dist-installer')"
