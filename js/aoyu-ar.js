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

  /**
   * 调试入口（右下角「调试」按钮 + 面板）默认隐藏，只有这两种情况才显示：
   *   1) 链接带调试参数，例如 https://…/aoyuar/?debug=1
   *   2) 页面自己声明 window.AOYU_DEBUG = true（tools/ 下的调试页用这个）
   * ?debug=0 / false / off 视为关闭。
   */
  function debugUiRequested() {
    if (window.AOYU_DEBUG === true) return true;
    // 本地版（127.0.0.1 / localhost / file://）默认带调试入口：
    // 演出前要在桌面上调鱼的大小，不用再手动加 ?debug=1
    var host = window.location.hostname;
    if (window.location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' ||
        host === '::1' || host === '[::1]') return true;
    var m = /(?:^|[?&])debug(?:=([^&]*))?(?:&|$)/.exec(window.location.search);
    if (!m) return false;
    var v = (m[1] || '1').toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  }

  if (debugUiRequested()) {
    var markDebugUi = function () {
      if (document.body) document.body.classList.add('aoyu-debug');
      console.log('AOYU_DEBUG_UI on（本地版默认开 / 链接带了调试参数）');
    };
    if (document.body) markDebugUi();
    else document.addEventListener('DOMContentLoaded', markDebugUi);
  }

  // 贴到活动边界时允许的最小转身角速度（弧度/秒）：0.85 半径开始生效，1.0 时全额。
  // 不加这条会出大问题：转弯半径跟速度挂钩，鱼贴边时速度已经很低，
  // 角速度也跟着很低，结果被硬约束按在边界上慢慢蹭好几秒（实测）。
  var EDGE_TURN_RATE = 5.0;

  // 屏幕空间手指容差（像素）：葫芦丝那个项目用的是 34px，鱼身子细，取 26px
  var HIT_PADDING_PX = 26;
  // 算轮廓/包围盒时每个网格抽多少个顶点
  var HIT_SAMPLES = 96;

  // 自适应缩放允许游动范围碰到画面的这个边界（0.8 = 四周各留 10% 余量），以及最小倍率
  var SCREEN_FIT_LIMIT = 0.8;
  var SCREEN_FIT_MIN = 0.1;
  // 屏幕填充：范围按"占屏幕多大"来定。这里是最外圈的 NDC 边界（0.92 ≈ 四周各留 4%）
  var SCREEN_FILL_MAX_X = 0.92;
  var SCREEN_FILL_MAX_Y = 0.88;
  var SCREEN_FILL_SAMPLES = 24;
  // 卡片在画面里至少要有这么多 NDC（≈ 屏幕短的 2%）才认这次位姿：
  // 斜看/离得远时卡片投影像素极少，按"铺满屏幕"外推出来的范围会大到离谱（实测 1000+ 卡宽），
  // 鱼会拿到一个屏幕外的目标一路飞出去。低于这个值就不更新范围，沿用上一次的好值。
  var MIN_NDC_PER_CARD = 0.02;
  // 两条鱼"不许交叉叠在一起"的间距：中心距离 ≥ PAIR_GAP_K × 平均身长。
  // 1.0 正好是两个"包围圆"相切（每条鱼的包围圆半径 = 身长的一半），留 15% 余量。
  var PAIR_GAP_K = 1.15;
  // 两条鱼最多各自占到长半轴的 80%（于是间距上限 = 1.6 × 长半轴）
  var PAIR_ROOM_K = 0.8;

  // 鱼大小的默认基准（面板「鱼大一点/小一点」的起点，三条鱼共用同一套 modelScale）
  var DEFAULT_MODEL_SCALE = 2.0;
  // 鳌鱼在共用大小的基础上再加这么多（用户要求"鳌鱼缩放再 +1"）
  var AOYU_SCALE_BONUS = 1.0;
  // 活动范围：5 ≈ 铺满屏幕 85%，6 起就到 100%（0.92/0.88 安全边距）封顶（7 和 6 视觉上一样）
  var DEFAULT_RANGE_SCALE = 7.0;

  // 调试面板旋钮的"无上限"哨兵值：只用来挡住 NaN/Infinity，实用上等于没有上限
  var UNLOCKED_MAX = 999;

  var CONFIG = {
    switchHour: 20,            // 切换时刻：20:30 之后显示鳌鱼，之前显示锦鲤
    switchMinute: 30,          // 分钟也要能配，所以不直接用 getHours() 比较（见 isAoyuTime）
    // 每个模式下"在场"的鱼：锦鲤模式两条（互相规避），鳌鱼模式一条
    modeFish: { koi: ['koi', 'koi2'], aoyu: ['aoyu'] },
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
    // 受惊"窜出去"的那一下：瞬间给到 burst 倍（相对持续冲刺速度），
    // 然后在 startleBurstMs 内按曲线落回持续冲刺速度——开头极快、后面保持快游。
    startleBurstMul: 2.0,
    startleBurstMs: 180,
    // 调试面板各旋钮的量程 [下限, 上限]。上限一律解锁到 UNLOCKED_MAX：
    // 之前每项都有上限（速度 4、转向 1.7、范围 8、摆尾 2.5、大小 2.0…），
    // 现场想再大一点就顶死了。下限仍然保留 —— 0 或负数会让速度/缩放变成 NaN 或反向，
    // 那不是"调大"，是坏掉。
    tuningLimits: {
      speedScale: [0.5, UNLOCKED_MAX],
      turnScale: [0.5, UNLOCKED_MAX],
      rangeScale: [0.5, UNLOCKED_MAX],   // 活动范围：5 ≈ 铺满屏幕 85%，再往上也只是贴到安全边距（屏幕封顶）
      animSpeedMax: [0.5, UNLOCKED_MAX], // 摆尾倍率（游动时它就是骨骼动画的速度倍率）
      startleSpeed: [1.5, UNLOCKED_MAX], // 惊吓冲刺速度倍率（相对巡航速度）
      modelScale: [0.05, UNLOCKED_MAX],  // 鱼的大小（默认基准已是 6 倍，所以下限放到 0.05 方便往回收）
      pcModelScale: [0.05, UNLOCKED_MAX] // PC 模式专用大小：桌面端/OBS 用它，和现场那套互不影响
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

  /** 2D 凸包（Andrew monotone chain），输入/输出都是 [[x,y], ...] */
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    var cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /** 点在凸包内，或者离轮廓不超过 pad 像素（手指容差） */
  function hullHit(hull, px, py, pad) {
    if (!hull || hull.length < 3) return false;
    var inside = false, near = false;
    for (var i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      var xi = hull[i][0], yi = hull[i][1];
      var xj = hull[j][0], yj = hull[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
      var dx = xj - xi, dy = yj - yi;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2)) : 0;
      var cx = xi + t * dx - px, cy = yi + t * dy - py;
      if (cx * cx + cy * cy <= pad * pad) near = true;
    }
    return inside || near;
  }

  /** 调试用的碰撞盒挂在模型下面，包围盒测量必须跳过它自己，否则会越算越大 */
  function isDebugHitBox(node) {
    if (node.userData && node.userData.aoyuDebug) return true;
    var el = node.el;
    return !!(el && el.closest && el.closest('#hit-box'));
  }

  var _skinBase = new THREE.Vector3();
  var _skinSum = new THREE.Vector3();
  var _skinMat = new THREE.Matrix4();
  var _skinIdx = [0, 0, 0, 0];
  var _skinW = [0, 0, 0, 0];

  /**
   * 算一个顶点的蒙皮位置（结果在网格本地坐标系），等价于渲染管线做的事。
   *
   * 为什么不用 SkinnedMesh.boneTransform()：A-Frame 1.3 里带的 three r137，
   * BufferAttribute.getX() 不处理 normalized —— 权重在 GPU 上会被归一化（所以渲染正常），
   * JS 侧却拿到 65535 这种原始整数。双鱼.glb 的 WEIGHTS_0 正是 normalized 的 ushort，
   * 用它算出来的位置被放大几万倍（盒子 7 万卡宽、体长量成 1 万），
   * 点击判定和"鱼大小自适应"全跟着错。这里按权重和归一化，两种格式都算得对。
   */
  function skinnedVertex(node, index, target) {
    var geo = node.geometry;
    var wi = geo.attributes.skinIndex;
    var ww = geo.attributes.skinWeight;
    var w0 = ww.getX(index), w1 = ww.getY(index), w2 = ww.getZ(index), w3 = ww.getW(index);
    var sum = w0 + w1 + w2 + w3;
    if (!(sum > 0) || !isFinite(sum)) return null;
    _skinIdx[0] = wi.getX(index); _skinIdx[1] = wi.getY(index);
    _skinIdx[2] = wi.getZ(index); _skinIdx[3] = wi.getW(index);
    _skinW[0] = w0 / sum; _skinW[1] = w1 / sum; _skinW[2] = w2 / sum; _skinW[3] = w3 / sum;
    var sk = node.skeleton;
    _skinBase.copy(target).applyMatrix4(node.bindMatrix);
    _skinSum.set(0, 0, 0);
    for (var i = 0; i < 4; i++) {
      var w = _skinW[i];
      if (!w) continue;
      var bone = sk.bones[_skinIdx[i]];
      if (!bone) continue;
      _skinMat.multiplyMatrices(bone.matrixWorld, sk.boneInverses[_skinIdx[i]]);
      target.copy(_skinBase).applyMatrix4(_skinMat);
      _skinSum.addScaledVector(target, w);
    }
    return target.copy(_skinSum).applyMatrix4(node.bindMatrixInverse);
  }

  var _pointMat = new THREE.Matrix4();

  /**
   * 采样蒙皮后的顶点，得到模型在 toLocal 坐标系里的包围盒。
   *
   * 关键点：每个点都是"先按骨骼算位置，再乘 matrixWorld 变到世界，最后乘 toLocal 变到目标系"，
   * 绝不能先算世界轴对齐盒再变换（那会因为鱼heading旋转而把盒子撑大，实测宽高能多出 60%）。
   */
  function skinnedPointBox(root, samples, toLocal) {
    var box = new THREE.Box3();
    var v = new THREE.Vector3();
    var valid = false;
    root.updateWorldMatrix(true, true);
    root.traverse(function (node) {
      if (!node.isMesh || !node.geometry) return;
      if (isDebugHitBox(node)) return;
      var pos = node.geometry.attributes && node.geometry.attributes.position;
      if (!pos) return;
      _pointMat.copy(toLocal).multiply(node.matrixWorld);      // 该网格本地 → 目标坐标系
      if (node.isSkinnedMesh && node.skeleton) {
        var step = Math.max(1, Math.floor(pos.count / samples));
        for (var i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i);                       // 先放绑定姿势的位置
          if (!skinnedVertex(node, i, v)) continue;            // 按骨骼姿势算位置
          box.expandByPoint(v.applyMatrix4(_pointMat));
        }
        valid = true;
      } else {
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        if (!node.geometry.boundingBox) return;
        box.union(node.geometry.boundingBox.clone().applyMatrix4(_pointMat));
        valid = true;
      }
    });
    return valid && !box.isEmpty() ? box : null;
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
      // 每条鱼摆尾相位随机：两条锦鲤不会像复制粘贴一样同步摆尾
      this.action.time = Math.random() * clip.duration;
      this.mixer.update(0);
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
   * 目标：像鱼，但**永远不越界**。不照搬小程序那套状态机，也不用固定轨道。
   *
   *   1) 活动范围 = 卡片平面内的一个圆 + 高度区间，两个都是硬约束
   *      （原来是 0.70×0.50 的椭圆，宽了以后横向容易顶出画面，所以改成圆）
   *   2) 目标点只在圆内部 0.72 半径内随机取（留出余量，不贴边）
   *   3) 朝目标游 + 限速转向（鱼不会原地拐弯），转弯时轻微侧倾
   *   4) 越靠近边界，"向内"的修正越强（软约束，避免贴着边撞）
   *   5) 速度有快有慢（滑行/巡游/冲刺随机切换），摆尾速度跟游速联动
   *   6) 每帧积分之后再做一次硬投影：出圈就按比例拉回、高度夹到区间内
   *      —— 所以无论受惊冲刺、掉帧、改范围、改大小，都不可能游出范围
   */
  AFRAME.registerComponent('fish-swim', {
    schema: {
      key: { type: 'string' },
      anim: { type: 'selector' },
      radius: { type: 'number', default: 0.50 },    // 游动范围半径（卡片 = 1 单位；圆形）
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
      // 随机初始落点：同场两条鱼不会从圆心同一点冒出来
      var startR = this.radii();
      var startA = this.rng() * Math.PI * 2;
      var startK = 0.3 + this.rng() * 0.4;
      this.pos = {
        x: Math.cos(startA) * startR.x * startK,
        y: (this.data.yMin + this.data.yMax) / 2,
        z: Math.sin(startA) * startR.z * startK
      };
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
      this.startleBurstUntil = 0;
      this.edgeTime = 0;        // 贴在边界上多久了（超过阈值就掉头，不让它一直磨边）
      this.edgeHit = false;     // 上一帧是不是被硬约束按回边界了（= 这一帧刚到边）
      this.screenR = null;      // 屏幕适配出来的椭圆半径（卡宽），每 100ms 更新一次
      this.tuning = { speedScale: 1, turnScale: 1, rangeScale: DEFAULT_RANGE_SCALE, animSpeedMax: 1, modelScale: DEFAULT_MODEL_SCALE, pcModelScale: DEFAULT_MODEL_SCALE, startleSpeed: 4 };
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
      var el = this.data.anim;
      var root = el && el.getObject3D('mesh');
      // 模型还没加载完时不要缓存兜底值，否则会永久停在 1.00
      if (!root) return 1;
      // 每帧要问好几次（规避、间距、转弯半径、自适应），采样一次算好缓存 0.25 秒。
      // 不能长缓存：模型加载完、换模型、改缩放都会变。
      var now = performance.now();
      if (this.bodyLenAt && this.bodyLenValue && now - this.bodyLenAt < 250) return this.bodyLenValue;
      // 量在"鱼的本地坐标系"里（= swim 节点坐标系，鱼头永远朝本地 +Z）：
      // 用世界轴对齐盒量，鱼横着游时长度会缩水一半，间距和转弯半径全跟着乱。
      var swim = this.el.object3D;
      swim.updateWorldMatrix(true, true);
      var toSwim = new THREE.Matrix4().copy(swim.matrixWorld).invert();
      var box = skinnedPointBox(root, HIT_SAMPLES, toSwim);
      var len = 1;
      if (box) {
        var size = box.getSize(new THREE.Vector3());
        var worldScale = swim.getWorldScale(new THREE.Vector3()).x;
        len = Math.max(size.x, size.z) * (isFinite(worldScale) && worldScale > 0 ? worldScale : 1);
      }
      if (!(len > 0.05) || !isFinite(len)) len = 1;
      this.bodyLenAt = now;
      this.bodyLenValue = len;
      return len;
    },

    /**
     * 持续冲刺速度（卡宽/秒）：受惊后保持的那段快速游动。
     * 按活动范围封顶（至少 0.25 秒才穿过整个范围）——不封顶的话，
     * 惊吓倍率/范围调到很大时鱼会一直在边界上弹，看起来惊吓停不下来。
     */
    dashSpeed: function () {
      var r = this.radii();
      // 速度按"实际能游的范围"放大：范围是屏幕适配出来的，卡片小的时候范围会变大，
      // 速度不跟着放大就会显得鱼在原地磨。基准＝0.5 卡宽（= 旋钮 5 时的老范围）。
      var rangeBoost = Math.max(0.25, r.x / Math.max(0.05, this.baseRadius()));
      var v = this.data.speed * this.tuning.startleSpeed * this.tuning.speedScale * rangeBoost;
      return Math.min(v, Math.min(r.x, r.z) * 4);
    },

    /** 爆冲速度：受惊那一瞬间的瞬时速度（比持续冲刺快一截，然后很快落回来） */
    burstSpeed: function () {
      var r = this.radii();
      return Math.min(this.dashSpeed() * CONFIG.startleBurstMul, Math.min(r.x, r.z) * 6);
    },

    /** 卡片坐标系（AR.js 的 marker）：活动范围是绕卡片中心算的 */
    markerSpace: function () {
      if (this._markerSpace && this._markerSpace.parent) return this._markerSpace;
      var marker = document.getElementById('ar-marker');
      this._markerSpace = (marker && marker.object3D) || null;
      return this._markerSpace;
    },

    /** 基准半径（卡片单位）：屏幕适配算出来的倍率都乘在它上面 */
    baseRadius: function () { return this.data.radius; },

    /**
     * 这一帧真正用的活动范围（卡片平面内的椭圆，单位＝卡宽）。
     * 由 screenK 决定：screenK 是"按当前画面算出、尽量铺满屏幕又不越界"的倍率，
     * 所以卡片在画面里小的时候范围会自动变大、凑近到占满画面时又会自动收回来——
     * 永远是"宽一点但不超出屏幕"。范围旋钮改的是目标占屏比例。
     */
    radii: function () {
      var r = this.screenR;
      if (r && isFinite(r.x) && isFinite(r.z) && r.x > 0.05 && r.z > 0.05) {
        return { x: r.x, z: r.z };
      }
      var b = this.baseRadius() * 5;               // 还没算出来时的兜底（≈ 老范围）
      return { x: b, z: b * 0.86 };
    },

    /** 悬浮高度区间 × 自适应缩放（构图整体等比缩放，比例不变） */
    yMin: function () { return this.data.yMin * this.fit; },
    yMax: function () { return this.data.yMax * this.fit; },

    /** 模型最终缩放 = HTML 基准 × 手调大小 × 自适应缩放 */
    applyModelScale: function () {
      // PC 模式：桌面端（OBS 抓窗口那种）用 pcModelScale，现场用 modelScale，两边互不影响
      var scale = (app && app.pcMode) ? this.tuning.pcModelScale : this.tuning.modelScale;
      if (this.data.key === 'aoyu') scale += AOYU_SCALE_BONUS;   // 鳌鱼始终比锦鲤大一档
      var want = this.baseScale * scale * this.fit;
      if (Math.abs(want - this.appliedScale) > 1e-4) {
        this.appliedScale = want;
        this.el.object3D.scale.setScalar(want);
      }
    },

    /**
     * 以 k 倍画游动范围（连同悬浮高度），检查整圈是不是都在镜头前方并且留在画面内。
     * 采样 24 个点：任何一点跑到镜头后面或者出画面都算装不下。
     */
    /** 采样校验：给定椭圆半径（卡宽）是否整圈都在画面内（相机前方 + NDC 不超上限） */
    fitsRadii: function (rx, rz, camera, limitX, limitY) {
      var y = (this.yMin() + this.yMax()) / 2;      // 用鱼实际的悬浮高度（含自适应缩放）
      var space = this.markerSpace();
      if (!space) return false;
      for (var i = 0; i < SCREEN_FILL_SAMPLES; i++) {
        var a = (i / SCREEN_FILL_SAMPLES) * Math.PI * 2;
        tmpVec.set(Math.cos(a) * rx, y, Math.sin(a) * rz);
        space.localToWorld(tmpVec);
        // 镜头后面（相机空间 z >= 0）的点投影会翻号，不能拿来算
        if (tmpVec2.copy(tmpVec).applyMatrix4(camera.matrixWorldInverse).z > -0.01) return false;
        tmpVec.project(camera);
        if (Math.abs(tmpVec.x) > limitX || Math.abs(tmpVec.y) > limitY) return false;
      }
      return true;
    },

    /** 范围被判定不可信时的日志：同一原因 2 秒内只打一条，方便真机上抓现场 */
    warnField: function (why, dxPerUnit, dyPerUnit) {
      var now = performance.now();
      if (this._fieldWarnAt && now - this._fieldWarnAt < 2000 && this._fieldWarnWhy === why) return;
      this._fieldWarnAt = now;
      this._fieldWarnWhy = why;
      console.warn('AOYU_FIELD_SKIP ' + why +
        ' 每卡宽NDC=' + dxPerUnit.toFixed(4) + '/' + dyPerUnit.toFixed(4) +
        ' 当前范围=' + (this.screenR ? this.screenR.x.toFixed(2) + '×' + this.screenR.z.toFixed(2) : '无'));
    },

    /**
     * 「两条鱼要放得下」的缩放上限（≤1；只有一条鱼时是 1）。
     *
     * 卡片占满画面时，按屏幕反推出来的活动范围可能只有 0.4 卡宽，而鱼有 1.45 卡宽长：
     * 这种场地里两条鱼无论怎么游都会交叉叠在一起（物理上塞不下），只能把鱼按比例缩小到
     * "两条鱼 + 一条间距"能塞进长轴。这条不受「自适应」开关影响 —— 它管的是会不会叠在一起。
     */
    pairFit: function () {
      if (!this.neighbors().length) return 1;
      var fit = (this.fit > 0.05 && isFinite(this.fit)) ? this.fit : 1;
      var lenBase = Math.max(0.1, this.measureBodyLength() / fit);   // 折算回 fit=1 时的身长
      var r = this.radii();
      var room = Math.max(r.x, r.z) * PAIR_ROOM_K * 2;
      var want = room / (lenBase * PAIR_GAP_K);
      if (!isFinite(want) || !(want > 0.12)) want = 0.12;
      return want < 1 ? want : 1;
    },

    /**
     * 自适应缩放（调试面板的「自适应」开关）：把"活动范围 + 鱼身"整幅构图缩到画面内。
     * 只影响鱼的大小和悬浮高度 —— 活动范围本身已经按屏幕算好了（screenRadii），
     * 这个开关是给"卡片在画面里占得太满"那种情况兜底的。
     */
    screenFit: function () {
      var sceneEl = document.querySelector('a-scene');
      var camera = sceneEl && sceneEl.camera;
      if (!camera) return 1;
      var r = this.radii();
      var half = Math.max(0.1, this.measureBodyLength()) * 0.5;
      var needX = r.x + half, needZ = r.z + half;
      if (this.fitsRadii(needX, needZ, camera, SCREEN_FIT_LIMIT, SCREEN_FIT_LIMIT)) return 1;
      var k = 1;
      for (var i = 0; i < 12; i++) {
        k *= 0.85;
        if (this.fitsRadii(needX * k, needZ * k, camera, SCREEN_FIT_LIMIT, SCREEN_FIT_LIMIT)) return k;
      }
      return k;
    },

    /**
     * 按当前相机位姿算"刚好铺到指定屏幕比例"的椭圆半径（单位＝卡宽）。
     *
     * 做法：量出"卡片中心 + 沿卡面 x / z 各一个基准半径"这三个点投影到屏幕后的跨度，
     * 得到"每卡宽对应多少 NDC"，再反推横、纵各自能铺多宽 —— 所以椭圆会自己长成屏幕的形状
     * （竖屏就是竖向长、横向短），并且永远贴着屏幕的边而不越界。
     * 透视下线性外推会略偏大，所以留 10% 余量，再用采样校验兜一次。
     */
    screenRadii: function (limitX, limitY) {
      var sceneEl = document.querySelector('a-scene');
      var camera = sceneEl && sceneEl.camera;
      var space = this.markerSpace();
      if (!camera || !space) return null;
      var unit = this.baseRadius();
      var y = (this.yMin() + this.yMax()) / 2;
      var o = new THREE.Vector3(0, y, 0);
      var px = new THREE.Vector3(unit, y, 0);
      var pz = new THREE.Vector3(0, y, unit);
      space.localToWorld(o); space.localToWorld(px); space.localToWorld(pz);
      if (tmpVec2.copy(o).applyMatrix4(camera.matrixWorldInverse).z > -0.01) return null;
      o.project(camera); px.project(camera); pz.project(camera);
      if (!isFinite(o.x) || !isFinite(px.x) || !isFinite(pz.y)) return null;
      var dxPerUnit = Math.abs(px.x - o.x) / unit;      // 每卡宽 -> NDC x
      var dyPerUnit = Math.abs(pz.y - o.y) / unit;      // 每卡宽 -> NDC y
      if (dxPerUnit < MIN_NDC_PER_CARD || dyPerUnit < MIN_NDC_PER_CARD) {
        this.warnField('卡片太小/位姿不可信', dxPerUnit, dyPerUnit);
        return null;                                     // 不更新，沿用上一次的好值
      }
      var rx = dxPerUnit > 1e-6 ? limitX / dxPerUnit : unit;
      var rz = dyPerUnit > 1e-6 ? limitY / dyPerUnit : unit;
      // 透视外推偏大 + 手指/画面安全边距
      rx *= 0.9; rz *= 0.9;
      // 采样校验：整圈必须真的在画面里。以前只缩三次就收工，斜看时能返回 1000+ 卡宽的范围
      // （鱼随后就顺着目标飞出去了），所以这里一直缩到装得下为止。
      for (var i = 0; i < 40 && !this.fitsRadii(rx, rz, camera, limitX, limitY); i++) {
        rx *= 0.85; rz *= 0.85;
      }
      if (!this.fitsRadii(rx, rz, camera, limitX, limitY)) {
        this.warnField('怎么缩都装不下', dxPerUnit, dyPerUnit);
        return null;
      }
      if (!(rx > 0.05) || !isFinite(rx)) rx = unit;
      if (!(rz > 0.05) || !isFinite(rz)) rz = unit;
      return { x: rx, z: rz };
    },

    /**
     * 同场其他鱼的位置（只算当前模式下"在场"的那几条）。
     * app.activeKeys 由主控按模式维护：锦鲤模式 = ['koi','koi2']，鳌鱼模式 = ['aoyu']。
     */
    neighbors: function () {
      var out = [];
      var keys = (app && app.activeKeys) || [];
      for (var i = 0; i < keys.length; i++) {
        var other = instances[keys[i]];
        // other.pos 还没建出来说明那条鱼还在 init 里（组件按 DOM 顺序初始化）：
        // 这时候算它不是"邻居"，不然 init 里挑目标点会读到 undefined
        if (other && other !== this && other.pos && !other.hidden) out.push(other);
      }
      return out;
    },

    /**
     * 方向避让：靠近别的鱼时给出"远离它"的单位方向与权重（越近越强）。
     * 权重>0 时会在转向方向里叠加这个分量，让两条鱼自己绕开，而不是硬顶。
     */
    separation: function (r) {
      var out = { x: 0, z: 0, w: 0 };
      var others = this.neighbors();
      if (!others.length) return out;
      var bodyLen = this.measureBodyLength();
      // 避让半径：约 2.2 个身长；场地小的时候按场地收一下，免得全场都在互相躲
      var avoid = Math.max(0.6, Math.min(bodyLen * 2.2, Math.min(r.x, r.z) * 1.5));
      for (var i = 0; i < others.length; i++) {
        var dx = this.pos.x - others[i].pos.x;
        var dz = this.pos.z - others[i].pos.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d > avoid) continue;
        if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }      // 完全重合时给一个确定方向
        var w = 1 - d / avoid;                            // 0（刚好在边界）→ 1（贴在一起）
        out.x += (dx / d) * w;
        out.z += (dz / d) * w;
        out.w += w;
      }
      return out;
    },

    /**
     * 硬约束（保底）：两条鱼中心的距离不得小于 minGap，否则直接把本鱼往外推。
     * 方向避让正常工作时基本用不到，但受惊冲刺、贴边等极端情况下能兜住"不许撞一起"。
     */
    enforceGap: function (r) {
      var others = this.neighbors();
      if (!others.length) return;
      var bodyLen = this.measureBodyLength();
      // 场地允许的最大间距：两条鱼各自贴到长轴的 80% 处
      var cap = Math.max(r.x, r.z) * PAIR_ROOM_K * 2;
      for (var i = 0; i < others.length; i++) {
        // 不许交叉叠在一起：中心距离 ≥ 1.05 × 两条鱼的平均身长。
        // 以前是"身长×1.25 再被长半轴 0.85 封顶"，卡片离得近时封顶后只有 0.7 个身长，
        // 两条 1.45 卡宽长的鱼照样能交叉叠在一起（用户截图里那样）。
        var minGap = Math.max(0.45,
          Math.min(PAIR_GAP_K * (bodyLen + others[i].measureBodyLength()) * 0.5, cap));
        var dx = this.pos.x - others[i].pos.x;
        var dz = this.pos.z - others[i].pos.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d >= minGap) continue;
        if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }
        var push = (minGap - d) * 0.7;                    // 两边各自往外推；这里已经是常态约束，推太狠会抖
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    },

    /**
     * 在椭圆内取一个目标点（默认 0.72 半径内）；maxK 给"已经贴边了，往中间瞄"用。
     *
     * 同场有别的鱼时瞄"它对面那一侧"：以圆心为参照，挑跟邻居正好相反的方向，
     * 所以两条鱼会各自守着一头，而不是都在中间绕来绕去（中间绕着绕着就贴一起了）。
     * 邻居正好在圆心附近时方向没意义，这时退回随机方向。
     */
    pickTarget: function (maxK) {
      var r = this.radii();
      var kMax = maxK || 0.72;
      var others = this.neighbors();
      var ang = this.rng() * Math.PI * 2;
      var k = Math.sqrt(this.rng()) * kMax;
      if (others.length) {
        var nx = 0, nz = 0;
        for (var j = 0; j < others.length; j++) { nx += others[j].pos.x; nz += others[j].pos.z; }
        nx /= others.length; nz /= others.length;
        var un = nx / r.x, vn = nz / r.z;            // 邻居在椭圆归一化坐标里的位置
        var ul = Math.sqrt(un * un + vn * vn);
        // 目标点往外拉（别再往中间凑），方向按 maxK 等比缩放，贴边改瞄中间时依然有效
        k = kMax * (0.72 + this.rng() * 0.28);
        if (ul > 0.25) ang = Math.atan2(-vn, -un) + (this.rng() - 0.5) * 0.8;
      }
      this.target.x = Math.cos(ang) * r.x * k;
      this.target.z = Math.sin(ang) * r.z * k;
      this.targetRn = k;                 // 目标点相对半径的位置（0=圆心 1=边界）
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

      // 装不下就较快地收（约 0.3 秒），装得下就慢慢放回去——放太快会看到范围忽大忽小。
      // 「两条鱼放得下」这条永远生效，「自适应」开关只管屏幕构图那一条。
      var fitWant = this.adaptive ? Math.min(this.screenFit(), this.pairFit()) : this.pairFit();
      if (Math.abs(fitWant - this.fit) > 0.004) {
        this.fit += (fitWant - this.fit) * Math.min(1, d * (fitWant < this.fit ? 6 : 1));
        if (!(this.fit > 0.05) || !isFinite(this.fit)) this.fit = fitWant;
      } else if (this.fit !== fitWant) {
        this.fit = fitWant;
      }

      // 活动范围按屏幕来：每 100ms 重算一次"铺满屏幕又不越界"的倍率（平滑跟随，避免抖）
      this.screenTimer = (this.screenTimer || 0) + d;
      if (this.screenTimer >= 0.1) {
        this.screenTimer = 0;
        // 旋钮含义：5（默认）≈ 铺到屏幕的 85%，8 ≈ 贴着安全边距的最大范围（0.92 / 0.88）
        var fill = Math.max(0.15, Math.min(1, this.tuning.rangeScale / 5.9));
        var want = this.screenRadii(SCREEN_FILL_MAX_X * fill, SCREEN_FILL_MAX_Y * fill);
        if (want) {
          if (!this.screenR) {
            this.screenR = { x: want.x, z: want.z };
          } else {
            var k = Math.min(1, d * 6);          // 平滑跟随，避免镜头一动范围就跳
            this.screenR.x += (want.x - this.screenR.x) * k;
            this.screenR.z += (want.z - this.screenR.z) * k;
          }
        }
      }

      var r = this.radii();
      // 目标点必须落在当前活动范围内。活动范围是每 100ms 跟着镜头重算的，
      // 范围一缩小，之前挑的目标点就会跑到椭圆外面：鱼会一直顶着边界磨，
      // 两条鱼还特别容易一起被挤到同一条边上（看着就是"黏在一起"）。
      var tn = Math.sqrt((this.target.x / r.x) * (this.target.x / r.x) +
                         (this.target.z / r.z) * (this.target.z / r.z));
      if (tn > 0.85) {
        var tk = 0.85 / tn;
        this.target.x *= tk;
        this.target.z *= tk;
        this.targetRn *= tk;
      }
      // 注意：这里统一用 performance.now()，不要用 tick 的 time——
      // 两者时间原点在某些 WebView 里不一致，混用会把 1.1 秒的惊吓拖成十几秒。
      var nowMs = performance.now();
      var boosting = nowMs < this.startleUntil;
      if (this.boosting && !boosting) {
        console.log('AOYU_STARTLE_END 实际持续=' +
          Math.round(nowMs - (this.startleStartedAt || nowMs)) + 'ms 弹跳=' + (this.startleBounces || 0));
      }
      var rn = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                         (this.pos.z / r.z) * (this.pos.z / r.z));   // 0=中心 1=边界
      if (rn > 0.97) this.edgeTime += d; else this.edgeTime = 0;
      // 上一帧被硬约束按回边界 = 真的撞到范围边了（比只看 rn 更准，尤其是自适应在缩放时）
      var hitEdge = this.edgeHit || rn > 0.95;
      this.edgeHit = false;
      var snapTurn = false;      // true = 这一帧原地掉头（不走"转弯半径"限制）
      var dx = this.target.x - this.pos.x;
      var dz = this.target.z - this.pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      this.targetTime += d;
      var dirX, dirZ;
      if (boosting && this.startleDir) {
        // 冲刺：不追目标点，朝逃跑方向直着窜；窜到活动边界的 95% 就收
        dirX = this.startleDir.x;
        dirZ = this.startleDir.z;
        // 受惊期间撞到边界：**马上**原地掉头，换一个朝内的随机方向接着窜。
        // 不再等爆冲结束——之前要等 180ms 才掉头，看着就是贴着边磨一小会儿。
        // 加一个"当前方向朝外"的判断：掉头之后方向已经朝内，就不会在边上反复翻。
        var outNX = this.pos.x / (r.x * r.x), outNZ = this.pos.z / (r.z * r.z);
        if (hitEdge && (this.startleDir.x * outNX + this.startleDir.z * outNZ) > 0) {
          var bounce = this.bounceDirection();
          this.startleDir = { x: bounce.x, z: bounce.z };
          dirX = bounce.x;
          dirZ = bounce.z;
          snapTurn = true;
          this.edgeTime = 0;
          this.startleBurstUntil = nowMs + 120;   // 掉头后再给一小下爆冲，像弹开一样
          this.startleBounces = (this.startleBounces || 0) + 1;
          console.log('AOYU_BOUNCE 受惊撞边界掉头');
        }
      } else {
        // 正常巡游：朝目标 + 越靠边越强的向内修正
        if (dist < 0.12 || this.targetTime > this.targetDuration) {
          this.pickTarget();
        } else if (rn > 0.9 && this.targetRn > 0.6) {
          // 已经贴在边上了，而目标点也偏外——直接改瞄中心附近，别在边上游来游去
          this.pickTarget(0.45);
        }
        dirX = dist > 1e-4 ? dx / dist : this.head.x;
        dirZ = dist > 1e-4 ? dz / dist : this.head.z;
        if (rn > 0.75) {
          var back = Math.min(1, (rn - 0.75) / 0.25) * 2.0;
          var len = Math.sqrt(this.pos.x * this.pos.x + this.pos.z * this.pos.z) || 1;
          dirX -= (this.pos.x / len) * back;
          dirZ -= (this.pos.z / len) * back;
        }
        if (this.edgeTime > 0.35) {
          // 贴边磨了 0.35 秒还出不来：直接原地掉头游回中间（受惊时同理，只是更快）
          var bounce2 = this.bounceDirection();
          dirX = bounce2.x;
          dirZ = bounce2.z;
          snapTurn = true;
          this.edgeTime = 0;
          console.log('AOYU_BOUNCE 贴边掉头');
        }
      }
      if (this.boosting && !boosting) this.pickTarget();   // 冲刺刚结束：挑个新目标继续巡游
      // 互相规避：把"远离另一条鱼"的分量叠加进期望方向（越近越强）
      var sep = this.separation(r);
      if (sep.w > 0) {
        dirX += sep.x * 1.7;
        dirZ += sep.z * 1.7;
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
      // 冲刺时转弯半径跟速度一起放大：角速度≈不变，所以是"直线窜出去"，
      // 而不是旧版那样在原地快速打转（角速度也乘 3.2）。
      if (boosting) turnRadius *= Math.max(1.5, this.tuning.startleSpeed * 0.7);
      this.turnRadius = turnRadius;                    // 调试面板显示真实值
      var maxTurn = Math.max(0.12, speedNow / turnRadius) * this.tuning.turnScale * d;
      // 贴边时给一个固定角速度兜底：正常巡游转角速度跟速度挂钩（转弯半径恒定，才不像原地转），
      // 但贴到边界上速度已经很低，那时转不过来，就会被硬约束按在边上蹭很久。
      if (rn > 0.85) {
        var edgeTurn = Math.min(1, (rn - 0.85) / 0.15) * EDGE_TURN_RATE * d;
        if (edgeTurn > maxTurn) maxTurn = edgeTurn;
      }
      var turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
      if (snapTurn) { turn = diff; this.bank = 0; }   // 原地掉头：这一帧直接转过去
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
      var rangeBoost = Math.max(0.25, r.x / Math.max(0.05, this.baseRadius()));
      var dash = this.dashSpeed();
      if (boosting && nowMs < this.startleBurstUntil) {
        // 爆冲阶段：速度按曲线从爆冲值落回持续冲刺值。
        // 这一段直接写速度、不走加速度积分——积分出来的曲线开头不够陡。
        var kBurst = (this.startleBurstUntil - nowMs) / CONFIG.startleBurstMs;   // 1 → 0
        this.speed = dash + (this.burstSpeed() - dash) * Math.max(0, Math.min(1, kBurst));
      } else {
        var want_speed = boosting
          ? Math.max(dash, this.speedTarget * this.tuning.speedScale * rangeBoost * 1.5)
          : this.speedTarget * this.tuning.speedScale * rangeBoost;
        // 冲刺时加速要猛；冲刺结束后速度远高于巡航，收油也要明显，不然会一路滑出去
        var over = this.speed > want_speed * 1.3;
        var accel = (want_speed > this.speed ? (boosting ? 9 : 1.2) : (over ? 3.2 : 0.9)) *
          Math.max(1, rangeBoost * 0.6);
        this.speed += Math.max(-accel * d, Math.min(accel * d, want_speed - this.speed));
      }
      if (!(this.speed > 0)) this.speed = 0;            // 同时挡住 NaN 与负数

      // 积分 + 高度起伏
      this.pos.x += this.head.x * this.speed * d;
      this.pos.z += this.head.z * this.speed * d;
      this.heightPhase += d * this.data.bobSpeed;
      var mid = (this.yMin() + this.yMax()) / 2;
      var amp = (this.yMax() - this.yMin()) / 2 * 0.8;
      this.pos.y = mid + Math.sin(this.heightPhase) * amp;

      // 硬约束：出圈按比例拉回，高度夹进区间
      var out = Math.sqrt((this.pos.x / r.x) * (this.pos.x / r.x) +
                          (this.pos.z / r.z) * (this.pos.z / r.z));
      if (out > 1) { this.pos.x /= out; this.pos.z /= out; this.edgeHit = true; }
      this.pos.y = Math.max(this.yMin(), Math.min(this.yMax(), this.pos.y));
      // 最后一道保底：两条鱼不许叠在一起。放在夹紧之后 —— 夹紧会把它俩拉近，
      // 放在前面等于白做。间距上限由 pairFit 保证塞得下，所以最多只是略微出圈一点点。
      this.enforceGap(r);

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
        var dist = this.exitDistance(this.pos.x, this.pos.z, cx, cz, 0.9);
        if (!best || dist > best.dist) best = { dist: dist, x: cx, z: cz };
      }
      this.startleDir = { x: best.x, z: best.z };
      this.target.x = this.pos.x + best.x * best.dist;
      this.target.z = this.pos.z + best.z * best.dist;
      this.targetTime = 0;
      this.targetDuration = 10;                  // 冲刺期间不换目标
      this.startleUntil = now + CONFIG.startleMs;
      this.startleStartedAt = now;
      this.startleBounces = 0;
      // 受惊的这一下：速度直接顶到爆冲值（不是慢慢加速），然后在 startleBurstMs 内
      // 沿曲线落回持续冲刺速度——像鱼被吓到突然窜出去，然后保持快游。
      this.speed = Math.max(this.speed, this.burstSpeed());
      this.startleBurstUntil = now + CONFIG.startleBurstMs;
      console.log('AOYU_STARTLE_SET 逃脱距离=' + best.dist.toFixed(2) +
        ' 爆冲速度=' + this.burstSpeed().toFixed(2) +
        ' 持续冲刺=' + this.dashSpeed().toFixed(2) +
        ' 当前速度=' + this.speed.toFixed(2));
    },

    /**
     * 撞到边界时的掉头方向：朝圆心，再随机偏 ±46°。
     * 每次角度都不一样，所以受惊期间连着撞几次，看起来就是四处乱窜。
     */
    bounceDirection: function () {
      var r = this.radii();
      var nx = this.pos.x / (r.x * r.x), nz = this.pos.z / (r.z * r.z);   // 向外法线
      var nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl; nz /= nl;
      var ix = -nx, iz = -nz;                                            // 朝内
      var a = (this.rng() - 0.5) * 1.6;
      var ca = Math.cos(a), sa = Math.sin(a);
      return { x: ix * ca - iz * sa, z: ix * sa + iz * ca };
    },

    /** 从 (px,pz) 沿 (dx,dz) 走到半径 k·R 的圆边界要走多远（解一元二次） */
    exitDistance: function (px, pz, dx, dz, k) {
      var R = this.radii().x * k;
      var a = dx * dx + dz * dz;
      var b = 2 * (px * dx + pz * dz);
      var c = px * px + pz * pz - R * R;
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
        radius: r.x.toFixed(2),
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
    targetMode: null,     // 'aoyu' | 'koi'
    activeKeys: [],       // 当前在场的鱼（锦鲤模式两条）
    forceMode: null,      // 调试强制
    offsetMs: 0,          // 调试时间偏移
    adaptive: false,      // 自适应：整幅构图一定留在画面内（默认关，保持按卡宽的固定比例）
    pcMode: false,        // PC 模式：桌面端（OBS 抓窗口）用调好的 pcModelScale 大小
    hitBoxVisible: false, // 调试：把命中包围盒画出来
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
      this.bindFullscreenKey();
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
        self.videoWatchdogTick();
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
        button.textContent = '“鳌运”请回家';
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
      // 点击鱼的音色走合成器（调音台定稿的那组参数）：第一次点击前先渲染好，点了立刻响
      if (window.AOYU_NOTE_SYNTH) {
        window.AOYU_NOTE_SYNTH.init(this.audioCtx);
        window.AOYU_NOTE_SYNTH.prewarm();
      }
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

      // 记录视频尺寸变化：iPhone 靠近时系统自动切镜头会走这里，日志里能直接看出来
      window.addEventListener('arjs-video-loaded', function (event) {
        var video = (event.detail && event.detail.component) || document.querySelector('#arjs-video');
        if (!video || video.tagName !== 'VIDEO') return;
        var lastSize = '';
        video.addEventListener('resize', function () {
          var size = video.videoWidth + '×' + video.videoHeight;
          if (size === lastSize) return;
          console.log('AOYU_CAMERA_VIDEO_RESIZED ' + (lastSize || '?') + ' → ' + size);
          lastSize = size;
        });
        video.addEventListener('loadedmetadata', function () {
          lastSize = video.videoWidth + '×' + video.videoHeight;
          console.log('AOYU_CAMERA_VIDEO_META ' + lastSize);
        });
      });

      // 切到后台/回到前台：后台不折腾（浏览器会暂停摄像头），回到前台再检查一次、必要时恢复
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          console.log('AOYU_PAGE_HIDDEN 进后台：摄像头由浏览器暂停，看门狗先停手');
          self._lastVideoTime = null;
          self._lastVideoTimeAt = 0;
          return;
        }
        console.log('AOYU_PAGE_VISIBLE 回到前台：检查摄像头是否恢复');
        setTimeout(function () {
          self.reassertLayout();          // 重新贴样式 + play() + 对齐画布
        }, 400);
        setTimeout(function () {
          self.videoWatchdogTick();       // 还没恢复就重挂一次流
        }, 1500);
      });

      // 启动后补两次：首帧布局时视口高度可能是 0（画布会卡在 0 高 → 全黑）
      setTimeout(function () { self.forceCanvasSize(); }, 300);
      setTimeout(function () { self.forceCanvasSize(); }, 1500);
      window.addEventListener('resize', function () { self.forceCanvasSize(); });

      // 全屏切换（PC Chrome 按 F11 / 全屏按钮）：记录尺寸，并让 A-Frame 重新量一次画布
      ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
        document.addEventListener(name, function () {
          var fs = document.fullscreenElement || document.webkitFullscreenElement;
          console.log('AOYU_FULLSCREEN ' + (fs ? 'on' : 'off') + ' ' +
            window.innerWidth + '×' + window.innerHeight);
          self.reassertLayout();
        });
      });

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

    /**
     * 把画布尺寸强制对齐到视口。
     * PC Chrome 上首帧布局时 window.innerHeight 可能还是 0，A-Frame 会把 canvas 的
     * 绘制缓冲设成 0 高（日志里就是 drawingBuffer=1440×0），之后如果没再收到 resize
     * 事件，画布就永远停在 0 高 —— 表现就是整页全黑（相机层还被这块黑画布盖住）。
     */
    forceCanvasSize: function () {
      var sceneEl = this.sceneEl;
      var renderer = sceneEl && sceneEl.renderer;
      if (!renderer) return;
      var canvas = renderer.domElement;
      var ratio = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
      var w = Math.max(1, window.innerWidth || 0);
      var h = Math.max(1, window.innerHeight || 0);
      var wantW = Math.floor(w * ratio);
      var wantH = Math.floor(h * ratio);
      if (canvas.width === wantW && canvas.height === wantH) return;
      renderer.setSize(w, h, false);          // false：CSS 尺寸由样式表控制（100%）
      console.log('AOYU_CANVAS_SIZE', canvas.width + '×' + canvas.height, '视口=' + w + '×' + h);
    },

    /**
     * 视频看门狗：每秒看一眼相机画面是不是还在推进。
     * Chrome 全屏、手机切镜头、iOS 回到前台之后，<video> 偶尔会"还在播但画面不动了"——
     * 表现就是整页黑（相机层不动，识别也就没有新帧）。这里检测到卡住就重挂一次同一路流。
     */
    videoWatchdogTick: function () {
      var video = this.findArVideo();
      if (!video || video.tagName !== 'VIDEO' || !video.srcObject) return;
      // 页面在后台时浏览器会主动暂停摄像头（隐私策略），这是正常的，不能当成"卡住"去重挂流——
      // 之前就是在后台反复重挂，回到前台时流已经被折腾坏了，画面就没了。
      if (document.hidden) return;
      var now = performance.now();
      if (video.paused || video.readyState < 2) {
        console.log('AOYU_VIDEO_STALLED paused=' + video.paused + ' ready=' + video.readyState);
        this.recoverVideo(video);
        return;
      }
      if (this._lastVideoTime !== video.currentTime) {
        this._lastVideoTime = video.currentTime;
        this._lastVideoTimeAt = now;
        return;
      }
      if (this._lastVideoTimeAt && now - this._lastVideoTimeAt > 1500) {
        console.log('AOYU_VIDEO_STALLED currentTime 不动 ' +
          Math.round(now - this._lastVideoTimeAt) + 'ms');
        this.recoverVideo(video);
      }
    },

    /** 重挂同一路流（强制重新解码）：全屏/切镜头/回前台后画面卡住时用 */
    recoverVideo: function (video) {
      var stream = video && video.srcObject;
      if (!stream) return;
      // 流本身还活着（track.readyState === 'live'）→ 重挂同一路就够了；
      // 如果 track 已经 ended（Chrome 长时间遮挡后可能直接结束这路流），重挂旧流也没用，
      // 必须重新 getUserMedia 开一次摄像头。
      var live = false;
      var tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].readyState === 'live') { live = true; break; }
      }
      if (!live && tracks.length) {
        var now = performance.now();
        if (!this._lastReacquireAt || now - this._lastReacquireAt > 5000) {
          this._lastReacquireAt = now;
          console.log('AOYU_VIDEO_REACQUIRE 原流已结束（track.readyState=' + tracks[0].readyState + '），重新开摄像头');
          this.openCameraByGesture();   // 复用"点一下开相机"那条路径（自己 getUserMedia + 挂到 video 上）
          return;
        }
        return;
      }
      video.style.display = 'none';
      video.srcObject = null;
      video.srcObject = stream;
      video.muted = true;
      video.style.display = '';
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      this._lastVideoTime = null;
      this._lastVideoTimeAt = performance.now();
      this.forceCanvasSize();
      console.log('AOYU_VIDEO_REATTACH ready=' + video.readyState);
    },

    /**
     * 全屏/尺寸变化后重新贴一次画面尺寸，并让 A-Frame 重新量画布。
     * 全屏时浏览器给的 resize 时机有时早于布局稳定，画布会停在旧尺寸（表现是黑屏或只占一块），
     * 这里隔一小会儿再补一次 resize 事件。
     */
    reassertLayout: function () {
      var self = this;
      var video = this.findArVideo();
      if (video) {
        // 全屏切换后视频偶尔会掉出合成层（画面冻结/变黑），用一次无感的"重绘"把它拉回来
        if (video.tagName === 'VIDEO') {
          video.style.opacity = '0.999';
          void video.offsetHeight;
          video.style.opacity = '1';
        }
        video.style.setProperty('position', 'fixed', 'important');
        video.style.setProperty('top', '0', 'important');
        video.style.setProperty('left', '0', 'important');
        video.style.setProperty('width', '100%', 'important');
        video.style.setProperty('height', '100%', 'important');
        video.style.setProperty('margin', '0', 'important');
        video.style.setProperty('object-fit', 'cover', 'important');
        video.style.setProperty('z-index', '0', 'important');
        if (video.tagName === 'VIDEO') {
          video.setAttribute('playsinline', '');
          video.setAttribute('webkit-playsinline', '');
          video.muted = true;
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
          // 视频真的停了（readyState<2 或 paused）：重挂一次同一路流，让它重新解码
          if (video.readyState < 2 || video.paused) {
            var stream = video.srcObject;
            if (stream) {
              video.srcObject = null;
              video.srcObject = stream;
              var p2 = video.play();
              if (p2 && p2.catch) p2.catch(function () {});
              console.log('AOYU_VIDEO_REATTACH ready=' + video.readyState);
            }
          }
        }
      }
      // 全屏后 0.8 秒打一条状态自检：视频元素、画布、实际绘制量（drawCalls>0 说明 AR 画面在画）
      setTimeout(function () {
        var v = self.findArVideo();
        var sceneEl = self.sceneEl;
        var canvas = sceneEl && sceneEl.renderer && sceneEl.renderer.domElement;
        var info = sceneEl && sceneEl.renderer && sceneEl.renderer.info;
        var vr = v && v.getBoundingClientRect();
        var cr = canvas && canvas.getBoundingClientRect();
        console.log('AOYU_DIAG_AFTER_FS ' +
          'video=' + (v ? (v.tagName + ' ' + Math.round(vr.width) + '×' + Math.round(vr.height) +
            ' ready=' + v.readyState + ' ' + (v.paused ? 'paused' : 'playing') +
            ' 画面=' + (v.videoWidth || 0) + '×' + (v.videoHeight || 0) +
            ' z=' + getComputedStyle(v).zIndex + ' op=' + getComputedStyle(v).opacity) : 'none') +
          ' canvas=' + (canvas ? (canvas.width + '×' + canvas.height + ' css=' +
            Math.round(cr.width) + '×' + Math.round(cr.height)) : 'none') +
          ' drawCalls=' + (info ? info.render.calls : '-') + ' tris=' + (info ? info.render.triangles : '-'));
      }, 800);
      var self2 = this;
      var refire = function () {
        window.dispatchEvent(new Event('resize'));
        self2.forceCanvasSize();              // A-Frame 量完之后再强制对齐一次，双保险
      };
      this.forceCanvasSize();
      setTimeout(refire, 60);
      setTimeout(refire, 300);
      if (video) console.log('AOYU_LAYOUT_REASSERT ' + video.tagName + ' ' + (video.videoWidth || 0) + '×' + (video.videoHeight || 0));
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
        '　z ' + style.zIndex + '　' + style.display + '/' + style.visibility + '/' + style.opacity +
        '　卡片 ' + (this.marker && this.marker.object3D && this.marker.object3D.visible ? '已识别' : '未识别');
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
    /**
     * 判定放在**手指按下**的那一刻，不是抬手那一刻——
     * 鱼一直在游，抬手时它已经挪走了，按抬手的坐标判就会"看着点到了却没中"
     * （葫芦丝那个项目的音孔也是在 pointerdown 判的）。
     * 抬手只用来确认"这是点击而不是拖拽"：没点中才走惊吓。
     */
    bindTap: function () {
      var self = this;
      this.down = null;
      var start = function (event) {
        if (self.isUi(event)) return;
        var hit = self.handleTapDown(event.clientX, event.clientY);
        self.down = { x: event.clientX, y: event.clientY, hit: hit };
      };
      var end = function (event) {
        if (self.isUi(event)) return;
        var down = self.down;
        self.down = null;
        if (!down) return;
        var moved = Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y);
        if (moved > 20) {                  // 拖着画面/晃手机不算点击
          console.log('AOYU_TAP_SKIP 手指移动了', Math.round(moved), 'px');
          return;
        }
        if (down.hit) return;              // 按下的地方是鱼，声音已经出了
        self.handleTapEmpty(down.x, down.y);
      };
      window.addEventListener('pointerdown', start, { passive: true });
      window.addEventListener('pointerup', end, { passive: true });
    },

    /**
     * 按 F 切换全屏（Esc 退出交给浏览器）。
     * 带 ⌘/Ctrl/Alt 的组合键不拦（⌘⇧F 之类交给系统/浏览器），输入框里打字也不触发。
     */
    bindFullscreenKey: function () {
      var self = this;
      window.addEventListener('keydown', function (event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key !== 'f' && event.key !== 'F') return;
        var el = event.target;
        if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
        event.preventDefault();
        self.toggleFullscreen();
      });
    },

    toggleFullscreen: function () {
      var doc = document;
      var root = doc.documentElement;
      var fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (fsEl) {
        var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (!exit) return;
        Promise.resolve(exit.call(doc)).then(function () {
          console.log('AOYU_FULLSCREEN_KEY off');
        }).catch(function (e) { console.warn('AOYU_FULLSCREEN_KEY off 失败', e); });
        return;
      }
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!req) {
        console.log('AOYU_FULLSCREEN_KEY 不支持（这个浏览器没有全屏 API）');
        return;
      }
      console.log('AOYU_FULLSCREEN_KEY on');
      Promise.resolve(req.call(root)).catch(function (e) {
        console.warn('AOYU_FULLSCREEN_KEY on 失败', e);
      });
    },

    isUi: function (event) {
      var el = event.target;
      return !!(el && el.closest && el.closest('#ui'));
    },

    /** 手指按下：按这一瞬间的位置判定，点中就立刻出声 */
    handleTapDown: function (x, y) {
      this.resumeAudio();
      // 卡片不在画面里就没有鱼可点：直接看 AR.js 的 marker 可见性（事件可能漏发）
      var markerVisible = !!(this.marker && this.marker.object3D && this.marker.object3D.visible);
      if (!markerVisible) {
        console.log('AOYU_TAP_SKIP 卡片不在画面里（marker.visible=false）');
        return false;
      }
      var list = this.activeFishList();
      for (var i = 0; i < list.length; i++) {
        if (this.hitFish(list[i], x, y)) {
          this.playRandomNote();
          return true;
        }
      }
      return false;
    },

    /** 抬手确认是点击（不是拖拽）、且按下的地方不是鱼 → 吓一跳 */
    handleTapEmpty: function (x, y) {
      if (!CONFIG.startleEnabled) return;
      var list = this.activeFishList();
      if (!list.length) return;
      var local = cardPointFromScreen(x, y);
      var threat = local ? { x: local.x, z: local.z } : null;
      list.forEach(function (fish) { fish.startle(threat); });
      console.log('AOYU_STARTLE', list.map(function (f) { return f.data.key; }).join('+'),
        threat ? threat.x.toFixed(2) + ',' + threat.z.toFixed(2) : 'no-point');
    },

    /** 主鱼（调试面板、锚点环、状态行用它；锦鲤模式下还有第二条） */
    activeFish: function () {
      var key = this.activeKeys && this.activeKeys[0];
      if (!key) key = this.targetMode === 'koi' ? 'koi' : 'aoyu';
      return instances[key] || null;
    },

    /** 当前在场的所有鱼 */
    activeFishList: function () {
      var list = [];
      var keys = this.activeKeys || [];
      for (var i = 0; i < keys.length; i++) {
        if (instances[keys[i]]) list.push(instances[keys[i]]);
      }
      return list;
    },

    /**
     * 命中判定。三层，任意一层中就算点到了鱼（这一套是照葫芦丝那个项目的做法来的）：
     *   ① 模型网格射线：three 的 raycast 对 SkinnedMesh 会按骨骼逐三角形算，
     *      所以它跟着当前骨骼姿势（但只有真正的三角形才算，鱼鳍这种薄片容易擦过去）
     *   ② **模型本地包围盒 + 25% 手指容差**：射线转进模型坐标系里判，
     *      盒子跟着鱼的朝向走，不会因为旋转而虚胖
     *   ③ **屏幕轮廓 + 26px 手指容差**：把鱼的顶点投到屏幕上取凸包，
     *      手指落在轮廓里、或者离轮廓不超过 26px 都算点中。
     *      葫芦丝的音孔就靠这一层"感觉特别准"——因为容差是按屏膜像素给的，
     *      眼睛看到点到了就算到。前两层判不出来时用它兜。
     *
     * 注意：包围盒必须跟着骨骼动画重算（之前用绑定姿势的 geometry.boundingBox，
     * 鱼一摆尾身体就跑到盒子外面，这是"点鱼没声音"的一个根源）。
     */
    hitFish: function (fish, clientX, clientY) {
      var sceneEl = this.sceneEl;
      var canvas = sceneEl.renderer && sceneEl.renderer.domElement;
      var camera = sceneEl.camera;
      var meshEl = fish.data.anim;
      var mesh = meshEl && meshEl.getObject3D('mesh');
      if (!canvas || !camera || !mesh) return false;
      // 葫芦丝那边踩过的坑，照抄：射线判定前必须把投影逆矩阵和世界矩阵都刷新，
      // 否则算出来的射线是旧的（AR.js 会直接往 camera.projectionMatrix 里拷矩阵）
      syncProjectionInverse(camera);
      camera.updateMatrixWorld(true);
      sceneEl.object3D.updateMatrixWorld(true);
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
        console.log('AOYU_HIT', fish.data.key, '包围盒没中',
          '盒尺寸 ' + size.x.toFixed(2) + '×' + size.y.toFixed(2) + '×' + size.z.toFixed(2));
      }

      // ③ 屏幕轮廓 + 手指容差（葫芦丝的音孔就靠这层，容差按像素算，"看着点到就算到"）
      var hull = this.fishScreenHull(fish, camera, rect);
      var hullDist = hull ? this.distanceToHull(hull, clientX, clientY) : -1;
      if (hull && hullHit(hull, clientX, clientY, HIT_PADDING_PX)) {
        console.log('AOYU_HIT', fish.data.key, '轮廓+容差',
          hull.length + '点 轮廓距离=' + hullDist.toFixed(1) + 'px');
        return true;
      }
      var hullBox = '';
      if (hull && hull.length) {
        var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (var hi = 0; hi < hull.length; hi++) {
          mnx = Math.min(mnx, hull[hi][0]); mxx = Math.max(mxx, hull[hi][0]);
          mny = Math.min(mny, hull[hi][1]); mxy = Math.max(mxy, hull[hi][1]);
        }
        hullBox = ' 轮廓框 ' + Math.round(mnx) + ',' + Math.round(mny) + '~' + Math.round(mxx) + ',' + Math.round(mxy);
      }
      console.log('AOYU_HIT', fish.data.key, '没点中',
        '离轮廓 ' + (hullDist >= 0 ? hullDist.toFixed(1) + 'px（容差 ' + HIT_PADDING_PX + 'px）' : '算不出来') + hullBox);
      return false;
    },

    /** 手指点到轮廓的距离（在轮廓内返回 0） */
    distanceToHull: function (hull, px, py) {
      if (!hull || hull.length < 3) return -1;
      if (hullHit(hull, px, py, 0)) return 0;
      var best = Infinity;
      for (var i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        var xi = hull[i][0], yi = hull[i][1];
        var xj = hull[j][0], yj = hull[j][1];
        var dx = xj - xi, dy = yj - yi;
        var len2 = dx * dx + dy * dy;
        var t = len2 > 0 ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2)) : 0;
        var cx = xi + t * dx - px, cy = yi + t * dy - py;
        best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
      }
      return best;
    },

    /**
     * 把鱼的顶点投影到屏幕上，取凸包当轮廓。
     * 蒙皮网格按骨骼算当前姿势（和命中判定同一套坐标），普通网格直接取顶点。
     */
    fishScreenHull: function (fish, camera, rect) {
      var animEl = fish.data.anim;
      var root = animEl && animEl.getObject3D('mesh');
      if (!root) return null;
      var pts = [];
      var v = new THREE.Vector3();
      root.updateWorldMatrix(true, true);
      root.traverse(function (node) {
        if (!node.isMesh || !node.geometry || isDebugHitBox(node)) return;
        var pos = node.geometry.attributes && node.geometry.attributes.position;
        if (!pos) return;
        var step = Math.max(1, Math.floor(pos.count / HIT_SAMPLES));
        for (var i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i);
          if (node.isSkinnedMesh && node.skeleton && !skinnedVertex(node, i, v)) continue;
          v.applyMatrix4(node.matrixWorld).project(camera);
          if (!isFinite(v.x) || !isFinite(v.y)) continue;
          pts.push([rect.left + (v.x * 0.5 + 0.5) * rect.width,
                    rect.top + (-v.y * 0.5 + 0.5) * rect.height]);
        }
      });
      if (pts.length < 3) return null;
      return convexHull(pts);
    },

    /**
     * 模型本地坐标系里的整体包围盒（跟着当前骨骼姿势），整体放大 25% 当手指容差。
     *
     * 这里是"点鱼没声音"的关键：geometry.boundingBox 是**绑定姿势**的盒子，
     * 鱼摆尾、转弯之后身体会跑到盒子外面，点上去就没反应。
     * 现在对 SkinnedMesh 按索引均匀抽 96 个顶点，按骨骼算它们当前姿势的位置，
     * 再取包围盒——所以它会跟着鱼一起动。只在点击时和调试显示时算，不影响帧率。
     */
    fishLocalBox: function (mesh) {
      // 模型本地坐标系：点击判定把射线用 inverse(mesh.matrixWorld) 变到同一个坐标系，
      // 调试盒也是挂在模型节点下面，两边必须一致。
      var toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      var box = skinnedPointBox(mesh, HIT_SAMPLES, toLocal);
      if (!box) return null;
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
      // 首选合成器（bell-timbre-lab 定稿音色），没有才退回 mp3
      if (window.AOYU_NOTE_SYNTH && window.AOYU_NOTE_SYNTH.play(index)) {
        this.resumeAudio();
        console.log('AOYU_NOTE_PLAY', index, CONFIG.notes[index], 'synth');
        return;
      }
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

    setMarkerActive: function (active) {
      if (this.markerActive === active) return;
      this.markerActive = active;
      var hint = document.getElementById('hint');
      if (!hint) return;
      if (active) hint.classList.add('hidden');
      else {
        hint.textContent = '把整张鳌鱼二维码放进画面';
        hint.classList.remove('hidden');
      }
    },

    /* ---------- 按系统时间换鱼 ---------- */
    effectiveNow: function () {
      return new Date(Date.now() + this.offsetMs);
    },

    /** 当前时间算不算"鳌鱼时段"（切换点精确到分钟，默认 20:30） */
    isAoyuTime: function (now) {
      var minutes = now.getHours() * 60 + now.getMinutes();
      var boundary = CONFIG.switchHour * 60 + CONFIG.switchMinute;
      return minutes >= boundary;
    },

    updateTimeMode: function () {
      if (this.forceMode) {
        this.applyMode(this.forceMode);
        return;
      }
      var now = this.effectiveNow();
      // 这里必须是 this（函数里没有 self：写成 self.isAoyuTime 会抛 ReferenceError，
      // 而且是在 init 里调用的，会把后面的初始化一起带崩）
      this.applyMode(this.isAoyuTime(now) ? 'aoyu' : 'koi');
      this.scheduleSwitch(now);
    },

    scheduleSwitch: function (now) {
      if (this.switchTimer) clearTimeout(this.switchTimer);
      var next = new Date(now.getTime());
      next.setHours(CONFIG.switchHour, CONFIG.switchMinute, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      var delay = Math.max(1000, next.getTime() - now.getTime() + 100);
      var self = this;
      this.switchTimer = setTimeout(function () {
        self.switchTimer = null;
        self.updateTimeMode();
      }, delay);
    },

    /**
     * 切换模式：显示这个模式在场的鱼（锦鲤模式是两条），隐藏其它。
     * 这只决定"哪几条鱼在场"，和卡片在不在画面里无关（那个交给 AR.js 的 marker 可见性）。
     */
    applyMode: function (next) {
      if (this.targetMode === next) return;
      this.targetMode = next;
      var keys = CONFIG.modeFish[next] || [next];
      this.activeKeys = keys.slice();
      Object.keys(instances).forEach(function (key) {
        var fish = instances[key];
        if (!fish) return;
        if (keys.indexOf(key) >= 0) fish.enter();
        else fish.hide();
      });
      console.log('AOYU_TIME_MODE', next, keys.join('+'));
      this.syncModeButtons();
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
        var natural = self.isAoyuTime(now) ? '鳌鱼' : '锦鲤';
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
          '游动：有界漫游　半径 ' + status.radius + ' 张卡宽（圆）' +
          '　高 ' + status.height + '　' + status.state + '　' +
          '速度×' + status.tuning.speedScale.toFixed(2) +
          ' 转向×' + status.tuning.turnScale.toFixed(2) +
          ' 范围×' + status.tuning.rangeScale.toFixed(2) +
          '（目标占屏' + Math.round(Math.min(1, status.tuning.rangeScale / 5.9) * 100) + '%）' +
          ' 实半径' + status.radius +
          (fish.adaptive ? ' 自适×' + status.fit.toFixed(2) : '') +
          ' 摆尾×' + status.tuning.animSpeedMax.toFixed(2) +
          ' 大小×' + (self.pcMode ? status.tuning.pcModelScale : status.tuning.modelScale).toFixed(2) +
          (self.pcMode ? '(PC)' : '') +
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
      document.getElementById('db-2029').addEventListener('click', function () { self.setClockAt(20, 29, 55); });
      document.getElementById('db-2031').addEventListener('click', function () { self.setClockAt(20, 31, 0); });
      document.getElementById('db-koi').addEventListener('click', function () { self.setForce('koi'); });
      document.getElementById('db-aoyu').addEventListener('click', function () { self.setForce('aoyu'); });
      document.getElementById('db-follow').addEventListener('click', function () { self.setForce(null); });

      var knob = function (key, delta) {
        var fish = self.activeFish();
        if (!fish) return;
        // PC 模式下「鱼大/小」调的是 PC 专用大小，现场那套不动
        if (key === 'modelScale' && self.pcMode) key = 'pcModelScale';
        var limits = CONFIG.tuningLimits[key];
        // 防御 NaN：clamp 的实现对 NaN 会把 NaN 原样传下去，一旦存进去就永久坏掉
        var base = fish.tuning[key];
        if (typeof base !== 'number' || !isFinite(base)) base = 1;
        var next = Math.round(clamp(base + delta, limits[0], limits[1]) * 100) / 100;
        // 面板调的是**三条鱼共用**的值：tuning 原本每条鱼一份，只改当前这条的话，
        // 切到另一个时段（鳌鱼↔锦鲤）会发现那边还是旧值，得刷新才对得上（大小、范围都踩过）。
        Object.keys(instances).forEach(function (k) {
          if (instances[k]) instances[k].tuning[key] = next;
        });
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
      var pcBtnEl = document.getElementById('db-pc');
      if (pcBtnEl) pcBtnEl.addEventListener('click', function () { self.togglePcMode(); });
      document.getElementById('db-material').addEventListener('click', function () { self.toggleLightweight(); });
      document.getElementById('db-adaptive').addEventListener('click', function () { self.toggleAdaptive(); });
      document.getElementById('db-hitbox').addEventListener('click', function () { self.toggleHitBox(); });
      document.getElementById('db-anchor').addEventListener('click', function () { self.toggleAnchorRing(); });
      document.getElementById('db-reset').addEventListener('click', function () {
        var fish = self.activeFish();
        if (fish) fish.tuning = { speedScale: 1, turnScale: 1, rangeScale: DEFAULT_RANGE_SCALE, animSpeedMax: 1, modelScale: DEFAULT_MODEL_SCALE, pcModelScale: DEFAULT_MODEL_SCALE, startleSpeed: 4 };
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
          pcMode: !!this.pcMode,
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
      if (saved.pcMode) {
        this.pcMode = true;
        var pcBtn = document.getElementById('db-pc');
        if (pcBtn) { pcBtn.classList.add('on'); pcBtn.textContent = 'PC 模式：开'; }
      }
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
     * 调试用锚点环：在卡片坐标系里画一个与活动范围等大的圆环，和鱼同高。
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
      var r = fish ? fish.radii() : { x: 2.5, z: 2.5 };
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

    /** PC 模式开关：桌面端用 pcModelScale 这条大小，现场那套 modelScale 保持不动 */
    togglePcMode: function () {
      this.pcMode = !this.pcMode;
      var btn = document.getElementById('db-pc');
      if (btn) {
        btn.classList.toggle('on', this.pcMode);
        btn.textContent = this.pcMode ? 'PC 模式：开' : 'PC 模式：关';
      }
      this.saveTuning();
      this.refreshDebug();
      console.log('AOYU_PC_MODE', this.pcMode ? 'on' : 'off');
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

  // 初始化：等 a-scene 的 loaded 事件（marker 元素、资产都就绪）。
  // 注意这个脚本现在放在 <head>（必须在 <a-scene> 之前注册组件，否则 A-Frame 不会
  // 给实体挂上 fish-swim/fish-anim —— 表现就是"几条鱼全叠在锚点上不动"），
  // 所以这里第一次调用时 document 里可能还没有 a-scene，要等 DOMContentLoaded 再试。
  (function waitForScene() {
    var sceneEl = document.querySelector('a-scene');
    if (!sceneEl) {
      document.addEventListener('DOMContentLoaded', waitForScene, { once: true });
      return;
    }
    if (sceneEl.hasLoaded) {
      app.init();
    } else {
      sceneEl.addEventListener('loaded', function () { app.init(); }, { once: true });
    }
  })();
})();
