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

  // 自适应缩放允许椭圆碰到画面的这个边界（0.8 = 四周各留 10% 余量），以及最小倍率
  var SCREEN_FIT_LIMIT = 0.8;
  var SCREEN_FIT_MIN = 0.1;

  var CONFIG = {
    switchHour: 20,            // 20:00 之后显示鳌鱼，之前显示锦鲤
    hideDelayMs: 1000,         // 丢卡后让鱼游走再隐藏
    noteVolume: 0.75,          // 和小程序一致
    clips: { aoyu: 'Ao_Swim_Loop_3.2s', koi: 'Swim_Loop_2.4s' },
    notes: ['note-c6', 'note-d6', 'note-e6', 'note-g6', 'note-a6'].map(function (name) {
      return 'assets/audio/' + name + '.mp3';
    }),
    storageKey: 'aoyu-tuning-v4',   // v1/v2 的『摆尾上限』语义已变成『摆尾倍率』，换键避免旧值生效
    // 惊吓（点空白让鱼窜出去）：速度倍率可调（默认 4×），冲刺 1.1 秒。
    // 关键点是冲刺期间**转弯半径跟着速度一起放大**，角速度不跟着飙，所以是"直线窜走"，
    // 不会像旧版那样在原地快速打转。
    startleEnabled: true,
    startleMs: 1100,
    tuningLimits: {
      speedScale: [0.5, 4.0],
      turnScale: [0.5, 1.7],
      rangeScale: [0.5, 8.0],     // 活动范围：1 = 椭圆半径 0.70×0.50 卡宽；小卡片（印在节目单上）要放大很多才游得开
      animSpeedMax: [0.5, 2.5],   // 摆尾倍率（椭圆轨道下它就是骨骼动画的速度倍率）
      startleSpeed: [1.5, 8.0],   // 惊吓冲刺速度倍率（相对巡航速度）
      modelScale: [0.05, 2.0]     // 鱼的大小（默认基准已是 6 倍，所以下限放到 0.05 方便往回收）
    }
  };

  var instances = {};                       // key -> fish-swim 组件实例
  var app = null;                           // 主控
  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var plane = new THREE.Plane();
  var tmpVec = new THREE.Vector3();
  var tmpVec2 = new THREE.Vector3();
  var tmpQuat = new THREE.Quaternion();

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /**
   * AR.js 每帧把它的投影矩阵**直接拷**进 camera.projectionMatrix，three 的
   * projectionMatrixInverse 不会跟着更新；而 Raycaster.setFromCamera 用的正是那个逆矩阵。
   * 不同步的话，"手指点的屏幕位置"和"算出来的射线方向"就对不上——点鱼有时点不中、
   * 越靠画面边缘偏得越多，就是这个原因。这里只在投影矩阵变化时重算一次。
   */
  var lastProj = { a: NaN, b: NaN };
  function syncProjectionInverse(camera) {
    if (!camera || !camera.projectionMatrixInverse) return;
    var m = camera.projectionMatrix.elements;
    if (m[0] === lastProj.a && m[5] === lastProj.b) return;
    lastProj.a = m[0];
    lastProj.b = m[5];
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /** 调试用的碰撞盒挂在模型下面，包围盒测量必须跳过它自己，否则会越算越大 */
  function isDebugHitBox(node) {
    if (node.userData && node.userData.aoyuDebug) return true;
    var el = node.el;
    return !!(el && el.closest && el.closest('#hit-box'));
  }

  /** 屏幕坐标 → 卡片局部坐标（打到卡面平面上）；打不到（卡几乎侧对镜头）返回 null */
  function cardPointFromScreen(clientX, clientY) {
    var sceneEl = document.querySelector('a-scene');
    var marker = document.getElementById('ar-marker');
    var camera = sceneEl && sceneEl.camera;
    var canvas = sceneEl && sceneEl.renderer && sceneEl.renderer.domElement;
    if (!marker || !camera || !canvas) return null;
    syncProjectionInverse(camera);
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
   * 调试用：把命中判定用的那个包围盒画出来
   *   - 挂在当前这条鱼的模型节点下，坐标就是模型本地坐标，永远和鱼同一个姿态
   *   - 每帧调 app.fishLocalBox() 重算，和点击命中用的是同一个函数：看到的即判定用的
   * ========================================================================= */
  AFRAME.registerComponent('hitbox-debug', {
    init: function () {
      this.el.setAttribute('geometry', 'primitive: box');
      this.el.setAttribute('material',
        'shader: flat; color: #ff2bd6; opacity: 0.14; transparent: true; depthTest: false');
      var wire = document.createElement('a-entity');
      wire.setAttribute('geometry', 'primitive: box');
      wire.setAttribute('material',
        'shader: flat; color: #ff2bd6; wireframe: true; transparent: true; opacity: 0.95; depthTest: false');
      this.el.appendChild(wire);
      this.el.object3D.userData.aoyuDebug = true;     // 各种包围盒测量要跳过它自己
      wire.object3D.userData.aoyuDebug = true;
      this.size = new THREE.Vector3();
      this.center = new THREE.Vector3();
    },
    tick: function () {
      var fish = app && app.activeFish();
      var animEl = fish && fish.data.anim;
      var mesh = animEl && animEl.getObject3D('mesh');
      if (!fish || !animEl || !mesh) return;
      // 直接把盒子挂到模型对象下面：坐标系和命中判定用的那套（模型本地坐标）完全一致，
      // 中间不管有多少层旋转/缩放都不会错位。
      if (this.el.object3D.parent !== mesh) mesh.add(this.el.object3D);
      var box = app.fishLocalBox(mesh);
      if (!box) return;
      box.getSize(this.size);
      box.getCenter(this.center);
      this.el.object3D.position.copy(this.center);
      this.el.object3D.scale.copy(this.size);
      this.el.object3D.visible = !fish.hidden;    // 鱼藏起来了盒子也别留着
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
      this.tuning = { speedScale: 1, turnScale: 1, rangeScale: 5, animSpeedMax: 1, modelScale: 1, startleSpeed: 4 };
      this.baseScale = this.el.object3D.scale.x;   // HTML 里写死的模型大小（鳌鱼 0.64 / 锦鲤 0.55）
      this.appliedScale = 0;   // 0 表示还没写过缩放，第一帧一定会写一次
      this.hidden = true;
      // 隐藏这条鱼有两个坑，都不能踩：
      //   1) 不能动 A-Frame 的 visible —— 运行时把实体设成不可见，它的 tick 会被摘掉，
      //      再设回可见也不恢复（丢卡后摆尾永久停住就是这么来的）。
      //   2) 不能"停到远处"——卡片坐标系里没有任何遮挡物，停在 y=-50 卡宽的位置照样落在
      //      相机视锥里，画面上就是"另一条小鱼远远地在飘"。
      // 正确做法：只关掉 gltf 那一层（three 的 mesh）的渲染。渲染器不画它，tick 和骨骼
      // 动画照常跑，重新找到卡时一开就接着游。
      this.wantModelVisible = false;
      this.fit = 1;          // 自适应缩放倍率（见 screenFit），只有打开自适应开关才会 < 1
      this.adaptive = false;  // 「自适应：整幅构图一定留在画面内」，调试面板里开关
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
      var box = new THREE.Box3();
      var tmp = new THREE.Box3();
      root.traverse(function (node) {
        if (!node.isMesh || !node.geometry) return;
        if (isDebugHitBox(node)) return;                        // 跳过调试用的碰撞盒
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        if (!node.geometry.boundingBox) return;
        box.union(tmp.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld));
      });
      if (box.isEmpty()) return 1;
      var size = box.getSize(new THREE.Vector3());
      var len = Math.max(size.x, size.z);
      if (!(len > 0.05) || !isFinite(len)) return 1;
      return len;
    },

    /** 冲刺速度（卡宽/秒）：鱼自己会朝这个速度冲，受惊时用 */
    dashSpeed: function () {
      var rangeBoost = Math.max(0.25, this.tuning.rangeScale * this.fit);
      return this.data.speed * this.tuning.startleSpeed * this.tuning.speedScale * rangeBoost;
    },

    /** 用户调出来的活动椭圆（不含自适应缩放），单位＝卡宽 */
    rawRadii: function () {
      return {
        x: this.data.radiusX * this.tuning.rangeScale,
        z: this.data.radiusZ * this.tuning.rangeScale
      };
    },

    /** 这一帧真正用的椭圆：用户设的范围 × 自适应缩放 */
    radii: function () {
      var r = this.rawRadii();
      return { x: r.x * this.fit, z: r.z * this.fit };
    },

    /** 悬浮高度区间 × 自适应缩放（构图整体等比缩放，比例不变） */
    yMin: function () { return this.data.yMin * this.fit; },
    yMax: function () { return this.data.yMax * this.fit; },

    /** 模型最终缩放 = HTML 基准 × 手调大小 × 自适应缩放 */
    applyModelScale: function () {
      var want = this.baseScale * this.tuning.modelScale * this.fit;
      if (Math.abs(want - this.appliedScale) > 1e-4) {
        this.appliedScale = want;
        this.el.object3D.scale.setScalar(want);
      }
    },

    /**
     * 以 k 倍画活动椭圆（连同悬浮高度），检查整圈是不是都在镜头前方并且留在画面内。
     * 采样 24 个点：任何一点跑到镜头后面或者出画面都算装不下。
     */
    fitsAt: function (k, camera) {
      var r = this.rawRadii();
      var y = (this.data.yMin + this.data.yMax) / 2 * k;
      for (var i = 0; i < 24; i++) {
        var a = (i / 24) * Math.PI * 2;
        tmpVec.set(Math.cos(a) * r.x * k, y, Math.sin(a) * r.z * k);
        this.el.object3D.localToWorld(tmpVec);
        // 镜头后面（相机空间 z >= 0）的点投影会翻号，不能拿来算
        if (tmpVec2.copy(tmpVec).applyMatrix4(camera.matrixWorldInverse).z > -0.01) return false;
        tmpVec.project(camera);
        if (Math.abs(tmpVec.x) > SCREEN_FIT_LIMIT || Math.abs(tmpVec.y) > SCREEN_FIT_LIMIT) return false;
      }
      return true;
    },

    /**
     * 自适应缩放：活动椭圆是按**卡宽**定义的，卡在画面里占满的时候
     * （大卡片／手机凑得很近），7×5 卡宽的范围早就跑到画面外了，鱼大半时间在镜头外面游，
     * 看起来就像"空间算错了""鱼游丢了"。这里量出"整幅构图刚好留在画面内"的倍率，
     * 鱼的大小、活动范围、悬浮高度一起等比缩。
     *
     * 卡小的时候倍率恒为 1，一点也不会改手调好的观感；只有画面装不下时才缩。
     */
    screenFit: function () {
      var sceneEl = document.querySelector('a-scene');
      var camera = sceneEl && sceneEl.camera;
      if (!camera) return 1;
      if (this.fitsAt(1, camera)) return 1;
      var lo = SCREEN_FIT_MIN, hi = 1;
      for (var i = 0; i < 8; i++) {
        var mid = (lo + hi) / 2;
        if (this.fitsAt(mid, camera)) lo = mid; else hi = mid;
      }
      return lo;
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
      // 每帧对齐一次"这条鱼要不要画"。必须放在最前面：隐藏期间也要跑，
      // 因为模型是异步加载的，加载完成时这一行才能把它立刻关掉。
      var modelEl = this.data.anim;
      var modelRoot = modelEl && modelEl.getObject3D('mesh');
      if (modelRoot && modelRoot.visible !== this.wantModelVisible) {
        modelRoot.visible = this.wantModelVisible;
      }
      var d = Math.min(0.05, (delta || 16) / 1000);   // 秒，单帧最多推进 50ms
      if (!d) return;
      if (this.hidden) return;    // 位置保持不动，重新找到卡时接着往下游

      if (this.adaptive) {
        // 装不下就较快地收（约 0.3 秒），装得下就慢慢放回去——放太快会看到范围忽大忽小
        var fitWant = this.screenFit();
        this.fit += (fitWant - this.fit) * Math.min(1, d * (fitWant < this.fit ? 6 : 1));
        if (!(this.fit > 0.05) || !isFinite(this.fit)) this.fit = fitWant;
      } else if (this.fit !== 1) {
        this.fit = 1;
      }

      var r = this.radii();
      var boosting = this.startleUntil > time;
      var rn = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                         (this.pos.z / r.z) * (this.pos.z / r.z));   // 0=中心 1=边界
      var dx = this.target.x - this.pos.x;
      var dz = this.target.z - this.pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      this.targetTime += d;
      var dirX, dirZ;
      if (boosting && this.startleDir) {
        // 冲刺：不追目标点，朝逃跑方向直着窜；窜到活动边界的 95% 就收
        dirX = this.startleDir.x;
        dirZ = this.startleDir.z;
        if (rn > 0.95) { boosting = false; this.startleUntil = 0; }
      } else {
        // 正常巡游：朝目标 + 越靠边越强的向内修正
        if (dist < 0.12 || this.targetTime > this.targetDuration) this.pickTarget();
        dirX = dist > 1e-4 ? dx / dist : this.head.x;
        dirZ = dist > 1e-4 ? dz / dist : this.head.z;
        if (rn > 0.75) {
          var back = Math.min(1, (rn - 0.75) / 0.25) * 2.0;
          var len = Math.sqrt(this.pos.x * this.pos.x + this.pos.z * this.pos.z) || 1;
          dirX -= (this.pos.x / len) * back;
          dirZ -= (this.pos.z / len) * back;
        }
      }
      if (this.boosting && !boosting) this.pickTarget();   // 冲刺刚结束：挑个新目标继续巡游
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
      // 冲刺时转弯半径跟速度一起放大：角速度≈不变，所以是"直线窜出去"，
      // 而不是旧版那样在原地快速打转（角速度也乘 3.2）。
      if (boosting) turnRadius *= Math.max(1.5, this.tuning.startleSpeed * 0.7);
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
      // 速度按"实际能游的范围"线性放大：范围是按卡片宽度算的，卡片印小、范围调到 8 倍时，
      // 若速度不变，鱼要花 8 倍时间才能游完一圈——看着就是"卡在原地游不起来"；
      // 反过来，自适应把范围缩小之后速度也要跟着缩，否则鱼会在缩小的圈里狂转。
      // 两种情况都靠这一个系数，保证"游完一圈的时间"与范围无关。
      var rangeBoost = Math.max(0.25, this.tuning.rangeScale * this.fit);
      var want_speed = boosting
        ? Math.max(this.dashSpeed(), this.speedTarget * this.tuning.speedScale * rangeBoost * 1.5)
        : this.speedTarget * this.tuning.speedScale * rangeBoost;
      // 冲刺时加速要猛；冲刺结束后速度远高于巡航，收油也要明显，不然会一路滑出去
      var over = this.speed > want_speed * 1.3;
      var accel = (want_speed > this.speed ? (boosting ? 9 : 1.2) : (over ? 3.2 : 0.9)) *
        Math.max(1, rangeBoost * 0.6);
      this.speed += Math.max(-accel * d, Math.min(accel * d, want_speed - this.speed));
      if (!(this.speed > 0)) this.speed = 0;            // 同时挡住 NaN 与负数

      // 积分 + 高度起伏
      this.pos.x += this.head.x * this.speed * d;
      this.pos.z += this.head.z * this.speed * d;
      this.heightPhase += d * this.data.bobSpeed;
      var mid = (this.yMin() + this.yMax()) / 2;
      var amp = (this.yMax() - this.yMin()) / 2 * 0.8;
      this.pos.y = mid + Math.sin(this.heightPhase) * amp;

      // 硬约束：出椭圆按比例拉回，高度夹进区间（最后一道保险）
      var out = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                          (this.pos.z / r.z) * (this.pos.z / r.z));
      if (out > 1) { this.pos.x /= out; this.pos.z /= out; }
      this.pos.y = Math.max(this.yMin(), Math.min(this.yMax(), this.pos.y));

      // 写进场景：朝向 = 航向，侧倾 = 转弯
      this.applyModelScale();
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
      // 只切"画不画模型"这一个开关：不碰实体 visible（tick 会被摘掉），
      // 也不重置位置，摆尾动画从头到尾没停过。
      this.hidden = false;
      this.wantModelVisible = true;
    },
    hide: function () {
      this.hidden = true;
      this.wantModelVisible = false;
    },
    enter: function () { this.show(); },
    exit: function () { /* 游动是连续的，丢卡时直接由 hide 收尾 */ },
    /**
     * 点空白吓一跳。旧版只是把速度乘 3.2（转弯半径不变 → 角速度也乘 3.2），
     * 表现出来就是在原地快速打转。现在改成"定一个逃跑方向 + 直线冲刺"：
     *   1) 期望方向 = 背对点击处，再混一点当前航向（免得掉头绕大圈）
     *   2) 在这个方向附近 ±0.8 弧度里挑一个"前方空间最大"的（贴边时不会一冲就撞边界）
     *   3) 冲刺期间朝这个方向直着窜，转弯半径跟着速度放大——角速度和巡航差不多，
     *      所以是窜出去，不是原地打转；撞到活动边界或者时间到就收
     */
    startle: function (threat) {
      var now = performance.now();
      if (now < this.startleUntil) return;      // 正在窜，别被连续点击打断成原地抖
      var dx = this.pos.x - (threat ? threat.x : 0);
      var dz = this.pos.z - (threat ? threat.z : 0);
      var len = Math.sqrt(dx * dx + dz * dz);
      if (!(len > 1e-4)) { dx = this.head.x; dz = this.head.z; }   // 正好按在鱼身上：沿当前航向
      else { dx /= len; dz /= len; }
      // 先算"背对威胁点 + 混一点当前航向"的期望方向
      var mx = dx * 0.8 + this.head.x * 0.5;
      var mz = dz * 0.8 + this.head.z * 0.5;
      var ml = Math.sqrt(mx * mx + mz * mz);
      if (ml > 1e-4) { mx /= ml; mz /= ml; }

      // 在期望方向附近挑一个"前方空间最大"的方向：贴边时如果还朝外冲，
      // 冲刺会在几十毫秒内撞到边界直接结束（实测就是这样，看起来没反应）。
      var base = Math.atan2(mz, mx);
      var best = null;
      for (var i = -2; i <= 2; i++) {
        var a = base + i * 0.4;
        var cx = Math.cos(a), cz = Math.sin(a);
        var dist = this.ellipseExitDistance(this.pos.x, this.pos.z, cx, cz, 0.9);
        if (!best || dist > best.dist) best = { dist: dist, x: cx, z: cz };
      }
      this.startleDir = { x: best.x, z: best.z };
      this.target.x = this.pos.x + best.x * best.dist;
      this.target.z = this.pos.z + best.z * best.dist;
      this.targetTime = 0;
      this.targetDuration = 10;                  // 冲刺期间不换目标
      this.startleUntil = now + CONFIG.startleMs;
      // 起步就窜：直接给到冲刺速度的一半多，剩下的靠加速度补
      this.speed = Math.max(this.speed, this.dashSpeed() * 0.6);
      console.log('AOYU_STARTLE_SET 逃脱距离=' + best.dist.toFixed(2) +
        ' 冲刺速度=' + this.dashSpeed().toFixed(2) + ' 当前速度=' + this.speed.toFixed(2));
    },

    /** 从 (px,pz) 沿 (dx,dz) 走到椭圆 k 倍边界要走多远（解一元二次） */
    ellipseExitDistance: function (px, pz, dx, dz, k) {
      var r = this.radii();
      var kx = r.x * k, kz = r.z * k;
      var a = (dx / kx) * (dx / kx) + (dz / kz) * (dz / kz);
      var b = 2 * (px * dx / (kx * kx) + pz * dz / (kz * kz));
      var c = (px / kx) * (px / kx) + (pz / kz) * (pz / kz) - 1;
      var disc = b * b - 4 * a * c;
      if (!(disc > 0) || !(a > 0)) return 0.2;
      var s = (-b + Math.sqrt(disc)) / (2 * a);
      return s > 0.2 ? s : 0.2;
    },

    status: function () {
      var r = this.radii();
      return {
        posture: { name: '贴卡平面（有界漫游）', tiltDeg: 0 },
        tuning: this.tuning,
        state: this.boosting ? '受惊冲刺' : (this.moving ? '巡游' : '悬停'),
        radius: { x: r.x.toFixed(2), z: r.z.toFixed(2) },
        fit: this.fit,
        bodyLen: this.measureBodyLength(),
        turnRadius: (this.turnRadius || 0) / Math.max(0.2, this.tuning.turnScale),
        height: this.yMin().toFixed(2) + '~' + this.yMax().toFixed(2),
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
    adaptive: false,      // 自适应：整幅构图一定留在画面内（默认关，保持按卡宽的固定比例）
    hitBoxVisible: false, // 调试：把命中包围盒画出来
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
        if (moved > 20) {                  // 拖着画面/晃手机不算点击
          console.log('AOYU_TAP_SKIP 手指移动了', Math.round(moved), 'px');
          return;
        }
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
      if (!this.markerActive || this.fishHidden) {
        // 卡片刚好丢了的时候点屏幕是不会有反应的，记一笔省得下次又当成"点不中鱼"
        console.log('AOYU_TAP_SKIP markerActive=' + this.markerActive + ' fishHidden=' + this.fishHidden);
        return;
      }
      var fish = this.activeFish();
      if (!fish) return;
      if (this.hitFish(fish, x, y)) {
        this.playRandomNote();
        return;
      }
      // 点空白：拿点击落点当威胁点，让鱼朝反方向窜出去
      if (!CONFIG.startleEnabled) return;
      var local = cardPointFromScreen(x, y);
      var threat = local ? { x: local.x, z: local.z } : null;
      fish.startle(threat);
      console.log('AOYU_STARTLE', fish.data.key, threat ? threat.x.toFixed(2) + ',' + threat.z.toFixed(2) : 'no-point');
    },

    activeFish: function () {
      return instances[this.targetMode === 'koi' ? 'koi' : 'aoyu'] || null;
    },

    /**
     * 命中判定。两层，任意一层中就算点到了鱼：
     *   ① 模型网格射线：three 的 raycast 对 SkinnedMesh 会用 boneTransform 逐三角形算，
     *      所以它是跟着当前骨骼姿势的（但只有真正的三角形才算，鱼鳍这种薄片容易擦过去）
     *   ② **模型本地包围盒 + 25% 手指容差**（主力层）：射线转进模型坐标系里判，
     *      所以盒子跟着鱼的朝向走，不会因为旋转而虚胖
     *
     * 注意：这个盒子必须跟着骨骼动画重算。之前用的是 geometry.boundingBox（绑定姿势），
     * 鱼一摆尾/转向，实际身体就跑到盒子外面去了 —— 这就是"有时候点鱼没声音"的根源。
     */
    hitFish: function (fish, clientX, clientY) {
      var sceneEl = this.sceneEl;
      var canvas = sceneEl.renderer && sceneEl.renderer.domElement;
      var camera = sceneEl.camera;
      var meshEl = fish.data.anim;
      var mesh = meshEl && meshEl.getObject3D('mesh');
      if (!canvas || !camera || !mesh) return false;
      syncProjectionInverse(camera);
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
              -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);

      // ① 网格射线
      if (raycaster.intersectObject(mesh, true).length) {
        console.log('AOYU_HIT', fish.data.key, '网格');
        return true;
      }

      mesh.updateWorldMatrix(true, true);
      var box = this.fishLocalBox(mesh);
      if (box) {
        var inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        var localRay = raycaster.ray.clone().applyMatrix4(inverse);
        var size = box.getSize(new THREE.Vector3());
        if (localRay.intersectsBox(box)) {
          console.log('AOYU_HIT', fish.data.key, '包围盒',
            size.x.toFixed(2) + '×' + size.y.toFixed(2) + '×' + size.z.toFixed(2), '卡宽');
          return true;
        }
        console.log('AOYU_HIT', fish.data.key, '没点中',
          '本地射线 ' + localRay.origin.x.toFixed(2) + ',' + localRay.origin.y.toFixed(2) + ',' + localRay.origin.z.toFixed(2) +
          ' 方向 ' + localRay.direction.x.toFixed(3) + ',' + localRay.direction.y.toFixed(3) + ',' + localRay.direction.z.toFixed(3) +
          ' 盒尺寸 ' + size.x.toFixed(2) + '×' + size.y.toFixed(2) + '×' + size.z.toFixed(2) +
          ' 盒中心 ' + box.getCenter(new THREE.Vector3()).x.toFixed(2) + ',' +
          box.getCenter(new THREE.Vector3()).y.toFixed(2) + ',' + box.getCenter(new THREE.Vector3()).z.toFixed(2));
      }
      return false;
    },

    /**
     * 模型本地坐标系里的整体包围盒（跟着当前骨骼姿势），整体放大 25% 当手指容差。
     *
     * 这里是"点鱼没声音"的关键：geometry.boundingBox 是**绑定姿势**的盒子，
     * 鱼摆尾、转弯之后身体会跑到盒子外面，点上去就没反应。
     * 现在对 SkinnedMesh 按索引均匀抽 96 个顶点，用 boneTransform 算它们当前姿势的位置，
     * 再取包围盒——所以它会跟着鱼一起动。只在点击时和调试显示时算，不影响帧率。
     */
    fishLocalBox: function (mesh) {
      mesh.updateWorldMatrix(true, true);
      var inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      var tmp = new THREE.Matrix4();
      var v = new THREE.Vector3();
      var box = new THREE.Box3();
      var valid = false;
      mesh.traverse(function (node) {
        if (!node.isMesh || !node.geometry) return;
        if (isDebugHitBox(node)) return;
        var pos = node.geometry.attributes && node.geometry.attributes.position;
        if (!pos) return;
        tmp.copy(inverse).multiply(node.matrixWorld);      // 该网格本地 → 模型本地
        if (node.isSkinnedMesh && node.skeleton) {
          var step = Math.max(1, Math.floor(pos.count / 96));
          for (var i = 0; i < pos.count; i += step) {
            v.fromBufferAttribute(pos, i);                 // boneTransform 要求先放绑定姿势的位置
            node.boneTransform(i, v);
            box.expandByPoint(v.applyMatrix4(tmp));
          }
          valid = true;
        } else {
          if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
          if (!node.geometry.boundingBox) return;
          box.union(node.geometry.boundingBox.clone().applyMatrix4(tmp));
          valid = true;
        }
      });
      if (!valid || box.isEmpty()) return null;
      var size = box.getSize(new THREE.Vector3()).multiplyScalar(1.25);
      var center = box.getCenter(new THREE.Vector3());
      box.setFromCenterAndSize(center, size);
      return box;
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
        self.syncAnchorRing(fish);
        statusText.textContent = 'FPS ' + (self.fps || '--') +
          '（渲染×' + (self.pixelRatio ? self.pixelRatio.toFixed(2) : '--') + '）　' +
          '游动：有界漫游　半径 ' + status.radius.x + '×' + status.radius.z + ' 张卡宽' +
          '　高 ' + status.height + '　' + status.state + '　' +
          '速度×' + status.tuning.speedScale.toFixed(2) +
          ' 转向×' + status.tuning.turnScale.toFixed(2) +
          ' 范围×' + status.tuning.rangeScale.toFixed(2) +
          (fish.adaptive ? ' 自适×' + status.fit.toFixed(2) : '') +
          ' 摆尾×' + status.tuning.animSpeedMax.toFixed(2) +
          ' 大小×' + status.tuning.modelScale.toFixed(2) +
          ' 惊吓×' + status.tuning.startleSpeed.toFixed(1) +
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
        ['modelScale', -0.1, 'db-size-m'], ['modelScale', 0.1, 'db-size-p'],
        ['startleSpeed', -0.5, 'db-startle-m'], ['startleSpeed', 0.5, 'db-startle-p']];
      knobs.forEach(function (item) {
        document.getElementById(item[2]).addEventListener('click', function () { knob(item[0], item[1]); });
      });
      document.getElementById('db-material').addEventListener('click', function () { self.toggleLightweight(); });
      document.getElementById('db-adaptive').addEventListener('click', function () { self.toggleAdaptive(); });
      document.getElementById('db-hitbox').addEventListener('click', function () { self.toggleHitBox(); });
      document.getElementById('db-anchor').addEventListener('click', function () { self.toggleAnchorRing(); });
      document.getElementById('db-reset').addEventListener('click', function () {
        var fish = self.activeFish();
        if (fish) fish.tuning = { speedScale: 1, turnScale: 1, rangeScale: 5, animSpeedMax: 1, modelScale: 1, startleSpeed: 4 };
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
          lightweight: !!this.lightweight,
          adaptive: !!this.adaptive,
          hitBoxVisible: !!this.hitBoxVisible
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
      if (saved.adaptive) {
        this.toggleAdaptive();
      }
      if (saved.hitBoxVisible) {
        this.toggleHitBox();
      }
      if (saved.lightweight) {
        this.lightweight = true;
        var fish = this.activeFish();
        if (fish) fish.setLightweightMaterials(true);
        var btn = document.getElementById('db-material');
        if (btn) btn.textContent = '材质：轻量';
      }
      console.log('AOYU_TUNING_RESTORED', JSON.stringify(saved.tuning));
    },

    /**
     * 调试用锚点环：在卡片坐标系里画一个与活动椭圆等大的环，和鱼同高。
     * 用途：一眼看出"鱼的活动空间到底有没有锚在码上"——环应该稳稳套在码上，
     * 鱼一直在环内游；如果环本身就跑偏了，那是跟踪/标定的问题，不是鱼的逻辑。
     */
    /** 锚点环跟着当前范围（含自适应缩放）走，调试面板刷新时同步一次 */
    syncAnchorRing: function (fish) {
      var ring = document.getElementById('anchor-ring');
      if (!ring || !fish) return;
      var r = fish.radii();
      var y = (fish.yMin() + fish.yMax()) / 2;
      ring.setAttribute('scale', r.x + ' ' + r.z + ' 1');
      ring.setAttribute('position', '0 ' + y + ' 0');
    },

    toggleAnchorRing: function () {
      var existing = document.getElementById('anchor-ring');
      if (existing) {
        existing.parentNode.removeChild(existing);
        console.log('AOYU_ANCHOR_RING off');
        return;
      }
      var marker = document.getElementById('ar-marker');
      if (!marker) return;
      var fish = this.activeFish();
      var r = fish ? fish.radii() : { x: 3.5, z: 2.5 };
      var h = fish && fish.data.centerY != null ? fish.data.centerY : 0.5;
      var el = document.createElement('a-entity');
      el.id = 'anchor-ring';
      el.setAttribute('geometry', 'primitive: torus; radius: 1; radiusTubular: 0.012; segmentsTubular: 96; segmentsRadial: 4');
      el.setAttribute('rotation', '-90 0 0');
      el.setAttribute('material', 'color: #05f8ab; shader: flat; opacity: 0.8; transparent: true');
      el.setAttribute('scale', r.x + ' ' + r.z + ' 1');   // 圆环在实体局部 XY 平面，旋转后才落到卡面
      el.setAttribute('position', '0 ' + h + ' 0');
      marker.appendChild(el);
      console.log('AOYU_ANCHOR_RING on', r.x + '×' + r.z);
    },

    /** 调试：把命中判定用的包围盒画出来（和点击判定用的是同一个盒子） */
    toggleHitBox: function () {
      this.hitBoxVisible = !this.hitBoxVisible;
      var existing = document.getElementById('hit-box');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      if (this.hitBoxVisible) {
        var el = document.createElement('a-entity');
        el.id = 'hit-box';
        el.setAttribute('hitbox-debug', '');
        var fish = this.activeFish();
        var animEl = fish && fish.data.anim;
        if (animEl) animEl.appendChild(el);
        else this.sceneEl.appendChild(el);
      }
      var btn = document.getElementById('db-hitbox');
      if (btn) {
        btn.classList.toggle('on', this.hitBoxVisible);
        btn.textContent = this.hitBoxVisible ? '碰撞盒：开' : '碰撞盒：关';
      }
      this.saveTuning();
      console.log('AOYU_HITBOX_DEBUG', this.hitBoxVisible ? 'on' : 'off');
    },

    /**
     * 自适应开关：打开后，卡片在画面里占得太满时，鱼的大小／活动范围／悬浮高度
     * 一起等比缩小，保证整幅构图留在画面内；卡片在画面里本来就不大时倍率是 1，
     * 和自己调好的参数完全一样。关掉就是纯粹按卡宽算（默认）。
     */
    toggleAdaptive: function () {
      this.adaptive = !this.adaptive;
      Object.keys(instances).forEach(function (key) {
        if (instances[key]) instances[key].adaptive = this.adaptive;
      }, this);
      var btn = document.getElementById('db-adaptive');
      if (btn) {
        btn.classList.toggle('on', this.adaptive);
        btn.textContent = this.adaptive ? '自适应：开' : '自适应：关';
      }
      this.saveTuning();
      this.refreshDebug();
      console.log('AOYU_ADAPTIVE', this.adaptive ? 'on' : 'off');
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
