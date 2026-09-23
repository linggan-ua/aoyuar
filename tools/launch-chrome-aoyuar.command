#!/bin/bash
# 演出用启动器：用"关闭窗口遮挡检测"的 Chrome 打开鳌鱼 AR
# 双击本文件即可运行（第一次可能需要：chmod +x tools/launch-chrome-aoyuar.command）
# 说明：Chrome 只要判定窗口被完全遮挡，就会暂停摄像头并冻结页面；
#       下面这些开关让它不要再这么做，这样 OBS 用「窗口采集」长时间抓都不会断。

URL="${1:-https://linggan-ua.github.io/aoyuar/}"

echo "关闭正在运行的 Chrome …"
osascript -e 'quit app "Google Chrome"' >/dev/null 2>&1
sleep 1

echo "用关闭遮挡检测的参数启动 Chrome …"
open -a "Google Chrome" --args \
  --disable-features=CalculateNativeWinOcclusion \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding
sleep 2

echo "打开 $URL"
open -a "Google Chrome" "$URL"

echo
echo "验证方法：在 Chrome 里打开 chrome://version ，看「命令行」里有没有上面这些参数。"
