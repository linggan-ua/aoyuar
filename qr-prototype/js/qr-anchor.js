/**
 * 纯二维码锚点原型（不叠黑框方块）
 *
 * 思路：OpenCV.js 的 QRCodeDetector 在画面里找二维码的四个角 → solvePnP 解 6DoF 位姿
 *      → 直接写进锚点实体的 object3D 矩阵。鱼、游动、交互全部复用现有的组件，
 *      靠派发 markerFound / markerLost 事件驱动（和 AR.js 的接口一致）。
 *
 * 坐标换算：
 *   OpenCV 相机系（X 右、Y 下、Z 前）→ three 相机系（X 右、Y 上、Z 后）：翻转 Y、Z
 *   二维码平面系（X 右、Y 上、Z 法线）→ 锚点约定（X 右、Y 法线、Z 卡高）：绕 X 转 -90°
 */
(function () {
  'use strict';
  var THREE = AFRAME.THREE;

  var CONFIG = {
    // 世界单位 = 二维码边长（和 AR.js 的 marker size=1 对齐）。
    // 游动参数都是按"卡片宽度"给的（±0.7 卡宽、高 0.35~0.9 卡宽），
    // 所以这里必须是 1 而不是米，否则鱼会被放到离卡半米外的地方。
    qrSize: 1,
    hfovDeg: 60,            // 相机水平视场角（估的；真机可以按机型调）
    detectIntervalMs: 100,  // 检测节流：二维码解码比 pattern 贵得多
    lostAfterMisses: 6,
    // 纯解码的位姿噪声比 pattern 大得多，原型里必须做一点平滑，0 = 不平滑
    positionSmooth: 0.35,
    rotationSmooth: 0.35
  };

  var S = {
    cv: null, detector: null, video: null, canvas: null, ctx: null,
    source: null, sceneEl: null, anchor: null,
    lastDetect: 0, miss: 0, found: false, pose: null, staticMode: false
  };

  function log() {
    console.log.apply(console, ['AOYU_QR'].concat([].slice.call(arguments)));
  }

  /* ---------------- 画面来源 ---------------- */
  function useStaticImage(url) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      S.source = img; S.staticMode = true;
      log('使用静态图作为"相机画面"', url, img.width + 'x' + img.height);
      scheduleDetect();
    };
    img.onerror = function () { log('静态图加载失败', url); };
    img.src = url;
  }

  function showCameraRetry(message) {
    var box = document.getElementById('ar-error');
    if (!box) return;
    box.textContent = message || '点一下开启相机';
    box.onclick = function () {
      box.textContent = '';
      startCamera();
    };
  }

  function startCamera() {
    if (!S.video) {
      var video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0';
      document.getElementById('stage').appendChild(video);
      S.video = video;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraRetry('这个浏览器不支持摄像头 API');
      return;
    }
    // iOS / 微信 里 getUserMedia 可能要求"用户手势"，所以失败或 2.5 秒没画面就给个可点的提示
    var started = false;
    var timer = setTimeout(function () { if (!started) showCameraRetry('点一下开启相机'); }, 2500);
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }
    }).then(function (stream) {
      started = true;
      clearTimeout(timer);
      S.video.srcObject = stream;
      S.video.play();
      S.source = S.video;
      log('相机就绪');
      scheduleDetect();
    }).catch(function (error) {
      started = true;
      clearTimeout(timer);
      log('相机失败', error && error.name, error && error.message);
      var name = (error && error.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        showCameraRetry('摄像头权限被拒绝。点这里重试，或去浏览器设置里允许摄像头。');
      } else {
        showCameraRetry('相机打不开（' + name + '）。点这里重试。');
      }
    });
  }

  /* ---------------- 检测循环 ---------------- */
  function scheduleDetect() {
    requestAnimationFrame(tick);
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (!S.cv || !S.detector || !S.source) return;
    if (now - S.lastDetect < CONFIG.detectIntervalMs) return;
    S.lastDetect = now;
    detectOnce();
  }

  function detectOnce() {
    var cv = S.cv;
    try {
      var sw = S.source.videoWidth || S.source.naturalWidth || S.source.width;
      var sh = S.source.videoHeight || S.source.naturalHeight || S.source.height;
      if (!sw || !sh) return;
      var k = Math.min(S.canvas.width / sw, S.canvas.height / sh);
      var dw = sw * k, dh = sh * k;
      S.ctx.fillStyle = '#000';
      S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
      S.ctx.drawImage(S.source, (S.canvas.width - dw) / 2, (S.canvas.height - dh) / 2, dw, dh);
    } catch (error) { return; }

    var img = cv.imread(S.canvas);
    var corners = new cv.Mat();
    var ok = false;
    try {
      ok = S.detector.detect(img, corners);
    } catch (error) {
      ok = false;
    }
    if (S.attempts === undefined) S.attempts = 0;
    S.attempts++;
    var t0 = performance.now();
    if (S.attempts <= 3) {
      log('第 ' + S.attempts + ' 次检测（rows=' + corners.rows + ',cols=' + corners.cols + '，耗时 ' + Math.round(performance.now() - t0) + 'ms）：' + (ok ? '找到二维码，角点 ' + Array.prototype.slice.call(corners.data32F, 0, 8).map(function (v) { return Math.round(v); }).join(',') : '没找到'));
    }
    if (ok && corners.data32F && corners.data32F.length >= 8) {
      poseFromCorners(corners);
      onFound();
      S.detectMs = Math.round(performance.now() - t0);
    } else {
      onMiss();
    }
    img.delete();
    corners.delete();
  }

  function poseFromCorners(corners) {
    try {
    var cv = S.cv;
    var s = CONFIG.qrSize / 2;
    var obj = cv.matFromArray(4, 3, cv.CV_32F, [-s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0]);
    var arr = [];
    var pts = corners.data32F;              // detect() 的输出是 CV_32F，按 x,y 交替存
    for (var i = 0; i < 4; i++) {
      arr.push(pts[i * 2], pts[i * 2 + 1]);
    }
    var img = cv.matFromArray(4, 2, cv.CV_32F, arr);

    var W = S.canvas.width, H = S.canvas.height;
    var f = (W / 2) / Math.tan(CONFIG.hfovDeg * Math.PI / 360);
    var cam = cv.matFromArray(3, 3, cv.CV_64F, [f, 0, W / 2, 0, f, H / 2, 0, 0, 1]);
    var dist = cv.Mat.zeros(4, 1, cv.CV_64F);
    var rvec = new cv.Mat(), tvec = new cv.Mat();
    cv.solvePnP(obj, img, cam, dist, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE);
    var R = new cv.Mat();
    cv.Rodrigues(rvec, R);

    var r = R.data64F, t = tvec.data64F;
    var inCv = new THREE.Matrix4().set(
      r[0], r[1], r[2], t[0],
      r[3], r[4], r[5], t[1],
      r[6], r[7], r[8], t[2],
      0, 0, 0, 1
    );
    var flip = new THREE.Matrix4().makeScale(1, -1, -1);              // CV 相机系 → three
    var toAnchor = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // 码平面 → 锚点约定
    var pose = flip.multiply(inCv).multiply(toAnchor);

    [obj, img, cam, dist, rvec, tvec, R].forEach(function (m) { m.delete && m.delete(); });

    // 平滑（关键：纯解码的位姿很跳）
    if (!S.pose || CONFIG.positionSmooth >= 1) {
      S.pose = pose;
    } else {
      var prevPos = new THREE.Vector3().setFromMatrixPosition(S.pose);
      var nextPos = new THREE.Vector3().setFromMatrixPosition(pose);
      var prevQ = new THREE.Quaternion().setFromRotationMatrix(S.pose);
      var nextQ = new THREE.Quaternion().setFromRotationMatrix(pose);
      prevPos.lerp(nextPos, CONFIG.positionSmooth);
      prevQ.slerp(nextQ, CONFIG.rotationSmooth);
      S.pose = new THREE.Matrix4().compose(prevPos, prevQ, new THREE.Vector3(1, 1, 1));
    }
    S.anchor.object3D.matrixAutoUpdate = false;
    S.anchor.object3D.matrix.copy(S.pose);
    S.anchor.object3D.matrixWorldNeedsUpdate = true;
    S.lastPoseInfo = 'z=' + t[2].toFixed(2) + ' 卡宽  f=' + Math.round(f) + 'px';
    if (!S.poseLogged) { S.poseLogged = true; log('位姿解出：' + S.lastPoseInfo); }
    } catch (error) {
      if (!S.poseErrorLogged) { S.poseErrorLogged = true; log('poseFromCorners 异常：' + (error && error.message)); }
    }
  }

  function onFound() {
    S.miss = 0;
    if (S.found) return;
    S.found = true;
    log('二维码已锁定', S.lastPoseInfo);
    window.dispatchEvent(new CustomEvent('markerFound'));
  }

  function onMiss() {
    if (!S.found) return;
    if (++S.miss < CONFIG.lostAfterMisses) return;
    S.found = false;
    S.pose = null;
    log('二维码丢失');
    window.dispatchEvent(new CustomEvent('markerLost'));
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    S.sceneEl = document.querySelector('a-scene');
    S.anchor = document.getElementById('ar-marker');
    S.canvas = document.createElement('canvas');
    S.canvas.width = 640;
    S.canvas.height = 480;
    S.ctx = S.canvas.getContext('2d', { willReadFrequently: true });

    waitForCv(function (cv) {
      S.cv = cv;
      S.detector = new cv.QRCodeDetector();
      log('OpenCV.js 就绪，QRCodeDetector 已创建');
    });

    // A-Frame 的相机是异步建出来的，要等场景 loaded 之后才能改它的投影
    var startSource = function () {
      var camera = S.sceneEl.camera;
      if (camera) {
        var vfov = 2 * Math.atan(Math.tan(CONFIG.hfovDeg * Math.PI / 360) * S.canvas.height / S.canvas.width) * 180 / Math.PI;
        camera.fov = vfov;
        camera.aspect = S.canvas.width / S.canvas.height;
        camera.updateProjectionMatrix();
        log('相机内参估计：hfov=' + CONFIG.hfovDeg + '° → vfov=' + vfov.toFixed(1) + '°');
      }
      var params = new URLSearchParams(location.search);
      var staticSrc = params.get('static');
      if (staticSrc) useStaticImage(staticSrc);
      else startCamera();
    };
    if (S.sceneEl.hasLoaded) startSource();
    else S.sceneEl.addEventListener('loaded', startSource);
  }

  function waitForCv(callback) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (window.cv && window.cv.QRCodeDetector && window.cv.imread) {
        clearInterval(timer);
        callback(window.cv);
      } else if (tries > 300) {
        clearInterval(timer);
        log('OpenCV.js 加载超时');
      }
    }, 100);
  }

  window.addEventListener('load', function () {
    if (window.cv && window.cv['onRuntimeInitialized'] !== undefined) {
      var prev = window.cv['onRuntimeInitialized'];
      window.cv['onRuntimeInitialized'] = function () { log('opencv runtime initialized'); prev && prev(); };
    }
    boot();
  });

  window.AOYU_QR = { config: CONFIG, state: S };
})();
