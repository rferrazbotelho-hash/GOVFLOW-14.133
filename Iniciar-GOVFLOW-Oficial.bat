@echo off
chcp 65001 >nul
title GOVFLOW 14.133 — Plataforma Oficial de Licitações Públicas
cd /d "%~dp0"

echo ========================================================================
echo   GOVFLOW 14.133 - PLATAFORMA OFICIAL MULTI-AGENTE (LEI 14.133/2021)
echo ========================================================================
echo.

if not exist "node_modules" (
  echo [1/3] Instalando dependencias...
  call npm.cmd install
  if errorlevel 1 (
    echo Erro ao instalar dependencias.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [2/3] Gerando build oficial de producao...
  call npm.cmd run build
  if errorlevel 1 (
    echo Erro ao compilar a plataforma.
    pause
    exit /b 1
  )
) else if not exist "dist-server\server\index.js" (
  echo [2/3] Gerando build oficial do servidor...
  call npm.cmd run build
  if errorlevel 1 (
    echo Erro ao compilar o servidor.
    pause
    exit /b 1
  )
) else (
  echo [2/3] Build oficial verificado em dist/ e dist-server/.
)

echo [3/3] Iniciando servidor oficial em http://localhost:3001 ...
echo        Para encerrar a plataforma, feche esta janela ou pressione Ctrl+C.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3001"
call npm.cmd start
