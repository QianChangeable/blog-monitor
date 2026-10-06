#!/usr/bin/env bash
#
# 内存基准：把 app 跑在隔离的 userData 目录里，按进程采样 macOS 的
# phys_footprint（= 活动监视器"内存"那一列），最后给出稳定态中位数。
#
# 为什么要隔离 userData：Electron 的单实例锁是按 userData 走的，
# 换个目录就能在"你自己那个窗口还开着"的情况下再起一个干净的实例做实验。
#
# 为什么要记录"窗口是不是在最前"：Chromium 一旦判定窗口被遮挡，
# 会停掉合成、把 surface 还回去，GPU 进程内存能掉一半以上。
# 不把这个状态记下来，A/B 两组数字根本没法比。
#
# 用法：
#   bash scripts/memory-bench.sh                       # 本仓库源码，30s
#   bash scripts/memory-bench.sh <app路径> <标签> <秒数> <采样间隔>
#
# 环境变量：
#   MEM_BENCH_OUT=<目录>        采样 CSV 与日志的落地目录（默认 /tmp/hexo-widget-bench）
#   MEM_BENCH_KEEP_FRONT=1      每次采样前把测试窗口抢到最前（数字最可比，但会抢焦点）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$ROOT}"
LABEL="${2:-$(basename "$TARGET")}"
DURATION="${3:-30}"
INTERVAL="${4:-2}"
# 用物理路径（/tmp 在 macOS 上其实是 /private/tmp）：辅助进程 cmdline 里带的是
# 解析后的路径，不统一就没法用 pgrep 把整棵树都捞出来。
UD="$(cd "$(mktemp -d)" && pwd -P)/userdata"
OUTDIR="${MEM_BENCH_OUT:-/tmp/hexo-widget-bench}"
mkdir -p "$OUTDIR"
CSV="$OUTDIR/$LABEL.csv"

# 从某些宿主（编辑器/自动化）里跑时环境里会带 ELECTRON_RUN_AS_NODE=1，
# 那会让 Electron 退化成纯 Node 跑 main.js（require('electron') 拿不到 app）。
# 基准必须跑真正的 Electron，所以这里显式摘掉。
unset ELECTRON_RUN_AS_NODE

# 直接用 Electron 二进制，不经过 .bin/electron 那层 node 包装 ——
# 那层会多出一个常驻 node 进程，把总量算歪。
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "找不到 electron: $ELECTRON" >&2; exit 1; }

if [[ "$TARGET" == *.app ]]; then
  LAUNCH=("$TARGET/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$TARGET/Contents/Info.plist")" "--user-data-dir=$UD")
  ACTIVATE="$TARGET"
  APP_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$TARGET/Contents/Info.plist" 2>/dev/null || basename "${TARGET%.app}")"
else
  LAUNCH=("$ELECTRON" "$TARGET" "--user-data-dir=$UD")
  ACTIVATE="$ROOT/node_modules/electron/dist/Electron.app"
  APP_NAME="Electron"
fi
# 在"本身就被沙箱包着"的宿主里（编辑器、自动化），Chromium 自己的沙箱进程起不来，
# 会一路 GPU process exited。给测试实例关掉沙箱 —— A/B 两组一致，比值仍然可信。
LAUNCH+=("--no-sandbox")

echo "-> launch ${LABEL} (userData=${UD})"
"${LAUNCH[@]}" >"$OUTDIR/$LABEL.log" 2>&1 &
sleep 6   # 等到主窗口 ready-to-show

# 只认这个 userData 目录下的进程，绝不碰你正在用的那个实例
match() { pgrep -f -- "--user-data-dir=$UD" 2>/dev/null; }

if [ -z "$(match)" ]; then
  echo "启动失败，见 $OUTDIR/$LABEL.log" >&2
  tail -20 "$OUTDIR/$LABEL.log" >&2
  exit 1
fi

open -a "$ACTIVATE" 2>/dev/null

frontmost() {
  lsappinfo info -only name "$(lsappinfo front)" 2>/dev/null | sed -E 's/.*= *"?//; s/"?$//'
}

echo "t_s,pid,role,footprint_kb,front" > "$CSV"
start=$(date +%s)
while [ $(( $(date +%s) - start )) -lt "$DURATION" ]; do
  t=$(( $(date +%s) - start ))
  front="$(frontmost)"
  [ "${MEM_BENCH_KEEP_FRONT:-0}" = "1" ] && [ "$front" != "$APP_NAME" ] && { open -a "$ACTIVATE" 2>/dev/null; front="$APP_NAME"; }
  for p in $(match); do
    raw=$(footprint "$p" 2>/dev/null | sed -n '2p' | sed -E 's/.*Footprint: //; s/ \(.*//')
    case "$raw" in
      *" MB") kb=$(awk -v v="${raw% MB}" 'BEGIN{printf "%d", v*1024}') ;;
      *" KB") kb=$(awk -v v="${raw% KB}" 'BEGIN{printf "%d", v}') ;;
      *" GB") kb=$(awk -v v="${raw% GB}" 'BEGIN{printf "%d", v*1048576}') ;;
      *) continue ;;
    esac
    cmd=$(pgrep -fl . 2>/dev/null | grep "^$p " | cut -d' ' -f2-)
    role=$(echo "$cmd" | grep -oE '\-\-type=[a-z-]+' | head -1 | cut -d= -f2)
    [ -z "$role" ] && role=main
    echo "$t,$p,$role,$kb,$front" >> "$CSV"
  done
  sleep "$INTERVAL"
done

pkill -f -- "--user-data-dir=$UD" 2>/dev/null
sleep 1

summarize() { # summarize <csv> <only_visible: 0|1>
  awk -F, -v app="$APP_NAME" -v only="$2" '
    NR > 1 {
      if (only == 1 && $5 != app) next
      role = $3; n[role]++; v[role, n[role]] = $4 + 0
    }
    END {
      total = 0; seen = 0
      for (role in n) {
        c = 0
        for (i = int(n[role] * 0.4) + 1; i <= n[role]; i++) s[++c] = v[role, i]
        for (i = 1; i <= c; i++)
          for (j = i + 1; j <= c; j++)
            if (s[j] < s[i]) { t = s[i]; s[i] = s[j]; s[j] = t }
        med = (c % 2) ? s[(c + 1) / 2] : (s[c / 2] + s[c / 2 + 1]) / 2
        printf "  %-14s %6.0f MB\n", role, med / 1024
        total += med; seen++
        delete s
      }
      if (seen == 0) { printf "  <没有样本>\n"; next }
      printf "  %-14s %6.0f MB\n", "TOTAL", total / 1024
    }
  ' "$1"
}

total_samples=$(awk -F, 'NR>1 && $3=="gpu-process"' "$CSV" | wc -l | tr -d ' ')
front_samples=$(awk -F, -v app="$APP_NAME" 'NR>1 && $3=="gpu-process" && $5==app' "$CSV" | wc -l | tr -d ' ')

echo
echo "=== ${LABEL}: steady state, median of last 60% of samples ==="
summarize "$CSV" 0
echo
echo "--- 其中窗口在最前的采样（${front_samples}/${total_samples}）---"
summarize "$CSV" 1
if [ "$total_samples" -gt 0 ] && [ $(( front_samples * 100 / total_samples )) -lt 60 ]; then
  echo
  echo "  注意：窗口大部分时间被挡住，GPU 数字偏低。想要可比的数字，"
  echo "  跑的时候别去点别的窗口，或者加 MEM_BENCH_KEEP_FRONT=1。"
fi

echo
echo "samples: $CSV"
