#define MyAppName "Syncora"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Syncora"
#define MyAppExeName "Syncora.exe"

[Setup]
AppId={{app.syncora.desktop}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist-installer
OutputBaseFilename=Syncora_{#MyAppVersion}_x64_setup
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=115
WizardImageBackColor=$0F0F0F
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "explorer"; Description: "Adicionar Menu do Explorer"; GroupDescription: "Integracoes"; Flags: checkedonce
Name: "startmenu"; Description: "Criar atalho no menu Iniciar"; GroupDescription: "Atalhos"; Flags: checkedonce
Name: "desktopicon"; Description: "Criar atalho na area de trabalho"; GroupDescription: "Atalhos"; Flags: unchecked

[Files]
Source: "..\target\release\app.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion
Source: "..\target\release\syncora-open.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\icons\icon.ico"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "..\..\backend\dist\syncora-backend.exe"; DestDir: "{app}\backend"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startmenu
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir o Syncora"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{localappdata}\Syncora\ExplorerIntegration\Syncora.OpenQueue.cmd"
Type: files; Name: "{localappdata}\Syncora\ExplorerIntegration\Syncora.DownloadSubtitles.cmd"
Type: files; Name: "{localappdata}\Syncora\ExplorerIntegration\Syncora.DownloadAndSync.cmd"

[Code]
const
  ActionCount = 3;
  ExtensionCount = 6;

var
  VideoExtensions: array[0..5] of String;
  ActionIds: array[0..2] of String;
  ActionLabels: array[0..2] of String;
  ActionNames: array[0..2] of String;
  ActionWrappers: array[0..2] of String;

procedure StyleButton(Button: TNewButton);
begin
  Button.Font.Color := $00000000;
end;

procedure ApplySyncoraTheme();
begin
  WizardForm.Color := $000F0F0F;
  WizardForm.MainPanel.Color := $00161616;
  WizardForm.InnerPage.Color := $000F0F0F;
  WizardForm.BeveledLabel.Font.Color := $00888888;

  WizardForm.PageNameLabel.Font.Color := $00F0F0F0;
  WizardForm.PageNameLabel.Font.Style := [fsBold];
  WizardForm.PageDescriptionLabel.Font.Color := $00B8B8B8;

  WizardForm.WelcomeLabel1.Font.Color := $00F0F0F0;
  WizardForm.WelcomeLabel2.Font.Color := $00B8B8B8;
  WizardForm.FinishedHeadingLabel.Font.Color := $00F0F0F0;
  WizardForm.FinishedLabel.Font.Color := $00B8B8B8;

  WizardForm.SelectDirLabel.Font.Color := $00B8B8B8;
  WizardForm.SelectDirBrowseLabel.Font.Color := $00B8B8B8;
  WizardForm.DirEdit.Color := $00111111;
  WizardForm.DirEdit.Font.Color := $00F0F0F0;

  WizardForm.SelectTasksLabel.Font.Color := $00B8B8B8;
  WizardForm.TasksList.Color := $00111111;
  WizardForm.TasksList.Font.Color := $00F0F0F0;

  WizardForm.ReadyLabel.Font.Color := $00B8B8B8;
  WizardForm.ReadyMemo.Color := $00111111;
  WizardForm.ReadyMemo.Font.Color := $00F0F0F0;

  WizardForm.PreparingLabel.Font.Color := $00B8B8B8;
  WizardForm.FilenameLabel.Font.Color := $00888888;

  StyleButton(WizardForm.BackButton);
  StyleButton(WizardForm.NextButton);
  StyleButton(WizardForm.CancelButton);
end;

procedure InitializeWizard();
begin
  ApplySyncoraTheme();
end;

procedure InitializeSyncoraIntegrationData();
begin
  VideoExtensions[0] := '.mkv';
  VideoExtensions[1] := '.mp4';
  VideoExtensions[2] := '.avi';
  VideoExtensions[3] := '.mov';
  VideoExtensions[4] := '.wmv';
  VideoExtensions[5] := '.m4v';

  ActionIds[0] := 'Syncora.OpenQueue';
  ActionIds[1] := 'Syncora.DownloadSubtitles';
  ActionIds[2] := 'Syncora.DownloadAndSync';

  ActionLabels[0] := 'Abrir com Syncora';
  ActionLabels[1] := 'Baixar legendas';
  ActionLabels[2] := 'Baixar legendas e sincronizar';

  ActionNames[0] := 'queue';
  ActionNames[1] := 'download';
  ActionNames[2] := 'download-sync';

  ActionWrappers[0] := 'Syncora.OpenQueue.cmd';
  ActionWrappers[1] := 'Syncora.DownloadSubtitles.cmd';
  ActionWrappers[2] := 'Syncora.DownloadAndSync.cmd';
end;

function ExplorerIntegrationDir(): String;
begin
  Result := ExpandConstant('{localappdata}\Syncora\ExplorerIntegration');
end;

function WrapperPath(Index: Integer): String;
begin
  Result := ExplorerIntegrationDir() + '\' + ActionWrappers[Index];
end;

procedure WriteWrapper(Index: Integer);
var
  Content: String;
begin
  Content :=
    '@echo off' + #13#10 +
    'set "SYNCORA_ACTION=' + ActionNames[Index] + '"' + #13#10 +
    'set "SYNCORA_APP_EXE=' + ExpandConstant('{app}\{#MyAppExeName}') + '"' + #13#10 +
    '"' + ExpandConstant('{app}\syncora-open.exe') + '" --syncora-action ' + ActionNames[Index] + ' %*' + #13#10;

  SaveStringToFile(WrapperPath(Index), Content, False);
end;

procedure RegisterExplorerVerb(Ext, Id, LabelText, Wrapper: String);
var
  VerbKey: String;
begin
  VerbKey := 'Software\Classes\SystemFileAssociations\' + Ext + '\shell\' + Id;
  RegWriteStringValue(HKCU, VerbKey, '', LabelText);
  RegWriteStringValue(HKCU, VerbKey, 'MUIVerb', LabelText);
  RegWriteStringValue(HKCU, VerbKey, 'Icon', ExpandConstant('{app}\{#MyAppExeName}'));
  RegWriteStringValue(HKCU, VerbKey, 'MultiSelectModel', 'Player');
  RegWriteStringValue(HKCU, VerbKey, 'Position', 'Top');
  RegWriteStringValue(HKCU, VerbKey + '\command', '', '"' + Wrapper + '" "%1"');
end;

procedure InstallExplorerIntegration();
var
  I: Integer;
  J: Integer;
  Wrapper: String;
begin
  ForceDirectories(ExplorerIntegrationDir());

  for I := 0 to ActionCount - 1 do
  begin
    WriteWrapper(I);
    Wrapper := WrapperPath(I);

    for J := 0 to ExtensionCount - 1 do
      RegisterExplorerVerb(VideoExtensions[J], ActionIds[I], ActionLabels[I], Wrapper);

    CreateShellLink(
      ExpandConstant('{sendto}\Syncora - ' + LowerCase(ActionLabels[I]) + '.lnk'),
      ActionLabels[I],
      Wrapper,
      '',
      ExpandConstant('{app}'),
      ExpandConstant('{app}\{#MyAppExeName}'),
      0,
      SW_SHOWNORMAL
    );
  end;

  RegWriteStringValue(HKCU, 'Software\Syncora\ExplorerIntegration', 'HelperPath', ExpandConstant('{app}\syncora-open.exe'));
  RegWriteStringValue(HKCU, 'Software\Syncora\ExplorerIntegration', 'IconPath', ExpandConstant('{app}\{#MyAppExeName}'));
  RegWriteStringValue(HKCU, 'Software\Syncora\ExplorerIntegration', 'WrapperDir', ExplorerIntegrationDir());
end;

procedure RemoveExplorerIntegration();
var
  I: Integer;
  J: Integer;
  ShortcutName: String;
begin
  InitializeSyncoraIntegrationData();

  for I := 0 to ActionCount - 1 do
  begin
    for J := 0 to ExtensionCount - 1 do
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\SystemFileAssociations\' + VideoExtensions[J] + '\shell\' + ActionIds[I]);

    DeleteFile(WrapperPath(I));
    ShortcutName := ExpandConstant('{sendto}\Syncora - ' + LowerCase(ActionLabels[I]) + '.lnk');
    DeleteFile(ShortcutName);
  end;

  RemoveDir(ExplorerIntegrationDir());
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Syncora\ExplorerIntegration');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InitializeSyncoraIntegrationData();

    if WizardIsTaskSelected('explorer') then
      InstallExplorerIntegration();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveExplorerIntegration();
end;
