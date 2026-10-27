@echo off
echo ====================================================
echo Starting WeCom RPA Agent...
echo ====================================================

python rpa_agent.py

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] RPA Agent exited with code %errorlevel%.
    pause
)
