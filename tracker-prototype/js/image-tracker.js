/**
 * 图像 AR 跟踪组件（浏览器版，管线与 tracker-lab-node.js 一致）
 *
 *   首次捕获：半分辨率全图 ORB + 多尺度参考 + BFMatcher(ratio) + RANSAC 单应
 *   稳态跟踪：ROI 内 KLT 光流 → 归一化坐标重算单应（每帧）→ 失败则重检测
 *   位姿：solvePnP(SOLVEPNP_IPPE_SQUARE) → One-Euro 滤波 → 写锚点矩阵
 *
 * 复用现有鳌鱼页面：靠派发 markerFound / markerLost 事件驱动游动与交互组件。
 */
(function () {
  'use strict';
  var THREE = AFRAME.THREE;

  var CONFIG = {
    // 卡片图路径：子目录部署时用 window.AOYU_TRACKER_CARD 覆盖（相对文档解析）
    cardImage: (typeof window !== 'undefined' && window.AOYU_TRACKER_CARD) || 'assets/patterns/pattern-card-v2.png',
    cardWidth: 1,                 // 世界单位 = 卡片宽度（与 fish-motion 的 ±0.7 卡宽一致）
    hfovDeg: 60,
    frameW: 640, frameH: 480,
    detectIntervalFrames: 45,
    detectScale: 0.5,             // 首次捕获用半分辨率
    minDetectInliers: 20,
    ratio: 0.75,
    ransacThresh: 3.0,
    grid: 8,                      // 跟踪种子 8×8 = 64 点
    lostGrace: 2,
    // One-Euro（扫参得到的参数：静止重滤波、运动自动放开）
    oneEuro: { minCutoff: 0.2, beta: 0.2, dCutoff: 1.0, dt: 1 / 30 },
    // 自适应质量：按实测每帧耗时升降处理分辨率与跟踪点数，让不同性能的手机都能守住 30fps
    adaptive: { targetMs: 28, window: 30, minScale: 0.6, maxScale: 1.0, minGrid: 6, maxGrid: 8 }
  };

  var S = {
    cv: null, video: null, canvas: null, ctx: null,
    anchor: null, sceneEl: null, staticMode: false, source: null,
    refs: [], card: null, cardSize: [0, 0],
    prevGray: null, trackPts: null, refPts: null, lastH: null, lastCorners: null,
    frame: 0, found: false, miss: 0, forceDetect: true,
    oneEuro: null, pose: null, lastDetectMs: 0, lastTrackMs: 0, poses: 0,
    stats: { frames: 0, posed: 0, detect: [], track: [], inliers: [], lastT: 0, fps: 0, startedAt: 0, costMs: 0 },
    quality: { scale: 1.0, grid: 8 }
  };

  function log() { console.log.apply(console, ['AOYU_TRK'].concat([].slice.call(arguments))); }

  /** 切换质量档位：处理分辨率 + RANSAC 阈值一起缩放（阈值按处理像素算才等价） */
  function setQuality(scale, grid) {
    S.quality.scale = Math.min(CONFIG.adaptive.maxScale, Math.max(CONFIG.adaptive.minScale, scale));
    S.quality.grid = Math.min(CONFIG.adaptive.maxGrid, Math.max(CONFIG.adaptive.minGrid, grid));
    if (S.canvas) {
      S.canvas.width = Math.round(CONFIG.frameW * S.quality.scale);
      S.canvas.height = Math.round(CONFIG.frameH * S.quality.scale);
      S.ransacThresh = S.ransacThresh || CONFIG.ransacThresh * S.quality.scale;
      log('质量档位 → 处理 ' + S.canvas.width + '×' + S.canvas.height + '，跟踪点 ' + S.quality.grid + '²');
    }
  }

  /** 每 window 帧评估一次：超预算就降档，富余很多才升档（升慢降快，避免来回抖） */
  function adaptQuality() {
    if (S.qualityLocked) return;          // ?quality= 指定时锁死档位，便于真机做 A/B
    var st = S.stats, A = CONFIG.adaptive;
    var trk = st.track.slice(-A.window);
    var det = st.detect.slice(-3);
    var cost = (trk.length ? trk.reduce(function (a, b) { return a + b; }, 0) / trk.length : 0) +
               (det.length ? det.reduce(function (a, b) { return a + b; }, 0) / det.length / CONFIG.detectIntervalFrames : 0);
    st.costMs = cost;
    if (cost > A.targetMs) {
      if (S.quality.grid > A.minGrid) setQuality(S.quality.scale, S.quality.grid - 1);
      else setQuality(S.quality.scale - 0.15, S.quality.grid);
    } else if (cost < A.targetMs * 0.5) {
      if (S.quality.scale < A.maxScale) setQuality(S.quality.scale + 0.15, S.quality.grid);
      else if (S.quality.grid < A.maxGrid) setQuality(S.quality.scale, S.quality.grid + 1);
    }
  }

  /* ---------------- One-Euro 滤波（三个平移分量各一路，旋转用球面插值近似） ---------------- */
  function makeOneEuro(cfg) {
    var st = [null, null, null], dx = [0, 0, 0];
    function alpha(cutoff) { var tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / cfg.dt); }
    return function (xyz) {
      var out = [];
      for (var i = 0; i < 3; i++) {
        if (st[i] === null) { st[i] = xyz[i]; out[i] = xyz[i]; continue; }
        var d = (xyz[i] - st[i]) / cfg.dt;
        var aD = alpha(cfg.dCutoff);
        dx[i] = aD * d + (1 - aD) * dx[i];
        var a = alpha(cfg.minCutoff + cfg.beta * Math.abs(dx[i]));
        st[i] = a * xyz[i] + (1 - a) * st[i];
        out[i] = st[i];
      }
      return out;
    };
  }

  /* ---------------- 画面来源 ---------------- */
  function showRetry(msg) {
    var box = document.getElementById('ar-error');
    if (!box) return;
    box.textContent = msg || '点一下开启相机';
    box.onclick = function () { box.textContent = ''; startCamera(); };
  }

  function startCamera() {
    if (!S.video) {
      var v = document.createElement('video');
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      v.muted = true;
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0';
      (document.getElementById('stage') || document.body).appendChild(v);
      S.video = v;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showRetry('这个浏览器不支持摄像头'); return; }
    var ok = false;
    var timer = setTimeout(function () { if (!ok) showRetry('点一下开启相机'); }, 2500);
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } } })
      .then(function (stream) {
        ok = true; clearTimeout(timer);
        S.video.srcObject = stream; S.video.play();
        S.source = S.video; log('相机就绪');
      })
      .catch(function (e) { ok = true; clearTimeout(timer); showRetry('相机打不开（' + (e && e.name) + '）点这里重试'); });
  }

  function useStaticImage(url) {
    var img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = function () { S.source = img; S.staticMode = true; S.frame = -1e9; S.gridSeeded = false; log('静态图模式', url); };
    img.onerror = function () { log('静态图加载失败', url); };
    img.src = url;
  }

  /* ---------------- 初始化：卡片特征（多尺度） ---------------- */
  function buildReferences(cv) {
    var img = S.card;
    var scales = [1.0, 0.5, 0.32, 0.22];
    var orb; try { orb = new cv.ORB(1000); } catch (e) { orb = cv.ORB.create(1000); }
    S.orb = orb;
    S.refs = [];
    for (var i = 0; i < scales.length; i++) {
      var w = Math.round(S.cardSize[0] * scales[i]), h = Math.round(S.cardSize[1] * scales[i]);
      var small = new cv.Mat(); cv.resize(S.card, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      var g = new cv.Mat(); cv.cvtColor(small, g, cv.COLOR_RGBA2GRAY);
      var mask = new cv.Mat(g.rows, g.cols, cv.CV_8UC1, new cv.Scalar(255));
      var kp = new cv.KeyPointVector(), desc = new cv.Mat();
      orb.detectAndCompute(g, mask, kp, desc);
      S.refs.push({ kp: kp, desc: desc, w: w });
      small.delete(); g.delete(); mask.delete();
    }
    log('参考尺度 ' + S.refs.length + ' 层', S.refs.map(function (r) { return r.kp.size(); }).join('/'));
    S.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    S.objPts = cv.matFromArray(4, 3, cv.CV_32F, [-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0]); // IPPE_SQUARE 顺序
    S.distC = cv.Mat.zeros(4, 1, cv.CV_64F);
  }

  function cameraMatrix() {
    var cv = S.cv;
    var f = (S.canvas.width / 2) / Math.tan(CONFIG.hfovDeg * Math.PI / 360);
    S.f = f;
    return cv.matFromArray(3, 3, cv.CV_64F, [f, 0, S.canvas.width / 2, 0, f, S.canvas.height / 2, 0, 0, 1]);
  }

  /* ---------------- 单应：给 4 点坐标就能投影 ---------------- */
  function toFrame(H, x, y) {
    var d = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
  }

  /* ---------------- 检测（首次半分辨率全图 / 之后全分辨率 ROI） ---------------- */
  function detect(gray) {
    var cv = S.cv, t0 = performance.now();
    var base = gray, scale = 1, ox = 0, oy = 0, roi = gray, useRefs = S.refs;
    if (S.lastCorners) {
      var xs = S.lastCorners.map(function (p) { return p[0]; }), ys = S.lastCorners.map(function (p) { return p[1]; });
      var bx0 = Math.min.apply(null, xs), bx1 = Math.max.apply(null, xs), by0 = Math.min.apply(null, ys), by1 = Math.max.apply(null, ys);
      var bw = bx1 - bx0, bh = by1 - by0;
      ox = Math.max(0, Math.floor(bx0 - bw * 0.3)); oy = Math.max(0, Math.floor(by0 - bh * 0.3));
      var x1 = Math.min(gray.cols, Math.ceil(bx1 + bw * 0.3)), y1 = Math.min(gray.rows, Math.ceil(by1 + bh * 0.3));
      if (x1 - ox > 60 && y1 - oy > 60) { roi = gray.roi(new cv.Rect(ox, oy, x1 - ox, y1 - oy)); }
      var target = Math.max(bw, bh);
      useRefs = S.refs.slice().sort(function (a, b) { return Math.abs(a.w - target) - Math.abs(b.w - target); }).slice(0, 2);
    } else {
      var small = new cv.Mat();
      var ds = CONFIG.detectScale * S.quality.scale;
      cv.resize(gray, small, new cv.Size(0, 0), ds, ds, cv.INTER_AREA);
      base = small; scale = ds; roi = small;
    }
    var mask = new cv.Mat(roi.rows, roi.cols, cv.CV_8UC1, new cv.Scalar(255));
    var kp = new cv.KeyPointVector(), desc = new cv.Mat();
    S.orb.detectAndCompute(roi, mask, kp, desc);
    var srcP = [], dstP = [];
    for (var r = 0; r < useRefs.length; r++) {
      var ref = useRefs[r], knn = new cv.DMatchVectorVector();
      S.matcher.knnMatch(ref.desc, desc, knn, 2);
      var k = S.cardSize[0] / ref.w;
      for (var i = 0; i < knn.size(); i++) {
        var m = knn.get(i);
        if (m.size() >= 2 && m.get(0).distance < CONFIG.ratio * m.get(1).distance) {
          var a = ref.kp.get(m.get(0).queryIdx).pt, b = kp.get(m.get(0).trainIdx).pt;
          srcP.push(a.x * k, a.y * k);
          dstP.push((b.x + ox) / scale, (b.y + oy) / scale);
        }
      }
      knn.delete();
    }
    var H = null;
    if (srcP.length >= 8) {
      var cdM = cv.matFromArray(srcP.length / 2, 1, cv.CV_32FC2, srcP);
      var frM = cv.matFromArray(dstP.length / 2, 1, cv.CV_32FC2, dstP);
      var mo = new cv.Mat();
      var Hm = cv.findHomography(cdM, frM, cv.RANSAC, S.ransacThresh || CONFIG.ransacThresh, mo, 200, 0.995);
      var inl = 0; for (var j = 0; j < mo.rows; j++) if (mo.data[j]) inl++;
      if (!Hm.empty() && inl >= CONFIG.minDetectInliers) H = Array.from(Hm.data64F);
      cdM.delete(); frM.delete(); mo.delete(); Hm.delete();
    }
    mask.delete(); kp.delete(); desc.delete();
    if (roi !== gray) roi.delete();
    if (base !== gray && base !== roi) base.delete();
    S.lastDetectMs = performance.now() - t0;
    return H;
  }

  /* ---------------- 跟踪（KLT + RANSAC 单应；这里保持简单，性能留给后续用先验最小二乘替换） ---------------- */
  function track(prevGray, gray) {
    if (!S.trackPts) return null;
    var cv = S.cv, t0 = performance.now();
    var tOx = 0, tOy = 0, prevImg = prevGray, nextImg = gray;
    if (S.lastCorners) {
      var xs = S.lastCorners.map(function (p) { return p[0]; }), ys = S.lastCorners.map(function (p) { return p[1]; });
      var bx0 = Math.min.apply(null, xs), bx1 = Math.max.apply(null, xs), by0 = Math.min.apply(null, ys), by1 = Math.max.apply(null, ys);
      var bw = bx1 - bx0, bh = by1 - by0;
      tOx = Math.max(0, Math.floor(bx0 - bw * 0.9)); tOy = Math.max(0, Math.floor(by0 - bh * 0.9));
      var x1 = Math.min(gray.cols, Math.ceil(bx1 + bw * 0.9)), y1 = Math.min(gray.rows, Math.ceil(by1 + bh * 0.9));
      if (x1 - tOx > 60 && y1 - tOy > 60) {
        prevImg = prevGray.roi(new cv.Rect(tOx, tOy, x1 - tOx, y1 - tOy));
        nextImg = gray.roi(new cv.Rect(tOx, tOy, x1 - tOx, y1 - tOy));
      }
    }
    var pts = [];
    for (var i = 0; i < S.trackPts.rows; i++) pts.push(S.trackPts.data32F[i * 2] - tOx, S.trackPts.data32F[i * 2 + 1] - tOy);
    var ptsMat = cv.matFromArray(S.trackPts.rows, 1, cv.CV_32FC2, pts);
    var nextPts = new cv.Mat(), status = new cv.Mat(), err = new cv.Mat();
    cv.calcOpticalFlowPyrLK(prevImg, nextImg, ptsMat, nextPts, status, err, new cv.Size(21, 21), 3,
      new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01));
    var srcP = [], dstP = [], keepPts = [];
    for (var j = 0; j < status.rows; j++) {
      if (!status.data[j]) continue;
      var fx = nextPts.data32F[j * 2] + tOx, fy = nextPts.data32F[j * 2 + 1] + tOy;
      dstP.push(fx, fy); srcP.push(S.refPts[j * 2], S.refPts[j * 2 + 1]);
      keepPts.push(fx, fy, S.refPts[j * 2], S.refPts[j * 2 + 1]);
    }
    var H = null, inl = 0;
    if (srcP.length >= 12) {
      var cdM = cv.matFromArray(srcP.length / 2, 1, cv.CV_32FC2, srcP);
      var frM = cv.matFromArray(dstP.length / 2, 1, cv.CV_32FC2, dstP);
      var mo = new cv.Mat();
      var Hm = cv.findHomography(cdM, frM, cv.RANSAC, S.ransacThresh || CONFIG.ransacThresh, mo, 200, 0.995);
      for (var k2 = 0; k2 < mo.rows; k2++) if (mo.data[k2]) inl++;
      var minInl = Math.max(10, Math.min(20, Math.round((srcP.length / 2) * 0.3)));
      if (!Hm.empty() && inl >= minInl) { H = Array.from(Hm.data64F); S.lastInliers = inl; }
      else { S.lastInliers = inl; S.forceDetect = true; }
      cdM.delete(); frM.delete(); mo.delete(); Hm.delete();
    }
    if (keepPts.length >= 24 && inl >= 10) {
      if (S.trackPts) S.trackPts.delete();
      S.trackPts = cv.matFromArray(keepPts.length / 4, 1, cv.CV_32FC2, keepPts.filter(function (_, idx) { return idx % 4 < 2; }));
      S.refPts = keepPts.filter(function (_, idx) { return idx % 4 >= 2; });
    } else { S.forceDetect = true; }
    if (prevImg !== prevGray) { prevImg.delete(); nextImg.delete(); }
    ptsMat.delete(); nextPts.delete(); status.delete(); err.delete();
    S.lastTrackMs = performance.now() - t0;
    return H;
  }

  /* ---------------- 位姿 + 滤波 + 写锚点 ---------------- */
  function applyPose(H) {
    var cv = S.cv;
    var corners = [[0, 0], [S.cardSize[0], 0], [S.cardSize[0], S.cardSize[1]], [0, S.cardSize[1]]].map(function (p) { return toFrame(H, p[0], p[1]); });
    S.lastCorners = corners;
    var imgPts = [];
    corners.forEach(function (p) { imgPts.push(p[0], p[1]); });
    var ip = cv.matFromArray(4, 1, cv.CV_32FC2, imgPts);
    var K = cameraMatrix();
    var rvec = new cv.Mat(), tvec = new cv.Mat();
    cv.solvePnP(S.objPts, ip, K, S.distC, rvec, tvec, false, cv.SOLVEPNP_IPPE_SQUARE);
    cv.solvePnPRefineLM(S.objPts, ip, K, S.distC, rvec, tvec);
    var R = new cv.Mat(); cv.Rodrigues(rvec, R);
    var rr = R.data64F, tt = tvec.data64F;
    // One-Euro 只作用在平移上（旋转靠 solvePnP 输出 + 低频刷新）
    if (!S.oneEuro) S.oneEuro = makeOneEuro(CONFIG.oneEuro);
    var t2 = S.oneEuro([tt[0], tt[1], tt[2]]);
    var inCv = new THREE.Matrix4().set(
      rr[0], rr[1], rr[2], t2[0],
      rr[3], rr[4], rr[5], t2[1],
      rr[6], rr[7], rr[8], t2[2],
      0, 0, 0, 1
    );
    // OpenCV 相机系(X右Y下Z前) → three(X右Y上Z后)；码平面 → 锚点约定(+Y 为卡面法线)
    var pose = new THREE.Matrix4().makeScale(1, -1, -1).multiply(inCv).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    S.anchor.object3D.matrixAutoUpdate = false;
    S.anchor.object3D.matrix.copy(pose);
    S.anchor.object3D.matrixWorldNeedsUpdate = true;
    S.poses++;
    S.stats.posed++;
    ip.delete(); K.delete(); rvec.delete(); tvec.delete(); R.delete();
  }

  /* ---------------- 主循环 ---------------- */
  function tick() {
    requestAnimationFrame(tick);
    if (!S.cv || !S.source || !S.card) return;
    S.frame++;
    var st = S.stats;
    if (!st.startedAt) st.startedAt = performance.now();
    st.frames++;
    st.lastT = performance.now();
    if (S.lastDetectMs) { st.detect.push(S.lastDetectMs); S.lastDetectMs = 0; }
    if (S.lastTrackMs) { st.track.push(S.lastTrackMs); S.lastTrackMs = 0; }
    if (S.lastInliers !== undefined) st.inliers.push(S.lastInliers);
    // 每秒刷新面板与 fps
    if (!S.statsEl) makeStatsEl();
    if (st.frames % 30 === 0) {
      var now = performance.now();
      st.fps = 30000 / (now - (st.markT || st.startedAt));
      st.markT = now;
      adaptQuality();
      updateStatsEl();
    }
    var cv = S.cv;
    var sw = S.source.videoWidth || S.source.naturalWidth || S.source.width;
    var sh = S.source.videoHeight || S.source.naturalHeight || S.source.height;
    if (!sw || !sh) return;
    var k = Math.min(S.canvas.width / sw, S.canvas.height / sh);
    S.ctx.fillStyle = '#000'; S.ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    S.ctx.drawImage(S.source, (S.canvas.width - sw * k) / 2, (S.canvas.height - sh * k) / 2, sw * k, sh * k);
    var rgba = cv.imread(S.canvas);
    var gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();

    var H = null;
    var needDetect = S.forceDetect || !S.trackPts || (S.frame % CONFIG.detectIntervalFrames === 0);
    S.forceDetect = false;
    if (needDetect) {
      H = detect(gray);
      if (H) {
        // 重新布种子（8×8）
        var pts = [], refs = [];
        var NG = S.quality.grid;
        for (var iy = 0; iy < NG; iy++) for (var ix = 0; ix < NG; ix++) {
          var gx = 0.1 + ix * 0.8 / (NG - 1), gy = 0.1 + iy * 0.8 / (NG - 1);
          var p = toFrame(H, gx * S.cardSize[0], gy * S.cardSize[1]);
          pts.push(p[0], p[1]); refs.push(gx * S.cardSize[0], gy * S.cardSize[1]);
        }
        if (S.trackPts) S.trackPts.delete();
        S.trackPts = cv.matFromArray(pts.length / 2, 1, cv.CV_32FC2, pts);
        S.refPts = refs;
        S.lastH = H;
        if (S.poses === 0) { applyPose(H); onFound(); }      // 首次或丢失后先给一帧
      }
    } else {
      H = track(S.prevGray, gray);
      if (H) { applyPose(H); S.lastH = H; onFound(); }
      else { onMiss(); }
    }
    if (S.staticMode) { S.frame = 0; S.forceDetect = false; }  // 静态测试模式：跑一帧就停
    S.prevGray = gray;
  }

  function onFound() {
    S.miss = 0;
    if (S.found) return;
    S.found = true; log('已锁定');
    window.dispatchEvent(new CustomEvent('markerFound'));
  }
  function onMiss() {
    if (!S.found) return;
    if (++S.miss < CONFIG.lostGrace) return;
    S.found = false; log('丢失');
    window.dispatchEvent(new CustomEvent('markerLost'));
  }

  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function pct(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length * 0.95)]; }

  function reportText() {
    var st = S.stats;
    var secs = st.startedAt ? ((performance.now() - st.startedAt) / 1000).toFixed(1) : '0';
    return [
      '【图像跟踪实测】时长 ' + secs + 's  帧 ' + st.frames + '  FPS≈' + st.fps.toFixed(1),
      '锁定率 ' + (st.frames ? (st.posed / st.frames * 100).toFixed(0) : 0) + '%（出位姿 ' + st.posed + '/' + st.frames + '）',
      '检测 平均 ' + avg(st.detect).toFixed(0) + 'ms（p95 ' + pct(st.detect).toFixed(0) + 'ms，' + st.detect.length + ' 次）',
      '跟踪 平均 ' + avg(st.track).toFixed(1) + 'ms（p95 ' + pct(st.track).toFixed(1) + 'ms）',
      'KLT 内点 平均 ' + avg(st.inliers).toFixed(0) + '（最小 ' + (st.inliers.length ? Math.min.apply(null, st.inliers) : 0) + '）',
      '质量档位 处理 ' + (S.canvas ? S.canvas.width + '×' + S.canvas.height : '—') + '，点 ' + S.quality.grid + '²，每帧成本≈' + st.costMs.toFixed(1) + 'ms' + (S.qualityLocked ? '（手动锁定）' : '（自适应）'),
      '设备 DPR ' + window.devicePixelRatio
    ].join('\n');
  }

  function makeStatsEl() {
    var el = document.createElement('div');
    el.id = 'trk-stats';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;max-width:92vw;padding:8px 10px;' +
      'background:rgba(8,11,16,.86);color:#7fd1ff;font:11px/1.5 ui-monospace,Menlo,monospace;' +
      'border:1px solid rgba(127,209,255,.4);border-radius:8px;white-space:pre-wrap;pointer-events:auto';
    el.onclick = function () {
      var txt = reportText();
      if (navigator.clipboard) navigator.clipboard.writeText(txt);
      el.textContent = txt + '\n\n（已复制，粘贴发我即可）';
      setTimeout(updateStatsEl, 1500);
    };
    document.body.appendChild(el);
    S.statsEl = el;
  }

  function updateStatsEl() {
    if (!S.statsEl) return;
    S.statsEl.textContent = reportText() + '\n\n（点一下可复制，粘贴发我）';
  }

  window.AOYU_TRACKER = { config: CONFIG, state: S, report: reportText };

  window.addEventListener('load', function () {
    S.sceneEl = document.querySelector('a-scene');
    S.anchor = document.getElementById('ar-marker');
    S.canvas = document.createElement('canvas');
    S.canvas.width = CONFIG.frameW; S.canvas.height = CONFIG.frameH;
    var qOverride = new URLSearchParams(location.search).get('quality');
    if (qOverride) { var qv = parseFloat(qOverride); if (qv > 0) { S.qualityLocked = true; setQuality(qv, 8); log('质量档位被 URL 锁定为 ' + qv); } }
    S.ctx = S.canvas.getContext('2d', { willReadFrequently: true });

    var start = function () {
      var cam = S.sceneEl.camera;
      if (cam) {
        var vfov = 2 * Math.atan(Math.tan(CONFIG.hfovDeg * Math.PI / 360) * S.canvas.height / S.canvas.width) * 180 / Math.PI;
        cam.fov = vfov; cam.aspect = S.canvas.width / S.canvas.height; cam.updateProjectionMatrix();
      }
      var params = new URLSearchParams(location.search);
      var st = params.get('static');
      if (st) useStaticImage(st); else startCamera();
      requestAnimationFrame(tick);
    };
    if (S.sceneEl.hasLoaded) start(); else S.sceneEl.addEventListener('loaded', start);

    (function waitCv(n) {
      if (window.cv && window.cv.Mat && window.cv.ORB) {
        S.cv = window.cv;
        var img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = function () {
          var cw = 480, ch = Math.round(img.height / img.width * 480);
          var c = document.createElement('canvas'); c.width = cw; c.height = ch;
          c.getContext('2d').drawImage(img, 0, 0, cw, ch);
          S.card = S.cv.imread(c); S.cardSize = [cw, ch];
          buildReferences(S.cv);
          log('卡片参考就绪', cw + '×' + ch);
        };
        img.onerror = function () { log('卡片图加载失败（检查 AOYU_TRACKER_CARD 路径）', CONFIG.cardImage); };
        img.src = CONFIG.cardImage;
        return;
      }
      if (n > 600) { log('opencv 加载超时'); return; }
      setTimeout(function () { waitCv(n + 1); }, 100);
    })(0);
  });
})();
