@echo off
chcp 65001 >nul
title KnowLattice 同步到 GitHub
cd /d "%~dp0"

echo ================================
echo   KnowLattice 一键同步
echo ================================
echo.

git status --short | findstr . >nul
if errorlevel 1 (
    echo 没有新的改动需要同步。
    pause
    exit /b
)

echo 本次改动：
git status --short
echo.
set /p MSG=请输入本次更新的说明（直接回车则用默认）: 
if "%MSG%"=="" set MSG=更新 KnowLattice

echo.
echo 正在提交并推送...
git add -A
git commit -m "%MSG%"
if errorlevel 1 (
    echo 提交失败！
    pause
    exit /b
)

git push origin main
if errorlevel 1 (
    echo 推送失败！请检查网络后重试。
    pause
    exit /b
)

echo.
echo ✅ 同步完成！
timeout /t 2 >nul
