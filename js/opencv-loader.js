/**
 * OpenCV.js 多源加载器。
 *
 * 为什么需要它：官方 CDN（docs.opencv.org）在 Cloudflare 后面，会间歇性给机器人挑战页
 * （实测 403 + "Just a moment..."，且挑战页是 HTML，作为 <script> 加载不会触发 onerror，
 * 只会抛 SyntaxError）——表现就是"相机出来了、一直没有鱼"，很难查。
 *
 * 所以：按顺序试多个源，每个源等 WAIT_MS 毫秒看 window.cv 有没有就绪，没好就换下一个。
 * 跟踪器（js/image-tracker.js）自己会轮询 window.cv，这里只要能把它带起来就行。
 */
(function () {
  'use strict';
  // 顺序：能稳定 200 的放前面；官方源放后面兜底
  var SOURCES = [
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
    'https://docs.opencv.org/4.x/opencv.js'
  ];
  var WAIT_MS = 15000;

  function ready() { return !!(window.cv && window.cv.Mat && window.cv.ORB); }

  function tryOne(i, done) {
    if (ready()) { done(true); return; }
    if (i >= SOURCES.length) { console.error('AOYU_OPENCV_ALL_FAILED'); done(false); return; }
    console.log('AOYU_OPENCV_LOAD', i, SOURCES[i]);
    var s = document.createElement('script');
    s.src = SOURCES[i];
    s.onerror = function () { console.warn('AOYU_OPENCV_ERROR', i); tryOne(i + 1, done); };
    document.head.appendChild(s);
    var t0 = Date.now();
    (function poll() {
      if (ready()) { console.log('AOYU_OPENCV_READY', i, (Date.now() - t0) + 'ms'); done(true); return; }
      if (Date.now() - t0 > WAIT_MS) { console.warn('AOYU_OPENCV_TIMEOUT', i, (Date.now() - t0) + 'ms'); tryOne(i + 1, done); return; }
      setTimeout(poll, 250);
    })();
  }

  /** 起加载（幂等）。onDone(ok) 可选；不等它也能用——跟踪器自己会轮询 window.cv */
  window.AOYU_LOAD_OPENCV = function (onDone) {
    if (ready()) { if (onDone) onDone(true); return; }
    tryOne(0, onDone || function () {});
  };
})();
