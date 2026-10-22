#!/usr/bin/env bash
# Builds Cardboard.exe (the Windows launcher, desktop/main.go) into the Cardboard folder.
# Needs Go 1.24+ and Python 3 with Pillow (for the icon). Works from Linux, macOS or Windows (Git Bash).
set -euo pipefail
cd "$(dirname "$0")"
# The dashboard's icon, at the sizes Windows uses.
python3 -c 'from PIL import Image; Image.open("../public/icon-512.png").save("cardboard.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])'
go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico cardboard.ico -manifest cardboard.manifest -o rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o ../Cardboard.exe .
rm -f cardboard.ico rsrc_windows_amd64.syso
echo "Built Cardboard.exe ($(du -h ../Cardboard.exe | cut -f1))"
