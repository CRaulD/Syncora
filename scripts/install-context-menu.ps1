[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet("Debug", "Release")]
  [string] $Mode = "Debug",

  [string] $HelperPath = "",
  [string] $AppPath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TargetProfile = if ($Mode -eq "Release") { "release" } else { "debug" }

if ([string]::IsNullOrWhiteSpace($HelperPath)) {
  $HelperPath = Join-Path $ProjectRoot "src-tauri\target\$TargetProfile\syncora-open.exe"
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path $ProjectRoot "src-tauri\target\$TargetProfile\app.exe"
}

if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
  throw "syncora-open.exe nao encontrado em: $HelperPath. Rode: npm run helper:build"
}

$HelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
$IconPath = $HelperPath

if (Test-Path -LiteralPath $AppPath -PathType Leaf) {
  $AppPath = (Resolve-Path -LiteralPath $AppPath).Path
  $IconPath = $AppPath
}

$VideoExtensions = @(".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v")
$Actions = @(
  @{
    Id = "Syncora.OpenQueue"
    Label = "Abrir com Syncora"
    Action = "queue"
    SendTo = "Syncora - abrir na fila.lnk"
  },
  @{
    Id = "Syncora.DownloadSubtitles"
    Label = "Baixar legendas"
    Action = "download"
    SendTo = "Syncora - baixar legendas.lnk"
  },
  @{
    Id = "Syncora.DownloadAndSync"
    Label = "Baixar legendas e sincronizar"
    Action = "download-sync"
    SendTo = "Syncora - baixar e sincronizar.lnk"
  }
)

$IntegrationDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Syncora\ExplorerIntegration"
$WrapperPaths = @{}

if ($PSCmdlet.ShouldProcess($IntegrationDir, "Create integration wrapper directory")) {
  New-Item -Path $IntegrationDir -ItemType Directory -Force | Out-Null
}

foreach ($ActionConfig in $Actions) {
  $WrapperPath = Join-Path $IntegrationDir "$($ActionConfig.Id).cmd"
  $WrapperPaths[$ActionConfig.Id] = $WrapperPath
  $WrapperContent = @(
    "@echo off",
    "set ""SYNCORA_ACTION=$($ActionConfig.Action)""",
    "set ""SYNCORA_PROJECT_ROOT=$ProjectRoot""",
    "`"$HelperPath`" --syncora-action $($ActionConfig.Action) %*"
  ) -join "`r`n"

  if ($PSCmdlet.ShouldProcess($WrapperPath, "Create action wrapper")) {
    Set-Content -LiteralPath $WrapperPath -Value $WrapperContent -Encoding ASCII
  }
}

foreach ($Ext in $VideoExtensions) {
  foreach ($ActionConfig in $Actions) {
    $WrapperPath = $WrapperPaths[$ActionConfig.Id]
    $VerbKey = "Registry::HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\$Ext\shell\$($ActionConfig.Id)"
    $CommandKey = Join-Path $VerbKey "command"
    $CommandValue = "`"$WrapperPath`" `"%1`""

    if ($PSCmdlet.ShouldProcess($VerbKey, "Register context menu verb")) {
      New-Item -Path $VerbKey -Force | Out-Null
      Set-Item -Path $VerbKey -Value $ActionConfig.Label
      New-ItemProperty -Path $VerbKey -Name "MUIVerb" -Value $ActionConfig.Label -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $VerbKey -Name "Icon" -Value $IconPath -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $VerbKey -Name "MultiSelectModel" -Value "Player" -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $VerbKey -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

      New-Item -Path $CommandKey -Force | Out-Null
      Set-Item -Path $CommandKey -Value $CommandValue
    }
  }
}

$SendTo = [Environment]::GetFolderPath("SendTo")
if (-not [string]::IsNullOrWhiteSpace($SendTo)) {
  $Shell = New-Object -ComObject WScript.Shell
  foreach ($ActionConfig in $Actions) {
    $WrapperPath = $WrapperPaths[$ActionConfig.Id]
    $ShortcutPath = Join-Path $SendTo $ActionConfig.SendTo
    if ($PSCmdlet.ShouldProcess($ShortcutPath, "Create SendTo shortcut")) {
      $Shortcut = $Shell.CreateShortcut($ShortcutPath)
      $Shortcut.TargetPath = $WrapperPath
      $Shortcut.Arguments = ""
      $Shortcut.WorkingDirectory = $ProjectRoot
      $Shortcut.IconLocation = $IconPath
      $Shortcut.Description = $ActionConfig.Label
      $Shortcut.Save()
    }
  }
}

$StateKey = "Registry::HKEY_CURRENT_USER\Software\Syncora\ExplorerIntegration"
if ($PSCmdlet.ShouldProcess($StateKey, "Save integration state")) {
  New-Item -Path $StateKey -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "HelperPath" -Value $HelperPath -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "IconPath" -Value $IconPath -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "WrapperDir" -Value $IntegrationDir -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "Extensions" -Value ($VideoExtensions -join ";") -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "Actions" -Value (($Actions | ForEach-Object { $_.Id }) -join ";") -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $StateKey -Name "InstalledAt" -Value (Get-Date).ToString("s") -PropertyType String -Force | Out-Null
}

Write-Host "Integracao instalada: Abrir com Syncora / Baixar legendas / Baixar legendas e sincronizar"
Write-Host "Helper: $HelperPath"
Write-Host "Extensoes: $($VideoExtensions -join ', ')"
Write-Host "No Windows 11, se nao aparecer no menu principal, use 'Mostrar mais opcoes' ou 'Enviar para'."
