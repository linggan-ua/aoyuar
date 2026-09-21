/**
 * 鳌鱼 AR · 行为层
 *
 * 移植自微信小程序 xr_frame_official_min 的 ar/components/xr-ar-aoyu：
 *   游动（随机巡游/冲刺/滑行/悬停、限速转向、软边界、绕重力姿态、摆尾联动）
 *   入场/退场、丢卡隐藏、点鱼身播五声音阶、点空白惊吓、20:00 自动换鱼
 *
 * 坐标系沿用小程序那一套：卡片局部空间里 X = 卡宽方向，Y = 卡面法线，Z = 卡高方向。
 * AR.js 的 marker 局部空间正好也是这个朝向（+Y 垂直于卡面），所以数学部分不用改。
 */
(function () {
  'use strict';

  var THREE = AFRAME.THREE;

  var CONFIG = {
    switchHour: 20,            // 20:00 之后显示鳌鱼，之前显示锦鲤
    transitionMs: 900,         // 换鱼时两条同时在场的时长
    hideDelayMs: 1000,         // 丢卡后让鱼游走再隐藏
    noteVolume: 0.75,          // 和小程序一致
    clips: { aoyu: 'Ao_Swim_Loop_3.2s', koi: 'Swim_Loop_2.4s' },
    notes: ['note-c6', 'note-d6', 'note-e6', 'note-g6', 'note-a6'].map(function (name) {
      return '../assets/audio/' + name + '.mp3';
    }),
    storageKey: 'aoyu-tuning-v1',
    tuningLimits: {
      speedScale: [0.5, 2.0],
      turnScale: [0.5, 1.7],
      rangeScale: [0.5, 3.0],     // 活动范围：1 = 原来的值（±0.95 卡宽），最大可以放大到 3 倍
      animSpeedMax: [1.0, 3.0],
      modelScale: [0.4, 2.0]      // 鱼的大小
    }
  };

  var instances = {};                       // key -> fish-swim 组件实例
  var app = null;                           // 主控
  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var plane = new THREE.Plane();
  var tmpVec = new THREE.Vector3();
  var tmpQuat = new THREE.Quaternion();

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** 屏幕坐标 → 卡片局部坐标（打到卡面平面上）；打不到（卡几乎侧对镜头）返回 null */
  function cardPointFromScreen(clientX, clientY) {
    var sceneEl = document.querySelector('a-scene');
    var marker = document.getElementById('ar-marker');
    var camera = sceneEl && sceneEl.camera;
    var canvas = sceneEl && sceneEl.renderer && sceneEl.renderer.domElement;
    if (!marker || !camera || !canvas) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var normal = tmpVec.set(0, 1, 0).applyQuaternion(
      marker.object3D.getWorldQuaternion(tmpQuat)
    ).normalize().clone();
    var origin = marker.object3D.getWorldPosition(new THREE.Vector3());
    plane.setFromNormalAndCoplanarPoint(normal, origin);
    var hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return marker.object3D.worldToLocal(hit);
  }

  /* =========================================================================
   * 摆尾动画：直接驱动 GLTF 自带的骨骼动画，速度跟游速联动
   * ========================================================================= */
  AFRAME.registerComponent('fish-anim', {
    schema: {
      clip: { type: 'string' },
      speed: { type: 'number', default: 1 }
    },
    init: function () {
      var self = this;
      this.mixer = null;
      this.action = null;
      this.el.addEventListener('model-loaded', function (event) {
        var model = event.detail.model;
        var clips = (model && model.animations) || [];
        var clip = THREE.AnimationClip.findByName(clips, self.data.clip) || clips[0];
        if (!clip) {
          console.warn('AOYU_ANIM_NO_CLIP', self.data.clip, clips.map(function (c) { return c.name; }));
          return;
        }
        self.mixer = new THREE.AnimationMixer(model);
        self.action = self.mixer.clipAction(clip);
        self.action.setLoop(THREE.LoopRepeat, Infinity);
        self.action.play();
        console.log('AOYU_ANIM_READY', clip.name, clip.duration.toFixed(1) + 's');
      });
    },
    tick: function (time, delta) {
      if (!this.mixer) return;
      this.mixer.update((delta / 1000) * this.data.speed);
    },
    pause: function () { if (this.action) this.action.paused = true; },
    resume: function () { if (this.action) this.action.paused = false; },
    status: function () {
      if (!this.action) return '摆尾：还没加载';
      return '摆尾：' + this.action.getClip().name +
        '　时间 ' + this.action.time.toFixed(2) + 's' +
        '　速度 ×' + this.data.speed.toFixed(2) +
        '　' + (this.action.paused ? '已暂停' : '播放中');
    }
  });

  /* =========================================================================
   * 一条鱼：游动 + 入场退场 + 惊吓
   * ========================================================================= */
  AFRAME.registerComponent('fish-swim', {
    schema: {
      key: { type: 'string' },
      baseSpeed: { type: 'number', default: 0.30 },
      anim: { type: 'selector' }
    },
    init: function () {
      var key = this.data.key;
      this.key = key;
      this.motion = FishMotion.createState({
        seed: (Date.now() % 100000) + (key === 'aoyu' ? 11 : 977),
        baseSpeed: this.data.baseSpeed
      });
      this.upRef = [0, 1, 0];
      this.posture = { name: '平放（默认）', tiltDeg: 0 };
      this.tuning = { speedScale: 1, turnScale: 1, rangeScale: 1, animSpeedMax: 2.2, modelScale: 1 };
      this.baseScale = this.el.object3D.scale.x;   // HTML 里写死的模型大小（鳌鱼 0.64 / 锦鲤 0.55）
      this.appliedScale = 1;
      this.hidden = true;
      this.upRefTimer = 99;                 // 第一帧就估一次姿态
      this.el.object3D.visible = false;
      instances[key] = this;
    },
    remove: function () {
      if (instances[this.key] === this) delete instances[this.key];
    },
    animator: function () {
      var el = this.data.anim;
      return el && el.components['fish-anim'];
    },
    tick: function (time, delta) {
      var d = Math.min(0.05, (delta || 0) / 1000);
      if (!d) return;
      // 卡片姿态低频刷新：卡片是固定的，不用每帧算（小程序里也是 0.5 秒一次）
      this.upRefTimer += d;
      if (this.upRefTimer >= 0.5) {
        this.upRefTimer = 0;
        this.updateUpRef();
      }
      if (this.appliedScale !== this.tuning.modelScale) {
        this.appliedScale = this.tuning.modelScale;
        this.el.object3D.scale.setScalar(this.baseScale * this.tuning.modelScale);
      }
      if (this.hidden) return;
      var out = FishMotion.step(this.motion, d, { upRef: this.upRef, tuning: this.tuning });
      this.el.object3D.position.set(out.position[0], out.position[1], out.position[2]);
      this.el.object3D.quaternion.set(out.quaternion[0], out.quaternion[1], out.quaternion[2], out.quaternion[3]);
      var animator = this.animator();
      if (animator) animator.data.speed = out.animSpeed;
      this.lastState = out.state;
    },
    /** 世界正上方换算到卡片局部：卡片平放时是 (0,1,0)，贴墙时是水平的 */
    updateUpRef: function () {
      var marker = document.getElementById('ar-marker');
      if (!marker || !marker.object3D) return;
      var up = new THREE.Vector3(0, 1, 0).applyQuaternion(
        marker.object3D.getWorldQuaternion(new THREE.Quaternion()).invert()
      );
      this.upRef = [up.x, up.y, up.z];
      var tilt = Math.acos(clamp(up.y, -1, 1)) * 180 / Math.PI;
      var name = tilt < 20 ? '平放' : (tilt > 70 ? '竖直贴墙' : '倾斜');
      if (name !== this.posture.name) {
        this.posture = { name: name, tiltDeg: tilt };
        console.log('AOYU_POSTURE', name, 'tilt=' + Math.round(tilt) + '°',
          'upRef=' + this.upRef.map(function (v) { return v.toFixed(2); }).join(','));
      } else {
        this.posture.tiltDeg = tilt;
      }
    },
    show: function () {
      this.hidden = false;
      this.el.object3D.visible = true;
      var animator = this.animator();
      if (animator) animator.resume();
    },
    hide: function () {
      this.hidden = true;
      this.el.object3D.visible = false;
      var animator = this.animator();
      if (animator) animator.pause();
    },
    enter: function () {
      FishMotion.startEntering(this.motion);
      this.show();
    },
    exit: function () {
      FishMotion.startExiting(this.motion);
    },
    startle: function (threat) {
      FishMotion.startle(this.motion, threat);
    },
    /**
     * 材质轻量化：把 Standard/Physical 换成不考虑光照的 Basic（水墨本来就是平的）。
     * 用来现场判断"卡"是不是卡在片元着色器上。原来的材质存起来，可以切回去。
     */
    setLightweightMaterials: function (on) {
      var meshEl = this.data.anim;
      var root = meshEl && meshEl.getObject3D('mesh');
      if (!root) return false;
      var THREE = AFRAME.THREE;
      if (on) {
        if (this._savedMaterials) return true;
        this._savedMaterials = [];
        root.traverse(function (node) {
          if (!node.isMesh || !node.material) return;
          var list = Array.isArray(node.material) ? node.material : [node.material];
          var swapped = list.map(function (m) {
            return new THREE.MeshBasicMaterial({
              map: m.map || null,
              color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
              alphaTest: m.alphaTest || 0,
              transparent: m.transparent,
              opacity: m.opacity,
              side: m.side,
              depthWrite: m.depthWrite
            });
          });
          this._savedMaterials.push({ node: node, material: node.material });
          node.material = Array.isArray(node.material) ? swapped : swapped[0];
        }, this);
      } else if (this._savedMaterials) {
        this._savedMaterials.forEach(function (item) { item.node.material = item.material; });
        this._savedMaterials = null;
      }
      console.log('AOYU_MATERIAL_MODE', on ? 'basic' : 'standard');
      return true;
    },

    status: function () {
      return {
        tuning: {
          speedScale: this.tuning.speedScale,
          turnScale: this.tuning.turnScale,
          rangeScale: this.tuning.rangeScale,
          animSpeedMax: this.tuning.animSpeedMax,
          modelScale: this.tuning.modelScale
        },
        posture: { name: this.posture.name, tiltDeg: Math.round(this.posture.tiltDeg) },
        upRef: this.upRef,
        state: this.lastState || 'cruise'
      };
    }
  });

  /* =========================================================================
   * 主控：时间模式、卡片进出、点击交互、调试面板
   * ========================================================================= */
  app = {
    markerActive: false,
    fishHidden: true,
    targetMode: null,     // 'aoyu' | 'koi'
    forceMode: null,      // 调试强制
    offsetMs: 0,          // 调试时间偏移
    hideTimer: null,
    transitionTimer: null,
    switchTimer: null,
    lastNoteIndex: -1,
    players: [],

    init: function () {
      var self = this;
      this.sceneEl = document.querySelector('a-scene');
      this.marker = document.getElementById('ar-marker');

      // iOS：开着摄像头时音频会话是 playAndRecord，默认走听筒（听起来"明明在播却没声"）。
      // 显式声明成 playback 才会走扬声器，和小程序里的 speakerOn 是同一件事。
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) { /* 不支持就算了 */ }
      }
      this.players = CONFIG.notes.map(function (src) {
        var audio = new Audio(src);
        audio.preload = 'auto';
        audio.volume = CONFIG.noteVolume;
        return audio;
      });

      this.marker.addEventListener('markerFound', function () { self.setMarkerActive(true); });
      this.marker.addEventListener('markerLost', function () { self.setMarkerActive(false); });
      // 这套 AR.js 还会在 window 上再抛一次同名事件，两条路都接上没有副作用
      window.addEventListener('markerFound', function () { self.setMarkerActive(true); });
      window.addEventListener('markerLost', function () { self.setMarkerActive(false); });

      this.limitPixelRatio();
      this.bindTap();
      this.initCamera();
      this.bindDebugPanel();
      this.startFpsCounter();
      this.applySavedTuning();
      this.updateTimeMode();
      console.log('AOYU_AR_READY');
    },

    /**
     * 渲染分辨率自适应（不是限制帧率）。
     * 手机 DPR 普遍 2~3，A-Frame 按 devicePixelRatio 渲染等于每帧多画 4~9 倍像素，
     * 这是掉帧最大的一头。但是直接压到 1.5 会牺牲画面锐度，所以改成看帧率动态调：
     *   FPS ≥ 55 → 像素比 +0.25（更清晰）
     *   FPS ≤ 40 → 像素比 -0.25（更顺）
     * 40~55 之间是死区，不动，避免来回抖。上限 min(DPR, 2)，下限 1.0。
     */
    limitPixelRatio: function () {
      var renderer = this.sceneEl && this.sceneEl.renderer;
      if (!renderer) return;
      var self = this;
      this.minPixelRatio = 1.0;
      this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      this.pixelRatio = Math.min(1.5, this.maxPixelRatio);
      renderer.setPixelRatio(this.pixelRatio);
      console.log('AOYU_PIXEL_RATIO', this.pixelRatio,
        'drawingBuffer=' + renderer.domElement.width + '×' + renderer.domElement.height,
        'max=' + this.maxPixelRatio);
      setInterval(function () {
        if (!self.fps) return;
        var next = self.pixelRatio;
        if (self.fps >= 55 && next < self.maxPixelRatio) next = Math.min(self.maxPixelRatio, next + 0.25);
        else if (self.fps <= 40 && next > self.minPixelRatio) next = Math.max(self.minPixelRatio, next - 0.25);
        if (next !== self.pixelRatio) {
          self.pixelRatio = next;
          self.sceneEl.renderer.setPixelRatio(next);
          console.log('AOYU_PIXEL_RATIO_CHANGE', next, 'fps=' + self.fps);
        }
      }, 3000);
    },

    /** 帧率计数（调试面板显示用） */
    startFpsCounter: function () {
      var self = this;
      var frames = 0;
      var last = performance.now();
      var loop = function () {
        frames++;
        var now = performance.now();
        if (now - last >= 1000) {
          self.fps = Math.round((frames * 1000) / (now - last));
          frames = 0;
          last = now;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    /* ---------- 相机 ---------- */
    /**
     * 分两步走：
     *   1) 先让 AR.js 自己去开相机：安卓 Chrome / 桌面直接就出画面，不需要任何点击；
     *   2) 拿不到画面才弹出"点一下开启相机"。iOS 和微信 WebView 会因为"没有用户手势"
     *      拒绝 getUserMedia（老版本页面也是靠一个开始按钮先拿到手势才起相机的，
     *      随机打开的时候同样是黑屏）。这时在点击回调里自己调 getUserMedia，
     *      再把拿到的流接到 AR.js 的 video 元素上——AR.js 的识别循环读的就是这个
     *      video 元素，接上流就正常识别，不需要重载页面。
     */
    initCamera: function () {
      var self = this;
      this.cameraReady = false;
      this.pendingStream = null;
      this.hintEl = document.getElementById('hint');
      this.errorEl = document.getElementById('ar-error');
      this.gateEl = document.getElementById('tap-gate');

      window.addEventListener('arjs-video-loaded', function (event) {
        var video = (event.detail && event.detail.component) || document.querySelector('#arjs-video');
        self.prepareVideo(video);
      });
      // AR.js 开相机失败时会抛这个事件（微信/iOS 上最常见的就是缺用户手势）
      window.addEventListener('camera-error', function (event) {
        self.showGate((event && (event.error || (event.detail && event.detail.error))) || null);
      });
      this.gateEl.addEventListener('click', function () { self.openCameraByGesture(); });

      // 兜底：2 秒后还没画面就弹手势层；已经出画面了就补一次"相机就绪"
      setTimeout(function () {
        if (self.isVideoLive(self.findArVideo())) self.onCameraLive();
        else self.showGate(null);
      }, 2000);
    },

    /** AR.js 建的 video 元素：iOS / 微信 WebView 要这几个属性才肯内联播放 */
    prepareVideo: function (video) {
      if (!video || video.dataset.aoyuPrepared) return;
      video.dataset.aoyuPrepared = '1';
      // 图片/视频文件源（比如 tools/pattern-detect-test.html）给的不是 video 元素，
      // 它们本来就在播，不需要补 iOS 那套属性
      if (video.tagName !== 'VIDEO') {
        this.onCameraLive();
        return;
      }
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('autoplay', '');
      video.muted = true;
      if (this.pendingStream) {
        this.attachStream(video, this.pendingStream);
        this.pendingStream = null;
        return;
      }
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
      var self = this;
      // AR.js 是先设 srcObject、后把 video 插进文档的；iOS 上有时候要等它进文档后
      // 再重新触发一次解码才会出画面。重新赋一次同一路流是安全的。
      if (video.srcObject) {
        var stream = video.srcObject;
        video.srcObject = null;
        video.srcObject = stream;
        var again = video.play();
        if (again && again.catch) again.catch(function () {});
      }
      if (this.isVideoLive(video)) this.onCameraLive();
      else video.addEventListener('loadeddata', function () { self.onCameraLive(); }, { once: true });
    },

    /**
     * 找 AR.js 的 video 元素。
     * AR.js 开相机失败时，video 元素是**建好了但没挂到页面上**的（挂载和 ready 标记都在成功回调里），
     * 所以这里除了查 DOM，还要去它的 source 对象上把那个元素捞出来。
     */
    findArVideo: function () {
      var video = document.querySelector('#arjs-video');
      if (video) return video;
      var arjs = this.sceneEl && this.sceneEl.systems && this.sceneEl.systems.arjs;
      var session = arjs && arjs._arSession;
      var source = session && session.arSource;
      return (source && source.domElement) || null;
    },

    /**
     * 补上 AR.js 成功回调里没来得及做的事情（挂视频、标 ready、发 arjs-video-loaded）。
     * AR.js 的 AR context 是监听 arjs-video-loaded 才开始 init 的，不发这个事件识别不会启动。
     */
    recoverArSource: function (video) {
      video.style.position = 'absolute';
      video.style.top = '0px';
      video.style.left = '0px';
      video.style.zIndex = '-2';
      video.setAttribute('id', 'arjs-video');
      document.body.appendChild(video);
      var arjs = this.sceneEl && this.sceneEl.systems && this.sceneEl.systems.arjs;
      var session = arjs && arjs._arSession;
      var source = session && session.arSource;
      if (source) source.ready = true;
      window.dispatchEvent(new CustomEvent('arjs-video-loaded', { detail: { component: video } }));
      console.log('AOYU_CAMERA_SOURCE_RECOVERED');
    },

    isVideoLive: function (video) {
      return !!(video && video.tagName === 'VIDEO' && video.srcObject && video.readyState >= 2);
    },

    onCameraLive: function () {
      if (this.cameraReady) return;
      this.cameraReady = true;
      this.errorEl.textContent = '';
      this.gateEl.classList.remove('show');
      this.hintEl.classList.remove('hidden');
      this.hintEl.textContent = '把整张卡片放进画面';
      console.log('AOYU_CAMERA_LIVE');
    },

    /** 只有用户点过之后才会走到这里：这一步在"用户手势"里，iOS/微信才肯弹权限、才给流 */
    openCameraByGesture: function () {
      var self = this;
      this.errorEl.textContent = '';
      this.gateEl.classList.remove('show');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.showCameraError({ name: 'NotSupported' });
        return;
      }
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      }).then(function (stream) {
        var video = self.findArVideo();
        if (!video) {
          self.pendingStream = stream;      // AR.js 连 video 元素都还没建出来，等它建好再接
          return;
        }
        self.attachStream(video, stream);
      }).catch(function (error) {
        self.showCameraError(error);
      });
    },

    attachStream: function (video, stream) {
      var self = this;
      var detached = !video.parentNode;      // 没挂上去 = AR.js 那次开相机是失败的
      // 顺序很重要：必须先插进 DOM 再给 srcObject。
      // iOS/微信 WebView 下，脱离文档的 video 拿到流之后即使再插进来也一直黑屏。
      if (detached) this.recoverArSource(video);
      video.srcObject = stream;
      video.muted = true;
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
      console.log('AOYU_CAMERA_STREAM_ATTACHED');
      if (this.isVideoLive(video)) this.onCameraLive();
      else {
        video.addEventListener('loadeddata', function () { self.onCameraLive(); }, { once: true });
        setTimeout(function () { self.onCameraLive(); }, 800);
      }
    },

    /** 相机状态：黑屏之类的问题，直接把这个字符串报出来就能定位 */
    cameraStatusText: function () {
      var video = this.findArVideo();
      if (!video) return '相机：还没有 video 元素';
      var rect = video.getBoundingClientRect();
      var style = getComputedStyle(video);
      return '相机：画面 ' + (video.videoWidth || 0) + '×' + (video.videoHeight || 0) +
        '　显示 ' + Math.round(rect.width) + '×' + Math.round(rect.height) +
        '　ready ' + video.readyState +
        '　' + (video.paused ? '暂停' : '播放中') +
        '　' + (video.srcObject ? '有流' : '无流') +
        '　z ' + style.zIndex + '　' + style.display + '/' + style.visibility + '/' + style.opacity;
    },

    showGate: function (error) {
      if (this.cameraReady) return;
      this.gateEl.classList.add('show');
      this.hintEl.classList.add('hidden');
      if (error) console.log('AOYU_CAMERA_BLOCKED', error.name || '', error.message || '');
    },

    showCameraError: function (error) {
      var name = (error && error.name) || '';
      var text;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        text = '摄像头权限被拒绝。请在浏览器的网站设置里允许摄像头，然后刷新页面。';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        text = '没有找到可用的摄像头。';
      } else if (name === 'NotReadableError') {
        text = '摄像头被其它程序占用了，关掉再用摄像头打开的应用，然后刷新页面。';
      } else if (name === 'NotSupported') {
        text = '这个浏览器不支持摄像头 API。';
      } else {
        text = '相机没有启动' + (name ? '（' + name + '）' : '') + '。点这里重试。';
      }
      this.gateEl.classList.remove('show');
      this.errorEl.textContent = text;
      this.errorEl.onclick = function () { location.reload(); };
    },

    /* ---------- 点击：点鱼身出声，点空白吓一跳 ---------- */
    bindTap: function () {
      var self = this;
      var down = null;
      var start = function (event) {
        if (self.isUi(event)) return;
        down = { x: event.clientX, y: event.clientY };
      };
      var end = function (event) {
        if (self.isUi(event)) return;
        if (!down) return;
        var moved = Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y);
        down = null;
        if (moved > 20) return;             // 拖着画面/晃手机不算点击
        self.handleTap(event.clientX, event.clientY);
      };
      window.addEventListener('pointerdown', start, { passive: true });
      window.addEventListener('pointerup', end, { passive: true });
    },

    isUi: function (event) {
      var el = event.target;
      return !!(el && el.closest && el.closest('#ui'));
    },

    handleTap: function (x, y) {
      if (!this.markerActive || this.fishHidden) return;
      var fish = this.activeFish();
      if (!fish) return;
      if (this.hitFish(fish, x, y)) {
        this.playRandomNote();
        return;
      }
      // 点空白：拿点击位置在卡面上的落点当威胁点，鱼朝反方向窜出去
      var local = cardPointFromScreen(x, y);
      var threat = local ? { x: local.x, z: local.z } : null;
      fish.startle(threat);
      console.log('AOYU_STARTLE', fish.key, threat ? threat.x.toFixed(2) + ',' + threat.z.toFixed(2) : 'no-point');
    },

    activeFish: function () {
      return instances[this.targetMode === 'koi' ? 'koi' : 'aoyu'] || null;
    },

    /**
     * 命中判定：先打模型自己的网格（和小程序里的 mesh-shape 一样精准），
     * 没中的话再用放大 20% 的包围盒兜一次（对应小程序的 cube-shape 容差盒）。
     */
    hitFish: function (fish, clientX, clientY) {
      var sceneEl = this.sceneEl;
      var canvas = sceneEl.renderer && sceneEl.renderer.domElement;
      var camera = sceneEl.camera;
      var meshEl = fish.data.anim;
      var mesh = meshEl && meshEl.getObject3D('mesh');
      if (!canvas || !camera || !mesh) return false;
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObject(mesh, true).length) return true;
      var box = new THREE.Box3().setFromObject(mesh);
      if (box.isEmpty()) return false;
      var size = box.getSize(new THREE.Vector3()).multiplyScalar(1.2);
      var center = box.getCenter(new THREE.Vector3());
      box.setFromCenterAndSize(center, size);
      return raycaster.ray.intersectsBox(box);
    },

    /** 随机播一个五声音阶单音，避免连着两次同一个音；不做"掐最早声部"，硬切本身就是爆音 */
    playRandomNote: function () {
      var total = this.players.length;
      var index = Math.floor(Math.random() * total);
      if (index === this.lastNoteIndex) index = (index + 1) % total;
      this.lastNoteIndex = index;
      var player = this.players[index];
      try {
        player.currentTime = 0;
        var p = player.play();
        if (p && p.catch) p.catch(function (err) { console.error('AOYU_NOTE_PLAY_ERROR', err); });
      } catch (error) {
        console.error('AOYU_NOTE_PLAY_ERROR', error);
      }
      console.log('AOYU_NOTE_PLAY', index, CONFIG.notes[index]);
    },

    /* ---------- 卡片在不在画面里 ---------- */
    setMarkerActive: function (active) {
      if (this.markerActive === active) return;
      this.markerActive = active;
      var key = this.targetMode === 'koi' ? 'koi' : 'aoyu';
      var fish = instances[key];
      var hint = document.getElementById('hint');
      if (active) {
        if (hint) hint.classList.add('hidden');
        if (this.hideTimer) {
          // 只是短暂丢失：鱼还没隐藏，取消隐藏，位置不重置（避免瞬移）
          clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
        if (fish && fish.hidden) {
          this.fishHidden = false;
          fish.enter();          // 真的隐藏过了，重新从边缘游进来
        } else if (fish) {
          var animator = fish.animator();
          if (animator) animator.resume();
        }
      } else {
        if (fish) fish.exit();
        if (this.hideTimer) clearTimeout(this.hideTimer);
        var self = this;
        this.hideTimer = setTimeout(function () {
          self.hideTimer = null;
          if (self.markerActive) return;
          if (fish) fish.hide();
          self.fishHidden = true;
        }, CONFIG.hideDelayMs);
      }
    },

    /* ---------- 按系统时间换鱼 ---------- */
    effectiveNow: function () {
      return new Date(Date.now() + this.offsetMs);
    },

    updateTimeMode: function () {
      if (this.forceMode) {
        this.applyMode(this.forceMode);
        return;
      }
      var now = this.effectiveNow();
      this.applyMode(now.getHours() >= CONFIG.switchHour ? 'aoyu' : 'koi');
      this.scheduleSwitch(now);
    },

    scheduleSwitch: function (now) {
      if (this.switchTimer) clearTimeout(this.switchTimer);
      var next = new Date(now.getTime());
      next.setHours(CONFIG.switchHour, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      var delay = Math.max(1000, next.getTime() - now.getTime() + 100);
      var self = this;
      this.switchTimer = setTimeout(function () {
        self.switchTimer = null;
        self.updateTimeMode();
      }, delay);
    },

    applyMode: function (next) {
      var prev = this.targetMode;
      if (prev === next) return;
      this.targetMode = next;
      console.log('AOYU_TIME_MODE', next);

      if (!prev) {
        // 第一次定模式：直接显示（如果卡片已经在画面里，鱼立刻入场）
        this.resetFish();
        if (this.markerActive) {
          this.fishHidden = false;
          if (instances[next]) instances[next].enter();
        }
        this.syncModeButtons();
        return;
      }

      // 换鱼：旧的游走、新的游入，两条同时在场约 0.9 秒
      FishMotion.startExiting(instances[prev].motion);
      if (this.markerActive) {
        instances[next].enter();
        this.fishHidden = false;
      }
      var self = this;
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.transitionTimer = setTimeout(function () {
        self.transitionTimer = null;
        if (self.targetMode !== next) return;
        instances[prev].hide();
        self.syncModeButtons();
      }, CONFIG.transitionMs);
      this.syncModeButtons();
    },

    resetFish: function () {
      Object.keys(instances).forEach(function (key) {
        var fish = instances[key];
        if (key === this.targetMode) return;
        fish.hide();
      }, this);
    },

    /* ---------- 调试面板 ---------- */
    bindDebugPanel: function () {
      var self = this;
      var panel = document.getElementById('debug-panel');
      var toggle = document.getElementById('debug-toggle');
      var clock = document.getElementById('debug-time');
      var modeText = document.getElementById('debug-mode');
      var statusText = document.getElementById('debug-status');

      var format = function (date) {
        var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
          pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
      };

      this.refreshDebug = function () {
        var now = self.effectiveNow();
        clock.textContent = format(now);
        var natural = now.getHours() >= CONFIG.switchHour ? '鳌鱼' : '锦鲤';
        var text = self.forceMode
          ? (self.forceMode === 'aoyu' ? '鳌鱼' : '锦鲤') + '（强制）'
          : natural;
        modeText.textContent = '当前预设：' + text;
        var statusText2 = document.getElementById('debug-camera');
        if (statusText2) statusText2.textContent = self.cameraStatusText();
        var animLine = document.getElementById('debug-anim');
        var activeAnim = self.activeFish() && self.activeFish().animator();
        if (animLine) animLine.textContent = activeAnim ? activeAnim.status() : '摆尾：还没加载';
        var fish = self.activeFish();
        if (!fish) return;
        var status = fish.status();
        statusText.textContent = 'FPS ' + (self.fps || '--') +
          '（渲染×' + (self.pixelRatio ? self.pixelRatio.toFixed(2) : '--') + '）　' +
          '卡片姿态：' + status.posture.name + '（法线偏' + status.posture.tiltDeg + '°）· ' +
          status.state + '　速度×' + status.tuning.speedScale.toFixed(2) +
          ' 转向×' + status.tuning.turnScale.toFixed(2) +
          ' 范围×' + status.tuning.rangeScale.toFixed(2) +
          '（左右各 ' + (0.70 * status.tuning.rangeScale).toFixed(2) + ' 张卡宽，高 0.35~0.90）' +
          ' 大小×' + status.tuning.modelScale.toFixed(2) +
          ' 摆尾上限×' + status.tuning.animSpeedMax.toFixed(1);
      };

      toggle.addEventListener('click', function () {
        var open = panel.classList.toggle('open');
        if (open) {
          self.refreshDebug();
          self.debugClock = setInterval(self.refreshDebug, 1000);
        } else if (self.debugClock) {
          clearInterval(self.debugClock);
          self.debugClock = null;
        }
      });
      document.getElementById('debug-close').addEventListener('click', function () {
        toggle.click();
      });

      var offset = function (minutes) { self.setOffset(self.offsetMs + minutes * 60000); };
      document.getElementById('db-m60').addEventListener('click', function () { offset(-60); });
      document.getElementById('db-m10').addEventListener('click', function () { offset(-10); });
      document.getElementById('db-m1').addEventListener('click', function () { offset(-1); });
      document.getElementById('db-real').addEventListener('click', function () { self.setOffset(0); });
      document.getElementById('db-p1').addEventListener('click', function () { offset(1); });
      document.getElementById('db-p10').addEventListener('click', function () { offset(10); });
      document.getElementById('db-p60').addEventListener('click', function () { offset(60); });
      document.getElementById('db-1959').addEventListener('click', function () { self.setClockAt(19, 59, 55); });
      document.getElementById('db-2001').addEventListener('click', function () { self.setClockAt(20, 1, 0); });
      document.getElementById('db-koi').addEventListener('click', function () { self.setForce('koi'); });
      document.getElementById('db-aoyu').addEventListener('click', function () { self.setForce('aoyu'); });
      document.getElementById('db-follow').addEventListener('click', function () { self.setForce(null); });

      var knob = function (key, delta) {
        var fish = self.activeFish();
        if (!fish) return;
        var limits = CONFIG.tuningLimits[key];
        var next = clamp(fish.tuning[key] + delta, limits[0], limits[1]);
        fish.tuning[key] = Math.round(next * 100) / 100;
        self.saveTuning();
        self.refreshDebug();
      };
      var knobs = [['speedScale', -0.25, 'db-speed-m'], ['speedScale', 0.25, 'db-speed-p'],
        ['turnScale', -0.2, 'db-turn-m'], ['turnScale', 0.2, 'db-turn-p'],
        ['rangeScale', -0.25, 'db-range-m'], ['rangeScale', 0.25, 'db-range-p'],
        ['animSpeedMax', -0.2, 'db-tail-m'], ['animSpeedMax', 0.2, 'db-tail-p'],
        ['modelScale', -0.1, 'db-size-m'], ['modelScale', 0.1, 'db-size-p']];
      knobs.forEach(function (item) {
        document.getElementById(item[2]).addEventListener('click', function () { knob(item[0], item[1]); });
      });
      document.getElementById('db-material').addEventListener('click', function () { self.toggleLightweight(); });
      document.getElementById('db-reset').addEventListener('click', function () {
        var fish = self.activeFish();
        if (fish) fish.tuning = { speedScale: 1, turnScale: 1, rangeScale: 1, animSpeedMax: 2.2, modelScale: 1 };
        self.saveTuning();
        self.refreshDebug();
      });

      this.syncModeButtons();
      this.refreshDebug();
    },

    /** 调参存 localStorage：不然刷新一次就回默认，现场会觉得"莫名其妙又变了" */
    loadSavedTuning: function () {
      try {
        var raw = localStorage.getItem(CONFIG.storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    },

    saveTuning: function () {
      var fish = this.activeFish();
      if (!fish) return;
      try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify({
          tuning: fish.tuning,
          lightweight: !!this.lightweight
        }));
      } catch (error) {
        /* 隐私模式之类写不了就算了 */
      }
    },

    applySavedTuning: function () {
      var saved = this.loadSavedTuning();
      if (!saved || !saved.tuning) return;
      Object.keys(instances).forEach(function (key) {
        var fish = instances[key];
        if (!fish) return;
        Object.keys(saved.tuning).forEach(function (k) {
          if (typeof saved.tuning[k] === 'number') fish.tuning[k] = saved.tuning[k];
        });
      });
      if (saved.lightweight) {
        this.lightweight = true;
        var fish = this.activeFish();
        if (fish) fish.setLightweightMaterials(true);
        var btn = document.getElementById('db-material');
        if (btn) btn.textContent = '材质：轻量';
      }
      console.log('AOYU_TUNING_RESTORED', JSON.stringify(saved.tuning));
    },

    toggleLightweight: function () {
      var fish = this.activeFish();
      if (!fish) return;
      var on = !this.lightweight;
      if (fish.setLightweightMaterials(on)) {
        this.lightweight = on;
        this.saveTuning();
        var btn = document.getElementById('db-material');
        if (btn) btn.textContent = on ? '材质：轻量' : '材质：标准';
        if (this.refreshDebug) this.refreshDebug();
      }
    },

    setOffset: function (offsetMs) {
      this.offsetMs = offsetMs;
      this.forceMode = null;
      this.updateTimeMode();
      if (this.refreshDebug) this.refreshDebug();
      console.log('AOYU_DEBUG_TIME_OFFSET', offsetMs);
    },

    setClockAt: function (hours, minutes, seconds) {
      var real = new Date();
      var target = new Date(real.getTime());
      target.setHours(hours, minutes, seconds || 0, 0);
      this.setOffset(target.getTime() - real.getTime());
    },

    setForce: function (mode) {
      this.forceMode = mode;
      if (this.switchTimer) {
        clearTimeout(this.switchTimer);
        this.switchTimer = null;
      }
      if (mode) {
        this.applyMode(mode);
      } else {
        this.updateTimeMode();
      }
      if (this.refreshDebug) this.refreshDebug();
      console.log('AOYU_TIME_MODE_FORCE', mode || 'clear');
    },

    syncModeButtons: function () {
      var koi = document.getElementById('db-koi');
      var aoyu = document.getElementById('db-aoyu');
      var follow = document.getElementById('db-follow');
      if (!koi) return;
      koi.classList.toggle('on', this.forceMode === 'koi');
      aoyu.classList.toggle('on', this.forceMode === 'aoyu');
      follow.classList.toggle('on', !this.forceMode);
    }
  };

  window.AOYU = app;

  // a-scene 加载完（marker 元素就绪）再初始化
  var sceneEl = document.querySelector('a-scene');
  if (sceneEl.hasLoaded) {
    app.init();
  } else {
    sceneEl.addEventListener('loaded', function () { app.init(); });
  }
})();
