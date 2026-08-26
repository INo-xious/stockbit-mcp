' Fully detached Stockbit login with a long window.
'
' Why VBS and not Start-Process: launching through cmd.exe makes node a GRANDCHILD, and it dies when
' the calling tool's process tree is reaped -- the login then vanishes minutes after it opens, which
' is exactly what happened twice while Darren was away. WScript.Shell.Run detaches properly, the same
' reason the scheduled tasks use this pattern.
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("STOCKBIT_LOGIN_TIMEOUT_MS") = "14400000"
sh.CurrentDirectory = "C:\Users\valor\stockbit-mcp"
sh.Run "cmd /c node dist\bin\stockbit-auth.js login > ""%TEMP%\stockbit-login.out.log"" 2>&1", 0, False
