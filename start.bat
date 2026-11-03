@echo off
chcp 65001 >nul
set PYTHONUNBUFFERED=1
cd /d "%~dp0"
python app.py
if errorlevel 1 pause
