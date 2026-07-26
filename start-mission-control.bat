@echo off
title Mission Control
cd /d "c:\Users\ouriel\source\repos\otapiero\AgentWorkflowDashboard"

REM Open the browser after a short delay so the server has time to boot
start "" /min cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:4317"

REM Start the app (this window stays open and shows the server logs)
call npm start

REM Keep the window open if the server exits or crashes
echo.
echo ---- Mission Control stopped. Press any key to close. ----
pause >nul
