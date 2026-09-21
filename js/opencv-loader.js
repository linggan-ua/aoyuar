/**
 * OpenCV.js 多源加载器（带进度）+ 每次改动的由来：
 *
 * 1) 官方 CDN（docs.opencv.org）在 Cloudflare 后面，会间歇性返回 403 挑战页。
 *    挑战页是 HTML，当 <script> 加载**不会触发 onerror**（只抛 SyntaxError）——表现就是
 *    "相机出来了、一直没有鱼、页面什么都不说"。所以这里改成 fetch 下来先验内容，再执行。
 * 2) 真机反馈："跟踪模块（OpenCV 10MB）还在下载…" 一直不消失——说明对国内网络来说源不对。
 *    现在首选**淘宝 NPM 镜像**（registry.npmmirror.com），它和 jsDelivr 是同一份
 *    @techstark/opencv-js@4.12.0-release.1 构建（该构建的 API 已逐个验过，见副本仓
 *    opencv-api-probe.js：ORB/BFMatcher/RANSAC/IPPE_SOLVE/KLT 全在）。
 * 3) 下载过程给出真实进度；fetch 被 CORS 挡住时退回 <script src> 方式（官方源就走这条路）。
 */
(function () {
  'use strict';
  var SOURCES = [
    { name: '淘宝镜像', url: 'https://registry.npmmirror.com/@techstark/opencv-js/4.12.0-release.1/files/dist/opencv.js' },
    { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js' },
    { name: '官方', url: 'https://docs.opencv.org/4.x/opencv.js' }
  ];
  var FETCH_TIMEOUT_MS = 45000;   // 单个源下载上限
  var INIT_WAIT_MS = 20000;       // 下载完之后等 wasm 初始化
  var box = null;

  function ready() { return !!(window.cv && window.cv.Mat && window.cv.ORB); }

  function ui(text, keep) {
    if (!box) {
      box = document.createElement('div');
      box.id = 'aoyu-ocv-progress';
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;' +
        'max-width:82vw;padding:18px 20px;border-radius:14px;background:rgba(8,11,16,.9);' +
        'border:1px solid rgba(245,194,67,.5);color:#f4f7f8;font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
        'text-align:center;white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.textContent = text || '';
    if (!text && box.parentNode) { box.parentNode.removeChild(box); box = null; }
  }

  function execAsScript(text) {
    // 用 blob 执行（不用 eval：体积大时 eval 更慢，也更可能踩 CSP）
    var blob = new Blob([text], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { URL.revokeObjectURL(url); resolve(); };
      s.onerror = function () { URL.revokeObjectURL(url); reject(new Error('blob 脚本执行失败')); };
      document.head.appendChild(s);
    });
  }

  function waitReady(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (ready()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }

  // 退回 <script src>：官方源没有 CORS 头时只能这么加载
  function execByScriptTag(url, ms) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = url;
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
      waitReady(ms).then(resolve);
    });
  }

  function looksLikeHtml(text) {
    var head = text.slice(0, 400).toLowerCase();
    return head.indexOf('<!doctype html') >= 0 || head.indexOf('<html') >= 0;
  }

  function fetchWithProgress(src, i) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); reject(new Error('下载超时')); }, FETCH_TIMEOUT_MS);
      fetch(src.url, { signal: ctrl.signal, credentials: 'omit' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var total = +(res.headers.get('content-length') || 0);
          var got = 0, lastPct = -1, text = '';
          var dec = new TextDecoder('utf-8');            // 必须流式解码：Uint8Array 直接 join('') 会变成逗号分隔的数字串
          var reader = res.body.getReader();
          return (function pump() {
            return reader.read().then(function (r) {
              if (r.done) return text + dec.decode();
              text += dec.decode(r.value, { stream: true });
              got += r.value.length;
              var pct = total ? Math.floor(got / total * 100) : 0;
              if (pct !== lastPct && pct % 5 === 0) {   // 每 5% 刷一次，别刷屏
                lastPct = pct;
                ui('跟踪模块下载中（' + src.name + '）\n' + (got / 1048576).toFixed(1) + ' / ' +
                   (total ? (total / 1048576).toFixed(1) : '?') + ' MB' + (total ? '　' + pct + '%' : ''));
              }
              return pump();
            });
          })();
        })
        .then(function (text) {
          clearTimeout(timer);
          if (looksLikeHtml(text)) { reject(new Error('拿到的是网页而不是脚本（多半是 Cloudflare 挑战页）')); return; }
          if (text.length < 100000) { reject(new Error('内容太小（' + text.length + ' 字节），不像 opencv.js')); return; }
          ui('跟踪模块下载完成（' + src.name + '），正在初始化…');
          execAsScript(text).then(resolve, reject);
        })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function tryOne(i) {
    if (ready()) { ui(''); window.AOYU_OPENCV_ACTIVE = false; return Promise.resolve(true); }
    if (i >= SOURCES.length) {
      window.AOYU_OPENCV_ACTIVE = false;
      ui('跟踪模块（OpenCV）所有源都没加载成功。\n换个网络或刷新页面再试一次。', true);
      console.error('AOYU_OPENCV_ALL_FAILED');
      return Promise.resolve(false);
    }
    var src = SOURCES[i];
    console.log('AOYU_OPENCV_LOAD', i, src.name, src.url);
    ui('正在下载跟踪模块（' + src.name + '）…');
    return fetchWithProgress(src, i).then(function () {
      return waitReady(INIT_WAIT_MS);
    }).then(function (ok) {
      if (ok) { console.log('AOYU_OPENCV_READY', i, src.name); ui(''); window.AOYU_OPENCV_ACTIVE = false; return true; }
      console.warn('AOYU_OPENCV_INIT_TIMEOUT', i, src.name);
      return tryOne(i + 1);
    }).catch(function (e) {
      console.warn('AOYU_OPENCV_SOURCE_FAILED', i, src.name, e && e.message);
      // fetch 走不通（常见于没 CORS 头的源）→ 试 <script src>
      return execByScriptTag(src.url, INIT_WAIT_MS).then(function (ok) {
        if (ok) { console.log('AOYU_OPENCV_READY', i, src.name, '(script 方式)'); ui(''); window.AOYU_OPENCV_ACTIVE = false; return true; }
        return tryOne(i + 1);
      });
    });
  }

  window.AOYU_LOAD_OPENCV = function (onDone) {
    if (ready()) { if (onDone) onDone(true); return; }
    window.AOYU_OPENCV_ACTIVE = true;
    tryOne(0).then(function (ok) { if (onDone) onDone(ok); });
  };
})();
