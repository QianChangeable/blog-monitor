#!/usr/bin/env bash
#
# 用本地已下载的 Electron.app 手工组成一个 macOS .app。
#
# 为什么不直接上 electron-builder：它会为每个目标平台再下载一份 Electron（你之前
# 已经手工下过一次了），还要拉 app-builder 二进制。本项目没有任何运行时依赖，
# 包体只需要自己的代码，所以手工组一次最省事，也不引入新工具。
#
# 产物：dist/<productName>.app（ad-hoc 签名，本机可直接双击）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/package.json"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"

# 产物名允许用环境变量覆盖：APP_NAME=QianChang bash scripts/build-mac-app.sh
# 故意不改进 package.json 的 productName —— 它参与 app.getName()，改了会让 Electron
# 换一个用户数据目录，你现有的设置看起来就像丢了。
NAME="${APP_NAME:-$(node -p "require('$PKG').productName")}"
EXEC="$(node -p "require('$PKG').name")"          # 包内可执行文件名：不带空格
BUNDLE_ID="$(node -p "require('$PKG').build.appId")"
VERSION="$(node -p "require('$PKG').version")"
ICON_SRC="$ROOT/renderer/app-icon-mac.png"
OUT="$ROOT/dist"
APP="$OUT/$NAME.app"

[ -d "$ELECTRON_APP" ] || { echo "找不到 $ELECTRON_APP —— 先装好 electron" >&2; exit 1; }
[ -f "$ICON_SRC" ] || { echo "找不到图标 $ICON_SRC" >&2; exit 1; }

echo "→ 复制 Electron.app（$(du -sh "$ELECTRON_APP" | cut -f1)）"
rm -rf "$APP"
mkdir -p "$OUT"
# -a 必须：包内 Framework 有符号链接，跟丢了就打不开
rsync -a "$ELECTRON_APP/" "$APP/"

echo "→ 改名可执行文件 → $EXEC"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$EXEC"

echo "→ 放入应用代码（无运行时依赖，不带 node_modules）"
rm -rf "$APP/Contents/Resources/app" "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
for item in main.js preload.js package.json lib renderer; do
  cp -R "$ROOT/$item" "$APP/Contents/Resources/app/"
done
# 打包脚本自身、以及任何遗留的调试探针，都不该进包
rm -rf "$APP/Contents/Resources/app/renderer/__"* 2>/dev/null || true
[ -d "$APP/Contents/Resources/app/scripts" ] && rm -rf "$APP/Contents/Resources/app/scripts"

echo "→ 生成 .icns"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/appicon.icns"

echo "→ 写 Info.plist"
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleExecutable -string "$EXEC" "$PLIST"
plutil -replace CFBundleName -string "$NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$NAME" "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
plutil -replace CFBundleIconFile -string "appicon" "$PLIST"
plutil -replace NSHighResolutionCapable -bool true "$PLIST"
plutil -replace NSHumanReadableCopyright -string "MIT · qianchang" "$PLIST"

echo "→ 清隔离属性并重新 ad-hoc 签名（改过包体，原签名已失效）"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" 2>/dev/null

echo "→ 校验"
plutil -lint "$PLIST" >/dev/null && echo "  Info.plist 合法"
codesign --verify --deep --strict "$APP" && echo "  签名校验通过"
echo "  包大小：$(du -sh "$APP" | cut -f1)"
echo
echo "完成：$APP"
echo "双击即可运行；命令行：open \"$APP\""
