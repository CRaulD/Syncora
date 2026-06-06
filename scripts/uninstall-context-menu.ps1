[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"

$VideoExtensions = @(".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v")
$VerbIds = @("Syncora.OpenQueue", "Syncora.DownloadSubtitles", "Syncora.DownloadAndSync")
$WrapperNames = $VerbIds | ForEach-Object { "$_.cmd" }

foreach ($Ext in $VideoExtensions) {
  foreach ($VerbId in $VerbIds) {
    $VerbKey = "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\$Ext\shell\$VerbId"
    if (Test-Path -LiteralPath $VerbKey) {
      if ($PSCmdlet.ShouldProcess($VerbKey, "Remove context menu verb")) {
        Remove-Item -LiteralPath $VerbKey -Recurse -Force
      }
    }
  }
}

$SendTo = [Environment]::GetFolderPath("SendTo")
if (-not [string]::IsNullOrWhiteSpace($SendTo)) {
  foreach ($ShortcutName in @("Syncora - abrir na fila.lnk", "Syncora - baixar legendas.lnk", "Syncora - baixar e sincronizar.lnk")) {
    $ShortcutPath = Join-Path $SendTo $ShortcutName
    if (Test-Path -LiteralPath $ShortcutPath) {
      if ($PSCmdlet.ShouldProcess($ShortcutPath, "Remove SendTo shortcut")) {
        Remove-Item -LiteralPath $ShortcutPath -Force
      }
    }
  }
}

$StateKey = "Registry::HKEY_CURRENT_USER\Software\Syncora\ExplorerIntegration"
$WrapperDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Syncora\ExplorerIntegration"
if (Test-Path -LiteralPath $StateKey) {
  try {
    $StoredWrapperDir = (Get-ItemProperty -LiteralPath $StateKey -Name "WrapperDir" -ErrorAction Stop).WrapperDir
    if (-not [string]::IsNullOrWhiteSpace($StoredWrapperDir)) {
      $WrapperDir = $StoredWrapperDir
    }
  } catch {}
}

if (Test-Path -LiteralPath $WrapperDir) {
  foreach ($WrapperName in $WrapperNames) {
    $WrapperPath = Join-Path $WrapperDir $WrapperName
    if (Test-Path -LiteralPath $WrapperPath) {
      if ($PSCmdlet.ShouldProcess($WrapperPath, "Remove action wrapper")) {
        Remove-Item -LiteralPath $WrapperPath -Force
      }
    }
  }
}

if (Test-Path -LiteralPath $StateKey) {
  if ($PSCmdlet.ShouldProcess($StateKey, "Remove integration state")) {
    Remove-Item -LiteralPath $StateKey -Recurse -Force
  }
}

Write-Host "Integracao do Explorer removida."
