' Starts the app without leaving a console window on screen.
' Once everything is installed the launcher exits immediately, so this is
' just Electron opening.
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' 0 = hidden window, False = do not wait for it to finish
shell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\launcher.ps1""", 0, False
