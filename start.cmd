@echo off
rem EFT 測位クライアントをローカルで起動して Chrome で開く。
rem このファイルをダブルクリックするだけ。閉じるときはこの黒い窓を閉じる。
rem
rem GitHub Pages などに公開したあとは、このファイルは不要。
rem 公開先の URL を直接ブラウザで開けば動く。

setlocal
cd /d "%~dp0"
set PORT=8731

echo.
echo   EFT 測位クライアント
echo   http://127.0.0.1:%PORT%/
echo.
echo   この窓を閉じると停止します。
echo.

start "" "http://127.0.0.1:%PORT%/"

where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server %PORT% --bind 127.0.0.1
) else (
  python -m http.server %PORT% --bind 127.0.0.1
)
