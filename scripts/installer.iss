; SnapCrop 简裁 — Inno Setup 安装包脚本
; 用法：由 scripts/build-installer.ps1 调用（自动传入 /DAPP_VERSION=x.y.z）
; 特性：用户可自选安装路径（默认免管理员的用户目录）、开始菜单快捷方式、
;       可选桌面图标、标准卸载程序、可选安装后启动。

#ifndef APP_VERSION
  #define APP_VERSION "2.0.0"
#endif

#define APP_NAME "简裁 SnapCrop"
#define APP_NAME_EN "SnapCrop"
#define APP_PUBLISHER "Felix"
#define APP_URL "https://github.com/Felix5206/snapcrop"
#define APP_EXE "SnapCrop.exe"
#define APP_ID "{{6C4E9A2B-3D7F-4B18-9E5A-1C2D8F0B4A63}"

[Setup]
AppId={#APP_ID}
AppName={#APP_NAME}
AppVersion={#APP_VERSION}
AppVerName={#APP_NAME} v{#APP_VERSION}
AppPublisher={#APP_PUBLISHER}
AppPublisherURL={#APP_URL}
AppSupportURL={#APP_URL}/issues
AppUpdatesURL={#APP_URL}/releases
; 默认装到用户目录（%LOCALAPPDATA%\Programs\SnapCrop），免 UAC；用户可在向导中改任意路径
DefaultDirName={autopf}\{#APP_NAME_EN}
DefaultGroupName={#APP_NAME}
PrivilegesRequired=lowest
; 界面语言（install 目录下需有 ChineseSimplified.isl；Inno Setup 6 自带）
ShowLanguageDialog=no
WizardStyle=modern
SetupIconFile=..\assets\brand\app.ico
UninstallDisplayIcon={app}\{#APP_EXE}
OutputDir=..\dist
OutputBaseFilename=SnapCrop-Setup-{#APP_VERSION}
Compression=lzma2/ultra64
SolidCompression=yes
; 覆盖安装时不重复询问卸载旧版
DisableWelcomePage=no
VersionInfoVersion={#APP_VERSION}
VersionInfoDescription={#APP_NAME} 安装程序
VersionInfoProductName={#APP_NAME}

#ifdef LANG_CN
[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："; Flags: unchecked

[Files]
Source: "..\dist\{#APP_NAME_EN}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#APP_NAME}"; Filename: "{app}\{#APP_EXE}"
Name: "{group}\卸载 {#APP_NAME}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#APP_NAME}"; Filename: "{app}\{#APP_EXE}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#APP_EXE}"; Description: "安装完成后启动 {#APP_NAME}"; Flags: nowait postinstall skipifsilent
