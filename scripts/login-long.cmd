@echo off
REM Login with a long window, so it is still waiting when Darren gets back.
REM The env var must be set in the SAME process that runs node -- passing it via
REM PowerShell's Start-Process did not reach the child, and the login expired at
REM the 15-minute default while he was away.
set "STOCKBIT_LOGIN_TIMEOUT_MS=14400000"
cd /d "C:\Users\valor\stockbit-mcp"
node dist\bin\stockbit-auth.js login
