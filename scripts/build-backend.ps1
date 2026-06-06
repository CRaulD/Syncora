$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $ProjectRoot "backend"
$DistDir = Join-Path $BackendDir "dist"
$WorkDir = Join-Path $BackendDir "build\pyinstaller"
$EntryPoint = Join-Path $BackendDir "syncora_backend.py"
$OutputExe = Join-Path $DistDir "syncora-backend.exe"

if (-not (Test-Path -LiteralPath $EntryPoint)) {
  throw "Entrada do backend nao encontrada: $EntryPoint"
}

Write-Host "Instalando dependencias de build do backend..."
py -m pip install -r (Join-Path $BackendDir "requirements-build.txt")

if (Test-Path -LiteralPath $DistDir) {
  $resolved = (Resolve-Path -LiteralPath $DistDir).Path
  if (-not $resolved.StartsWith($BackendDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DistDir fora do backend: $resolved"
  }
  Remove-Item -LiteralPath $DistDir -Recurse -Force
}

if (Test-Path -LiteralPath $WorkDir) {
  $resolved = (Resolve-Path -LiteralPath $WorkDir).Path
  if (-not $resolved.StartsWith($BackendDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "WorkDir fora do backend: $resolved"
  }
  Remove-Item -LiteralPath $WorkDir -Recurse -Force
}

Write-Host "Gerando syncora-backend.exe..."
py -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name syncora-backend `
  --distpath $DistDir `
  --workpath $WorkDir `
  --specpath $WorkDir `
  --collect-all subliminal `
  --collect-all babelfish `
  --collect-all guessit `
  --collect-all enzyme `
  --collect-all dogpile.cache `
  --collect-all stevedore `
  $EntryPoint

if (-not (Test-Path -LiteralPath $OutputExe)) {
  throw "PyInstaller terminou, mas o executavel nao foi encontrado: $OutputExe"
}

Write-Host "Backend empacotado em: $OutputExe"

