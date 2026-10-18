@echo off
rem ===========================================================================
rem  JustViewMD - one-click build script
rem
rem  Uses MSVC when a Visual Studio C++ toolchain is present and falls back to
rem  MinGW-w64 otherwise.  The finished application is copied to dist\.
rem
rem  Usage:
rem    build.bat            release build
rem    build.bat --debug    debug build
rem    build.bat --clean    remove the build tree first
rem ===========================================================================
setlocal EnableExtensions

set "ROOT=%~dp0"
set "BUILD_DIR=%ROOT%build"
set "DIST_DIR=%ROOT%dist"
set "BUILD_TYPE=Release"
set "GENERATOR="
set "TOOLCHAIN="

:parse_arguments
if "%~1"=="" goto arguments_done
if /i "%~1"=="--debug" (
    set "BUILD_TYPE=Debug"
    shift
    goto parse_arguments
)
if /i "%~1"=="--clean" (
    if exist "%BUILD_DIR%" (
        echo Removing the previous build tree...
        rd /s /q "%BUILD_DIR%"
    )
    shift
    goto parse_arguments
)
echo Unknown option: %~1
exit /b 2
:arguments_done

rem ---------------------------------------------------------------------------
rem  Find a compiler
rem ---------------------------------------------------------------------------
where cl.exe >nul 2>nul && goto use_msvc

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto try_mingw

set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH goto try_mingw
if not exist "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" goto try_mingw

echo Using MSVC from "%VSPATH%"
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 goto try_mingw
goto use_msvc

:use_msvc
set "TOOLCHAIN=MSVC"
where ninja.exe >nul 2>nul && (set "GENERATOR=Ninja") || (set "GENERATOR=Visual Studio 17 2022" & set "EXTRA_ARGS=-A x64")
goto configure

:try_mingw
where g++.exe >nul 2>nul || goto no_toolchain
for /f "delims=" %%i in ('where g++.exe') do set "GXX=%%i" & goto mingw_found
:mingw_found
echo Using MinGW-w64 from "%GXX%"
set "TOOLCHAIN=MinGW"
where ninja.exe >nul 2>nul && (set "GENERATOR=Ninja") || (set "GENERATOR=MinGW Makefiles")
goto configure

rem ---------------------------------------------------------------------------
rem  Configure and build
rem ---------------------------------------------------------------------------
:configure
echo.
echo Configuring (%GENERATOR%, %BUILD_TYPE%)...
cmake -S "%ROOT%." -B "%BUILD_DIR%" -G "%GENERATOR%" %EXTRA_ARGS% -DCMAKE_BUILD_TYPE=%BUILD_TYPE%
if errorlevel 1 goto failed

echo.
echo Building...
cmake --build "%BUILD_DIR%" --config %BUILD_TYPE%
if errorlevel 1 goto failed

rem ---------------------------------------------------------------------------
rem  Collect dist\
rem ---------------------------------------------------------------------------
if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"
xcopy /E /I /Y /Q "%BUILD_DIR%\bin\*" "%DIST_DIR%\" >nul
if errorlevel 1 goto failed

echo.
echo ===========================================================================
echo  Build finished: %TOOLCHAIN%, %BUILD_TYPE%
echo ===========================================================================
if exist "%DIST_DIR%\JustViewMD.exe" (
    for %%f in ("%DIST_DIR%\JustViewMD.exe") do echo  %%~ff  (%%~zf bytes)
)
echo  Single executable: the front end and the WebView2 loader are inside.
echo  Unpacked on first run under %%LOCALAPPDATA%%\JustViewMD\.
echo.
echo  Optional: "%DIST_DIR%\JustViewMD.exe" --register
echo            adds "Open with JustViewMD" to the Explorer context menu.
echo ===========================================================================
exit /b 0

:no_toolchain
echo.
echo No C++ compiler was found.
echo.
echo Install one of these and run build.bat again:
echo   * Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
echo     (winget install Microsoft.VisualStudio.2022.BuildTools)
echo   * MinGW-w64 (winget install BrechtSanders.WinLibs.POSIX.UCRT)
exit /b 3

:failed
echo.
echo Build failed. See the messages above.
exit /b 1
