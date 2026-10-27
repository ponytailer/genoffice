@echo off
rem genoffice launcher for the packaged Windows app: <install>\resources\cli\genoffice.cmd
rem The install directory and the app binary are named after productName
rem ("CMLG Office"); the command itself stays `genoffice`.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\CMLG Office.exe" "%~dp0genoffice.cjs" %*
endlocal