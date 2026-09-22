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
    hideDelayMs: 1000,         // 丢卡后让鱼游走再隐藏
    noteVolume: 0.75,          // 和小程序一致
    clips: { aoyu: 'Ao_Swim_Loop_3.2s', koi: 'Swim_Loop_2.4s' },
    notes: ['note-c6', 'note-d6', 'note-e6', 'note-g6', 'note-a6'].map(function (name) {
      return 'assets/audio/' + name + '.mp3';
    }),
    storageKey: 'aoyu-tuning-v4',   // v1 的『摆尾上限』语义已变成『摆尾倍率』，换键避免旧值生效
    tuningLimits: {
      speedScale: [0.5, 4.0],
      turnScale: [0.5, 1.7],
      rangeScale: [0.5, 8.0],     // 活动范围：1 = 椭圆半径 0.70×0.50 卡宽；小卡片（印在节目单上）要放大很多才游得开
      animSpeedMax: [0.5, 2.5],   // 摆尾倍率（椭圆轨道下它就是骨骼动画的速度倍率）
      modelScale: [0.05, 2.0]     // 鱼的大小（默认基准已是 6 倍，所以下限放到 0.05 方便往回收）
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
      this.wantPaused = false;        // 隐藏时的期望状态；动作创建后再补上
      this.el.addEventListener('model-loaded', function (event) {
        self.setup(event.detail.model);
      });
      // 事件与初始化顺序不保证：模型可能在监听器挂上之前就加载完了，那样事件会被永久错过，
      // 表现就是"摆尾一直不动"（而且是时有时无的竞态）。这里先补一次。
      var mesh = this.el.getObject3D('mesh');
      if (mesh) this.setup(mesh);
    },
    /** 创建混音器与动作；重复调用安全 */
    setup: function (model) {
      if (this.mixer || !model) return;
      var clips = (model && model.animations) || [];
      var clip = THREE.AnimationClip.findByName(clips, this.data.clip) || clips[0];
      if (!clip) {
        console.warn('AOYU_ANIM_NO_CLIP', this.data.clip, clips.map(function (c) { return c.name; }));
        return;
      }
      this.mixer = new THREE.AnimationMixer(model);
      this.action = this.mixer.clipAction(clip);
      this.action.setLoop(THREE.LoopRepeat, Infinity);
      this.action.play();
      this.action.paused = !!this.wantPaused;   // 已经隐藏的鱼，创建后立刻保持暂停
      console.log('AOYU_ANIM_READY', clip.name, clip.duration.toFixed(1) + 's',
        'paused=' + this.action.paused);
    },
    tick: function (time, delta) {
      // 万一事件还是漏了（或其他组件先跑完初始化），这里自己补
      if (!this.mixer) {
        var mesh = this.el.getObject3D('mesh');
        if (!mesh) return;
        this.setup(mesh);
        if (!this.mixer) return;
      }
      var dt = (delta / 1000) * this.data.speed;
      // 混音器时间一旦被 NaN 污染就再也回不来（表现：鱼永远不摆尾），这里必须挡住
      if (!isFinite(dt) || dt <= 0) return;
      this.mixer.update(dt);
    },
    pause: function () {
      this.wantPaused = true;
      if (this.action) this.action.paused = true;
    },
    resume: function () {
      this.wantPaused = false;
      if (this.action) this.action.paused = false;
    },
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
  /**
   * 鱼的游动：沿用老版本 index.html 的那套椭圆轨道。
   *
   * 老版本的做法是"绕卡片中心的固定椭圆 + 贴卡平面 + 固定高度 + 轻微起伏"，
   * 朝向永远跟着轨道的切线走。它比之前那套状态机（随机巡游/冲刺/滑行/悬停 + 重力对齐）
   * 可控得多：鱼始终在卡片附近，不会突然跑远、也不会自己立起来。
   * 摆尾交给 GLB 自带的骨骼动画，这里只按受惊状态给它提速。
   */
  /**
   * 鱼的游动：自己写的「有界漫游」。
   *
   * 目标：像鱼，但**永远不越界**。不照搬小程序那套状态机，也不用纯椭圆轨迹。
   *
   *   1) 活动范围 = 卡片平面内的椭圆 + 高度区间，两个都是硬约束
   *   2) 目标点只在椭圆内部 0.72 半径内随机取（留出余量，不贴边）
   *   3) 朝目标游 + 限速转向（鱼不会原地拐弯），转弯时轻微侧倾
   *   4) 越靠近边界，"向内"的修正越强（软约束，避免贴着边撞）
   *   5) 速度有快有慢（滑行/巡游/冲刺随机切换），摆尾速度跟游速联动
   *   6) 每帧积分之后再做一次硬投影：出椭圆就按比例拉回、高度夹到区间内
   *      —— 所以无论受惊冲刺、掉帧、改范围、改大小，都不可能游出范围
   */
  AFRAME.registerComponent('fish-swim', {
    schema: {
      key: { type: 'string' },
      anim: { type: 'selector' },
      radiusX: { type: 'number', default: 0.70 },   // 椭圆半轴（卡片 = 1 单位）
      radiusZ: { type: 'number', default: 0.50 },
      yMin: { type: 'number', default: 0.32 },      // 悬浮高度区间
      yMax: { type: 'number', default: 0.72 },
      speed: { type: 'number', default: 0.30 },     // 基准速度（单位/秒）
      turnRate: { type: 'number', default: 1.6 },   // 转弯系数：弧度/单位位移；1.6 ≈ 转弯半径 0.63 卡宽
      maxBank: { type: 'number', default: 10 * Math.PI / 180 },
      bobSpeed: { type: 'number', default: 0.5 }    // 上下起伏的快慢
    },
    init: function () {
      var self = this;
      this.rng = Math.random;
      this.pos = { x: 0, y: (this.data.yMin + this.data.yMax) / 2, z: 0 };
      this.head = { x: 0, z: 1 };
      this.target = { x: 0, z: 0 };
      this.targetTime = 0;
      this.targetDuration = 3;
      this.heightPhase = this.rng() * Math.PI * 2;
      this.speed = this.data.speed * 0.6;
      this.speedTarget = this.data.speed;
      this.stateTime = 0;
      this.stateDuration = 0;
      this.bank = 0;
      this.startleUntil = 0;
      this.tuning = { speedScale: 1, turnScale: 1, rangeScale: 5, animSpeedMax: 1, modelScale: 1 };
      this.baseScale = this.el.object3D.scale.x;   // HTML 里写死的模型大小（鳌鱼 0.64 / 锦鲤 0.55）
      this.appliedScale = 1;
      this.hidden = true;
      // 隐藏**不能**用 object3D.visible：A-Frame 在运行时把 visible 设成 false 会把该实体的
      // tick 从行为列表里摘掉，再设回 true 也不会恢复（实测丢卡后摆尾永久停住就是这个原因）。
      // 改成停到很远的地方，tick 照常跑，动画也就一直在。
      this.el.object3D.position.set(0, -50, 0);
      this.pickTarget();
      instances[this.data.key] = this;
    },
    remove: function () {
      if (instances[this.data.key] === this) delete instances[this.data.key];
    },
    animator: function () {
      var el = this.data.anim;
      return el && el.components['fish-anim'];
    },
    /** 量一次鱼的身长（卡宽）：取模型包围盒的水平最长边。模型没加载好返回一个保守值 */
    measureBodyLength: function () {
      // 不缓存：模型加载前后、换模型、改缩放都会变，缓存住的旧值会误导调试
      var el = this.data.anim;
      var root = el && el.getObject3D('mesh');
      // 模型还没加载完时不要缓存兜底值，否则会永久停在 1.00
      if (!root) return 1;
      root.updateWorldMatrix(true, true);
      var box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return 1;
      var size = box.getSize(new THREE.Vector3());
      var len = Math.max(size.x, size.z);
      if (!(len > 0.05) || !isFinite(len)) return 1;
      return len;
    },

    radii: function () {
      return {
        x: this.data.radiusX * this.tuning.rangeScale,
        z: this.data.radiusZ * this.tuning.rangeScale
      };
    },
    /** 只在椭圆内部 0.72 半径处取点，并给一个到达时限（免得卡在某个目标上） */
    pickTarget: function () {
      var r = this.radii();
      var a = this.rng() * Math.PI * 2;
      var k = Math.sqrt(this.rng()) * 0.72;
      this.target.x = Math.cos(a) * r.x * k;
      this.target.z = Math.sin(a) * r.z * k;
      this.targetTime = 0;
      // 时限按"游到那儿要多久"来定，另给 2.5 倍余量；范围放大后不再半路换目标。
      var speedNow0 = Math.max(0.05, this.speed);
      var far = Math.sqrt(this.target.x * this.target.x + this.target.z * this.target.z);
      this.targetDuration = Math.max(3, (far / speedNow0) * 2.5);
    },
    tick: function (time, delta) {
      var d = Math.min(0.05, (delta || 16) / 1000);   // 秒，单帧最多推进 50ms
      if (!d) return;
      if (this.hidden) {
        this.el.object3D.position.set(0, -50, 0);     // 停到远处＝隐藏，但 tick 不中断
        return;
      }
      var r = this.radii();
      var dx = this.target.x - this.pos.x;
      var dz = this.target.z - this.pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      this.targetTime += d;
      if (dist < 0.12 || this.targetTime > this.targetDuration) this.pickTarget();

      // 期望方向：朝目标 + 越靠边越强的向内修正
      var dirX = dist > 1e-4 ? dx / dist : this.head.x;
      var dirZ = dist > 1e-4 ? dz / dist : this.head.z;
      var rn = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                         (this.pos.z / r.z) * (this.pos.z / r.z));   // 0=中心 1=边界
      if (rn > 0.75) {
        var back = Math.min(1, (rn - 0.75) / 0.25) * 2.0;
        var len = Math.sqrt(this.pos.x * this.pos.x + this.pos.z * this.pos.z) || 1;
        dirX -= (this.pos.x / len) * back;
        dirZ -= (this.pos.z / len) * back;
      }
      var dl = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
      dirX /= dl; dirZ /= dl;

      // 限速转向 + 侧倾。
      // 关键：最大转向角速度**跟游速挂钩**（≈ 恒定转弯半径），不再用固定角速度——
      // 固定角速度的毛病是鱼慢下来时也能原地掉头，像死鱼；真实鱼速度越低转得越缓。
      var cur = Math.atan2(this.head.x, this.head.z);
      var want = Math.atan2(dirX, dirZ);
      var diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      var speedNow = Math.max(this.speed, 0.04);
      // 转弯半径跟**鱼自己的身长**挂钩：鱼有多大，转弯半径就该有多大。
      // 之前半径固定 0.63 卡宽，而这条鱼放大后身长 2.9 卡宽——一条 2.9 长的鱼在
      // 半径 0.63 的圈里掉头，看着就是"原地 180°"。
      var bodyLen = this.measureBodyLength();          // 卡宽
      // 半径两头都要顾：
      //   上限：身长 × 1.25（鱼越大转弯半径越大，才不像原地掉头）
      //   下限：场地短半轴 × 0.6（场地小的时候必须能在里面转弯，
      //         否则半径超过场地，鱼就只会绕着码转圈——实测半径 4.07 > 场地 2.5 就是这样）
      var turnRadius = Math.min(bodyLen * 1.25, Math.min(r.x, r.z) * 0.6);
      if (!(turnRadius > 0.05) || !isFinite(turnRadius)) turnRadius = 0.6;
      this.turnRadius = turnRadius;                    // 调试面板显示真实值
      var maxTurn = Math.max(0.12, speedNow / turnRadius) * this.tuning.turnScale * d;
      var turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
      var ang = cur + turn;
      this.head.x = Math.sin(ang);
      this.head.z = Math.cos(ang);
      var bankTarget = maxTurn > 1e-6 ? (turn / maxTurn) * this.data.maxBank : 0;
      this.bank += (bankTarget - this.bank) * Math.min(1, d / 0.25);

      // 速度：滑行/巡游/冲刺随机切换；受惊时整体加速
      this.stateTime += d;
      if (this.stateTime >= this.stateDuration) {
        this.stateTime = 0;
        this.stateDuration = 1.2 + this.rng() * 2.5;
        this.speedTarget = this.data.speed * (0.45 + this.rng() * 1.1);
      }
      var boosting = this.startleUntil > time;
      // 速度跟着范围一起放大：范围是按卡片宽度算的，卡片印小、范围调到 8 倍时，
      // 若速度不变，鱼要花 8 倍时间才能游完一圈——看着就是"卡在原地游不起来"。
      // 这里按 rangeScale 线性放大，保证"游完一圈的时间"与范围无关。
      var rangeBoost = Math.max(0.25, this.tuning.rangeScale);
      var want_speed = this.speedTarget * this.tuning.speedScale * rangeBoost * (boosting ? 3.2 : 1);
      var accel = (want_speed > this.speed ? (boosting ? 4.5 : 1.2) : 0.9) * Math.max(1, rangeBoost * 0.6);
      this.speed += Math.max(-accel * d, Math.min(accel * d, want_speed - this.speed));
      if (!(this.speed > 0)) this.speed = 0;            // 同时挡住 NaN 与负数

      // 积分 + 高度起伏
      this.pos.x += this.head.x * this.speed * d;
      this.pos.z += this.head.z * this.speed * d;
      this.heightPhase += d * this.data.bobSpeed;
      var mid = (this.data.yMin + this.data.yMax) / 2;
      var amp = (this.data.yMax - this.data.yMin) / 2 * 0.8;
      this.pos.y = mid + Math.sin(this.heightPhase) * amp;

      // 硬约束：出椭圆按比例拉回，高度夹进区间（最后一道保险）
      var out = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                          (this.pos.z / r.z) * (this.pos.z / r.z));
      if (out > 1) { this.pos.x /= out; this.pos.z /= out; }
      this.pos.y = Math.max(this.data.yMin, Math.min(this.data.yMax, this.pos.y));

      // 写进场景：朝向 = 航向，侧倾 = 转弯
      if (this.appliedScale !== this.tuning.modelScale) {
        this.appliedScale = this.tuning.modelScale;
        this.el.object3D.scale.setScalar(this.baseScale * this.tuning.modelScale);
      }
      this.el.object3D.position.set(this.pos.x, this.pos.y, this.pos.z);
      this.el.object3D.quaternion.setFromEuler(new THREE.Euler(0, ang, this.bank, 'YXZ'));

      // 摆尾：以游速为主，但别再压到半速——之前是 ratio(下限 0.5)×倍率，
      // 鱼在滑行时只有基准速度的 0.45 倍，看起来就是"尾巴慢吞吞"。
      // 现在改成 0.9 + ratio×0.8（滑行也至少 1.2 倍），上限放到 3.4。
      var animator = this.animator();
      var ratio = this.speed / (this.data.speed || 1);
      var tail = Math.max(1.2, Math.min(3.4, 0.9 + ratio * 0.8)) * this.tuning.animSpeedMax;
      if (!(tail > 0) || !isFinite(tail)) tail = 1;      // 摆尾倍率绝不能是 NaN/0：混音器时间一旦变 NaN 就永久停住
      if (animator) animator.data.speed = tail * (boosting ? 1.6 : 1);

      this.boosting = boosting;
      this.moving = this.speed > 0.02;
    },
    show: function () {
      // 摆尾动画一直跑着，不暂停也不恢复——少一个依赖就少一个"回来之后不动"的机会
      this.hidden = false;
    },
    hide: function () {
      this.hidden = true;   // 下一帧 tick 把鱼停到远处（不动 visible，动画也就不会停）
    },
    enter: function () { this.show(); },
    exit: function () { /* 游动是连续的，丢卡时直接由 hide 收尾 */ },
    /** 点屏幕吓一跳：短时间内大幅提速（依旧被硬约束限制在范围内） */
    startle: function () {
      this.startleUntil = performance.now() + 900;
    },
    status: function () {
      var r = this.radii();
      return {
        posture: { name: '贴卡平面（有界漫游）', tiltDeg: 0 },
        tuning: this.tuning,
        state: this.boosting ? '受惊加速' : (this.moving ? '巡游' : '悬停'),
        radius: { x: r.x.toFixed(2), z: r.z.toFixed(2) },
        bodyLen: this.measureBodyLength(),
        turnRadius: (this.turnRadius || 0) / Math.max(0.2, this.tuning.turnScale),
        height: this.data.yMin.toFixed(2) + '~' + this.data.yMax.toFixed(2),
        t: this.speed.toFixed(2),
        pos: this.el.object3D.position
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
      // 播放走 Web Audio：<audio>.play() 有解码+管线启动延迟（iOS 上尤其明显，
      // 每个文件第一次播放最严重），听起来就是"点了之后才响"。
      // 这里启动时把 5 个 mp3 全部解码成 AudioBuffer，点的时候直接 start()。
      this.noteBuffers = [];
      this.initWebAudio();
      // 兜底：万一浏览器没有 Web Audio，仍然用 <audio>
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
      this.bindStartOverlay();
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

    /**
     * 启动页（还原老版本的流程）：按钮本身就是"用户手势"，点完才开相机。
     * iOS / 微信 WebView 里 getUserMedia 必须有手势，走这条路最稳。
     * 资源（两个 GLB）没加载完按钮不可点，免得点进去空等。
     */
    bindStartOverlay: function () {
      var self = this;
      var overlay = document.getElementById('start-overlay');
      var button = document.getElementById('start-ar-button');
      if (!overlay || !button) return;
      this.startOverlay = overlay;

      button.addEventListener('click', function () {
        if (button.disabled) return;
        self.resumeAudio();
        button.disabled = true;
        button.textContent = '正在打开相机…';
        console.log('AOYU_START_TAP');
        // 启动页先留着：AR.js 的 video 刚插进 DOM 时还没定尺寸，那一刻会看到
        // "小画面 + 四周黑边"，随后才被拉到 cover。等 onCameraLive 再收，就不会看到这段过渡。
        self.pendingStart = true;
        if (window.AOYU_USE_IMAGE_TRACKER) {
          overlay.classList.add('hidden');
          self.pendingStart = false;
          // 相机交给 image-tracker；它开不起来时会把提示写在 #ar-error 上，
          // 顺手替用户点一下（这一次点击同样是用户手势）
          var retry = document.getElementById('ar-error');
          if (retry && retry.textContent.trim() && typeof retry.onclick === 'function') retry.onclick();
          return;
        }
        var video = self.findArVideo();
        if (video && self.isVideoLive(video)) {
          // 相机在点按钮之前就已经就绪（AR.js 一加载就开相机，这是常态）：
          // 直接进。这里不能走 onCameraLive——它开头有 if (cameraReady) return，
          // 而 cameraReady 早就被置过了，会直接把启动页卡住。
          self.closeStartOverlay();
          self.onCameraLive();
        } else if (video && video.srcObject) {
          self.attachStream(video, video.srcObject);   // 有流但还没出画面：踢一下
        } else {
          self.openCameraByGesture();
        }
        // 兜底：8 秒还没画面就报错并把启动页收掉，不让人干等
        setTimeout(function () {
          if (self.pendingStart) self.showCameraError({ name: 'Timeout' });
        }, 8000);
      });

      var assets = document.querySelector('a-assets');
      var enable = function () {
        if (!button.disabled) return;
        button.disabled = false;
        button.textContent = '进入鳌鱼世界';
        console.log('AOYU_START_READY');
      };
      if (assets) {
        if (assets.hasLoaded) enable();
        else {
          assets.addEventListener('loaded', enable);
          assets.addEventListener('timeout', enable);
        }
      }
      setTimeout(enable, 6000);   // 模型就绪得慢也别一直卡在"资源准备中"
    },

    /** 预解码五声音阶：解码完成前点击会自动退回 <audio> */
    initWebAudio: function () {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var self = this;
      this.audioCtx = new Ctx();
      this.noteGain = this.audioCtx.createGain();
      this.noteGain.gain.value = CONFIG.noteVolume;
      this.noteGain.connect(this.audioCtx.destination);
      CONFIG.notes.forEach(function (src, index) {
        fetch(src)
          .then(function (res) { return res.arrayBuffer(); })
          .then(function (buf) { return self.audioCtx.decodeAudioData(buf); })
          .then(function (decoded) {
            self.noteBuffers[index] = decoded;
            console.log('AOYU_NOTE_DECODED', index, decoded.duration.toFixed(2) + 's');
          })
          .catch(function (error) { console.error('AOYU_NOTE_DECODE_ERROR', index, error); });
      });
    },

    /**
     * 收起启动页。只在用户点过「进入」之后才动它（pendingStart），
     * 免得相机比用户先就绪时把启动页自己关掉。
     * 幂等：重复调用安全。
     */
    closeStartOverlay: function () {
      if (!this.pendingStart) return;
      this.pendingStart = false;
      if (this.startOverlay) this.startOverlay.classList.add('hidden');
      console.log('AOYU_START_ENTER');
    },

    /** 用户手势里必须把 AudioContext 唤醒（iOS/微信要），否则 start() 不出声 */
    resumeAudio: function () {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(function () {});
      }
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
      // 用图像特征跟踪时，相机和画面由 js/image-tracker.js 负责，这里不要抢
      if (window.AOYU_SKIP_CAMERA) return;
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
      this.closeStartOverlay();   // 相机出画面了才收启动页
      this.errorEl.textContent = '';
      this.gateEl.classList.remove('show');
      this.hintEl.classList.remove('hidden');
      this.hintEl.textContent = '把整张鳌鱼二维码放进画面';
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
      this.closeStartOverlay();   // 相机起不来也要收，否则错误卡被启动页盖住
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
      this.resumeAudio();
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
     * 命中判定：用**骨骼的世界坐标**做包围盒（骨骼才是当前姿势）。
     *
     * 试过的坑：
     *   1) mesh.raycast / Box3.setFromObject → 用绑定姿势几何体，和摆过尾的鱼对不上（命中 0 次）
     *   2) 模型本地包围盒（OBB）→ 绑定姿势的几何体尺寸和实际渲染差得多，盒子虚胖（84 点中 56）
     *   3) 只按骨骼算 → 尺寸对（11%），但骨骼沿脊椎是一条细线，横截面太薄，鱼鳍尾部点不中
     *
     * 现在＝骨骼包围盒 + 手指容差：
     *   - 骨骼世界坐标 → 当前姿势的准确位置与长度
     *   - 每边外扩 0.07（卡片宽度的 7%）
     *   - 每个轴至少 0.22 厚，避免脊椎塌成一条细线时判定区过小
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
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
              -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);

      // 非蒙皮模型这一层就够精准
      if (raycaster.intersectObject(mesh, true).length) return true;

      var bones = this._bones;
      if (!bones || bones.el !== mesh) {
        bones = [];
        mesh.traverse(function (node) { if (node.isBone) bones.push(node); });
        bones.el = mesh;
        this._bones = bones;
      }
      if (!bones.length) {
        var fallback = new THREE.Box3().setFromObject(mesh);
        if (fallback.isEmpty()) return false;
        fallback.expandByScalar(0.07);
        return raycaster.ray.intersectsBox(fallback);
      }
      var box = new THREE.Box3();
      var v = new THREE.Vector3();
      for (var i = 0; i < bones.length; i++) {
        box.expandByPoint(bones[i].getWorldPosition(v));
      }
      box.expandByScalar(0.07);                    // 手指容差
      var size = box.getSize(new THREE.Vector3());
      var center = box.getCenter(new THREE.Vector3());
      size.set(Math.max(size.x, 0.22), Math.max(size.y, 0.22), Math.max(size.z, 0.22));
      box.setFromCenterAndSize(center, size);
      return raycaster.ray.intersectsBox(box);
    },

    /** 随机播一个五声音阶单音，避免连着两次同一个音；不做"掐最早声部"，硬切本身就是爆音 */
    playRandomNote: function () {
      var total = this.players.length;
      var index = Math.floor(Math.random() * total);
      if (index === this.lastNoteIndex) index = (index + 1) % total;
      this.lastNoteIndex = index;
      var buffer = this.noteBuffers && this.noteBuffers[index];
      if (this.audioCtx && buffer) {
        this.resumeAudio();
        var source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.noteGain);
        source.start();                       // 立即出声，无解码等待
        console.log('AOYU_NOTE_PLAY', index, CONFIG.notes[index], 'web-audio');
        return;
      }
      // 兜底路径
      var player = this.players[index];
      try {
        player.currentTime = 0;
        var p = player.play();
        if (p && p.catch) p.catch(function (err) { console.error('AOYU_NOTE_PLAY_ERROR', err); });
      } catch (error) {
        console.error('AOYU_NOTE_PLAY_ERROR', error);
      }
      console.log('AOYU_NOTE_PLAY', index, CONFIG.notes[index], 'audio-element');
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

      // 换鱼：直接硬切——新的入场、旧的立刻隐藏。
      // （小程序那边是"旧的游走、新的游入，同框 0.9 秒"；椭圆轨道没有游走动作，
      //   同框那 0.9 秒看起来就是"两条鱼同时冒出来"，所以这里不保留交叉过渡。
      //   另外原来这里调 FishMotion.startExiting(instances[prev].motion)，
      //   换掉状态机之后 .motion 不存在，会抛异常把整个切换流程打断——那才是切换失效的原因。）
      if (this.markerActive) {
        instances[next].enter();
        this.fishHidden = false;
      }
      if (instances[prev]) instances[prev].hide();
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
          '游动：有界漫游　半径 ' + status.radius.x + '×' + status.radius.z + ' 张卡宽' +
          '　高 ' + status.height + '　' + status.state + '　' +
          '速度×' + status.tuning.speedScale.toFixed(2) +
          ' 转向×' + status.tuning.turnScale.toFixed(2) +
          ' 范围×' + status.tuning.rangeScale.toFixed(2) +
          ' 摆尾×' + status.tuning.animSpeedMax.toFixed(2) +
          ' 大小×' + status.tuning.modelScale.toFixed(2) +
          '　身长 ' + status.bodyLen.toFixed(2) + ' 转弯半径 ' + status.turnRadius.toFixed(2) + ' 卡宽' +
          '　当前速度 ' + status.t + ' 位置 ' + status.pos.x.toFixed(2) + ',' +
          status.pos.y.toFixed(2) + ',' + status.pos.z.toFixed(2);
      };

      // 常驻刷新：以前只在面板打开时刷新，没打开时那行是旧快照，容易被误当成"鱼不动了"
      if (self.debugClock) clearInterval(self.debugClock);
      self.debugClock = setInterval(self.refreshDebug, 1000);
      toggle.addEventListener('click', function () {
        panel.classList.toggle('open');
        self.refreshDebug();
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
        // 防御 NaN：clamp 的实现对 NaN 会把 NaN 原样传下去，一旦存进去就永久坏掉
        var base = fish.tuning[key];
        if (typeof base !== 'number' || !isFinite(base)) base = 1;
        var next = clamp(base + delta, limits[0], limits[1]);
        fish.tuning[key] = Math.round(next * 100) / 100;
        self.saveTuning();
        self.refreshDebug();
      };
      var knobs = [['speedScale', -0.25, 'db-speed-m'], ['speedScale', 0.25, 'db-speed-p'],
        ['turnScale', -0.2, 'db-turn-m'], ['turnScale', 0.2, 'db-turn-p'],
        ['rangeScale', -0.5, 'db-range-m'], ['rangeScale', 0.5, 'db-range-p'],
        ['animSpeedMax', -0.2, 'db-tail-m'], ['animSpeedMax', 0.2, 'db-tail-p'],
        ['modelScale', -0.1, 'db-size-m'], ['modelScale', 0.1, 'db-size-p']];
      knobs.forEach(function (item) {
        document.getElementById(item[2]).addEventListener('click', function () { knob(item[0], item[1]); });
      });
      document.getElementById('db-material').addEventListener('click', function () { self.toggleLightweight(); });
      document.getElementById('db-reset').addEventListener('click', function () {
        var fish = self.activeFish();
        if (fish) fish.tuning = { speedScale: 1, turnScale: 1, rangeScale: 5, animSpeedMax: 1, modelScale: 1 };
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
          if (typeof saved.tuning[k] === 'number' && isFinite(saved.tuning[k])) fish.tuning[k] = saved.tuning[k];
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
