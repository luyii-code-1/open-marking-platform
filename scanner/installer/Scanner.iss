#ifndef PublishDir
  #error PublishDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef OutputName
  #define OutputName "OpenMarkingPlatform-Scanner-Setup"
#endif

[Setup]
AppId={{91DE2170-7F7E-4ED0-A384-E0956AEB5E8F}
AppName=Open Marking Platform Scanner
AppVersion=0.1.0
AppPublisher=Open Marking Platform
DefaultDirName={localappdata}\Programs\OpenMarkingPlatform\Scanner
DefaultGroupName=Open Marking Platform
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\OMP.Scanner.exe
CloseApplications=yes
SetupLogging=no

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Scanner"; Filename: "{app}\OMP.Scanner.exe"

[Registry]
Root: HKCU; Subkey: "Software\Classes\omp-scanner"; ValueType: string; ValueData: "URL:Open Marking Platform Scanner"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\omp-scanner"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\omp-scanner\DefaultIcon"; ValueType: string; ValueData: "{app}\OMP.Scanner.exe,0"
Root: HKCU; Subkey: "Software\Classes\omp-scanner\shell\open\command"; ValueType: string; ValueData: """{app}\OMP.Scanner.exe"" ""%1"""

[Run]
Filename: "{app}\OMP.Scanner.exe"; Description: "Open Scanner"; Flags: nowait postinstall skipifsilent
