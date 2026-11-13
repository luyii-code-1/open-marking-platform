#ifndef PublishDir
  #error PublishDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
[Setup]
AppId={{F99BAA68-43F4-460E-A420-0581A775D95C}
AppName=Open Marking Platform Scanner Electron
AppVersion=0.1.0
AppPublisher=Open Marking Platform
DefaultDirName={localappdata}\Programs\OpenMarkingPlatform\ScannerElectron
DefaultGroupName=Open Marking Platform
PrivilegesRequired=lowest
MinVersion=10.0.19041
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=OpenMarkingPlatform-Scanner-Electron-win-x64-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\OMP.Scanner.Electron.exe
CloseApplications=yes
SetupLogging=no
[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Scanner Electron"; Filename: "{app}\OMP.Scanner.Electron.exe"
Name: "{autodesktop}\Scanner Electron"; Filename: "{app}\OMP.Scanner.Electron.exe"
[Registry]
Root: HKCU; Subkey: "Software\Classes\omp-scanner"; ValueType: string; ValueData: "URL:Open Marking Platform Scanner"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\omp-scanner"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\omp-scanner\DefaultIcon"; ValueType: string; ValueData: "{app}\OMP.Scanner.Electron.exe,0"
Root: HKCU; Subkey: "Software\Classes\omp-scanner\shell\open\command"; ValueType: string; ValueData: """{app}\OMP.Scanner.Electron.exe"" ""%1"""
[Run]
Filename: "{app}\OMP.Scanner.Electron.exe"; Description: "Open Scanner Electron"; Flags: nowait postinstall skipifsilent
