# AR.js 抖动隔离对照

两页只保留同一个 kanji marker、同一个简单 cube 和 camera 输入，不带本项目 UI、鱼模型或自定义 cube。

- `current.html`：A-Frame 1.3.0 + AR.js 3.4.7，`smooth=false`
- `official.html`：A-Frame 1.0.0 + AR.js 2.1.4（官方 CDN），`smooth=false`

在手机上打开后移动手机，观察左上角的 `qΣσ` 和 `pΣσ`。数值越小越稳定；两页应在同一个机位、同一张卡连续测试。先试 `official.html` 再试 `current.html`，或反过来重复几轮。

如果官方页明显更稳，说明差异在 AR.js/A-Frame 的 tracking 栈，不应继续在主程序里叠 `smooth` 参数；如果两页接近，则需要继续检查主程序的视频层、canvas 尺寸重排和相机生命周期。
