@echo off
REM Re-arm the auto-verifier. Same lesson as login-long.cmd: set anything the child
REM needs in THIS process, not via Start-Process, which did not pass it through.
cd /d "C:\Users\valor\stockbit-mcp"
node scripts\watch-and-verify-chartbit.cjs --timeout-min 240 --symbol BBRI
