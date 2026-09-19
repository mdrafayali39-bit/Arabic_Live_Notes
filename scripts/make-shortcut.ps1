# Puts an "Arabic Live Notes" icon on the desktop and in the Start menu.
# Both point at the silent launcher, so no console window appears.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $Root "scripts\run-hidden.vbs"
$Icon = Join-Path $Root "assets\icon.ico"

$shell = New-Object -ComObject WScript.Shell

foreach ($dir in @($shell.SpecialFolders("Desktop"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))) {
    if (-not (Test-Path $dir)) { continue }
    $link = $shell.CreateShortcut((Join-Path $dir "Arabic Live Notes.lnk"))
    $link.TargetPath = "wscript.exe"
    $link.Arguments = "`"$Target`""
    $link.WorkingDirectory = $Root
    $link.IconLocation = "$Icon,0"
    $link.Description = "Live Arabic to English notes"
    $link.Save()
    Write-Host "  shortcut created in $dir" -ForegroundColor Gray
}
