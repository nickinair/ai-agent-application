@echo off
echo ====================================================
echo Installing RPA Python Dependencies...
echo ====================================================

python -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install uiautomation requests pyperclip flask -i https://pypi.tuna.tsinghua.edu.cn/simple

echo.
echo ====================================================
echo Done! Please run start.bat to start RPA agent.
echo ====================================================
pause
