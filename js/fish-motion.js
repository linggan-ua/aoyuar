/**
 * 鱼的游动运动系统（纯数学，不依赖 xr-frame，可在 Node 里直接测试）
 *
 * 坐标系（卡片局部空间，由 xr-ar-tracker 提供）：
 *   X = 卡片宽度方向
 *   Y = 卡片法线（垂直卡面朝外）
 *   Z = 卡片高度方向
 *
 * 姿态规则：鱼的"背"对齐「世界正上方在垂直于游动方向平面上的投影」。
 *   卡片平放 → 世界正上方就是卡片法线 → 肚皮朝卡片（与历史行为一致）
 *   卡片贴墙 → 世界正上方是垂直方向 → 鱼立起来，观察者看到侧面
 *   实现上用「平行移动 + 重力矫正」，避免"朝正上方游"时的退化与姿态翻转。
 *
 * 朝向由 heading 直接构造，模型头在 rotation="0 90 0" 后本就朝局部 +Z，
 * 所以不存在倒着游的可能。
 */

var DEG = Math.PI / 180;

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(t) {
  var x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 向量工具：全部原地写入 scratch，避免每帧分配对象 ----
var tmpA = { x: 0, y: 0, z: 0 };
var tmpB = { x: 0, y: 0, z: 0 };
var tmpC = { x: 0, y: 0, z: 0 };
var tmpD = { x: 0, y: 0, z: 0 };

function vset(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; }
function vcopy(o, v) { return vset(o, v.x, v.y, v.z); }
function vsub(o, a, b) { return vset(o, a.x - b.x, a.y - b.y, a.z - b.z); }
function vscale(o, a, s) { return vset(o, a.x * s, a.y * s, a.z * s); }
function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function vcross(o, a, b) {
  var x = a.y * b.z - a.z * b.y;
  var y = a.z * b.x - a.x * b.z;
  var z = a.x * b.y - a.y * b.x;
  return vset(o, x, y, z);
}
function vlen(a) { return Math.sqrt(vdot(a, a)); }
function vnormalize(o, a) {
  var l = vlen(a);
  if (l < 1e-9) return vset(o, 0, 0, 0);
  return vscale(o, a, 1 / l);
}

// ---- 默认参数 ----
var DEFAULTS = {
  baseSpeed: 0.30,          // 单位/秒
  accelUp: 1.5,             // 冲刺时的加速度上限
  accelDown: 0.6,           // 减速时的加速度上限
  turnRate: 120 * DEG,      // 转向速率上限（弧度/秒）
  animSpeedMax: 2.2,
  animSpeedMin: 0.35,
  // 惊吓（爆发逃窜）专用：真实的鱼受惊时 0.1 秒内就达到最高速
  startleAccel: 16.0,        // 加速度上限（常规 1.5）
  startleSpeedScale: 6.5,    // 目标速度相对基准速度的倍率
  startleTurnScale: 5.0,     // 转向速率倍率（能瞬间掉头）
  startleWindow: 0.45,       // 爆发窗口，之后交给状态机自然滑行
  startleAnimMin: 3.2,       // 窗口内摆尾倍率下限（尾巴炸开）
  startleUpBias: 0.4,        // 沿"世界正上方"的分量，做出窜起再落下的弧线
  maxBank: 14 * DEG,
  boundaryMargin: 0.25,
  gravityTau: 0.4,          // 重力矫正时间常数（秒）
  bankTau: 0.25,
  region: { x: 0.95, yMin: 0.35, yMax: 0.90, z: 0.70 }
};

function pickTarget(s, region) {
  var r = region || DEFAULTS.region;
  s.target.x = (s.rng() * 2 - 1) * r.x * 0.8;
  s.target.z = (s.rng() * 2 - 1) * r.z * 0.8;
  s.target.y = lerp(r.yMin, r.yMax, 0.25 + s.rng() * 0.5);
}

function randomBetween(s, a, b) {
  return a + s.rng() * (b - a);
}

var STATE_WEIGHTS = {
  cruise: [['burst', 0.25], ['coast', 0.25], ['hover', 0.30], ['cruise', 0.20]],
  burst: [['coast', 0.70], ['cruise', 0.30]],
  coast: [['cruise', 0.50], ['hover', 0.30], ['burst', 0.20]],
  hover: [['cruise', 0.60], ['burst', 0.20], ['hover', 0.20]]
};

function enterState(s, name, region, personality) {
  s.state = name;
  s.stateTime = 0;
  if (name === 'cruise') {
    s.stateDuration = randomBetween(s, 2.5, 6.0);
    s.targetSpeed = s.baseSpeed * personality.speedScale * randomBetween(s, 0.8, 1.2);
    pickTarget(s, region);
  } else if (name === 'burst') {
    s.stateDuration = randomBetween(s, 0.4, 0.9);
    s.targetSpeed = s.baseSpeed * personality.speedScale * randomBetween(s, 1.8, 2.6);
  } else if (name === 'coast') {
    s.stateDuration = randomBetween(s, 0.8, 1.8);
    s.targetSpeed = s.baseSpeed * personality.speedScale * randomBetween(s, 0.25, 0.45);
  } else {
    s.stateDuration = randomBetween(s, 1.2, 3.0) * personality.hoverBias;
    s.targetSpeed = s.baseSpeed * personality.speedScale * randomBetween(s, 0.08, 0.25);
  }
}

function chooseNextState(s, region, personality) {
  var table = STATE_WEIGHTS[s.state] || STATE_WEIGHTS.cruise;
  var r = s.rng();
  var acc = 0;
  for (var i = 0; i < table.length; i++) {
    acc += table[i][1];
    if (r <= acc) {
      enterState(s, table[i][0], region, personality);
      return;
    }
  }
  enterState(s, table[0][0], region, personality);
}

/**
 * @param {object} opts
 *   seed        随机种子（同一条鱼固定性格；测试时可固定保证可复现）
 *   position    [x,y,z] 初始位置（默认区域中心）
 *   heading     [x,y,z] 初始朝向（默认朝 +Z）
 *   region      活动区域（默认见 DEFAULTS.region）
 *   personality {speedScale, turnScale, hoverBias}
 */
function createState(opts) {
  var o = opts || {};
  var seed = o.seed != null ? o.seed : Math.floor(Math.random() * 0xFFFFFFFF);
  var region = o.region || DEFAULTS.region;
  var s = {
    rng: mulberry32(seed),
    seed: seed,
    baseSpeed: o.baseSpeed || DEFAULTS.baseSpeed,
    region: {
      x: region.x, yMin: region.yMin, yMax: region.yMax, z: region.z
    },
    pos: { x: 0, y: (region.yMin + region.yMax) / 2, z: 0 },
    heading: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    speed: 0,
    targetSpeed: 0,
    state: 'cruise',
    stateTime: 0,
    stateDuration: 0,
    wanderPhase: (seed % 1000) / 1000 * Math.PI * 2,
    bank: 0,
    animSpeed: 1,
    entering: false,
    exiting: false,
    startleTime: 0,
    elapsed: 0
  };
  s.personality = {
    speedScale: o.personality && o.personality.speedScale != null
      ? o.personality.speedScale : 0.85 + s.rng() * 0.3,
    turnScale: o.personality && o.personality.turnScale != null
      ? o.personality.turnScale : 0.85 + s.rng() * 0.3,
    hoverBias: o.personality && o.personality.hoverBias != null
      ? o.personality.hoverBias : 0.7 + s.rng() * 0.8
  };
  if (o.position) vset(s.pos, o.position[0], o.position[1], o.position[2]);
  if (o.heading) {
    vnormalize(s.heading, vset(tmpA, o.heading[0], o.heading[1], o.heading[2]));
  }
  s.up.y = 1;
  pickTarget(s, s.region);
  enterState(s, 'cruise', s.region, s.personality);
  return s;
}

/** 入场：从区域边缘高速游入，到位后转巡游 */
function startEntering(s) {
  var r = s.region;
  var edge = Math.floor(s.rng() * 4);
  var p = { x: 0, y: 0, z: 0 };
  if (edge === 0) vset(p, -r.x, lerp(r.yMin, r.yMax, 0.5), 0);
  else if (edge === 1) vset(p, r.x, lerp(r.yMin, r.yMax, 0.5), 0);
  else if (edge === 2) vset(p, 0, lerp(r.yMin, r.yMax, 0.5), -r.z);
  else vset(p, 0, lerp(r.yMin, r.yMax, 0.5), r.z);
  vcopy(s.pos, p);
  // 目标放在区域内部偏中心的位置
  s.target.x = (s.rng() * 2 - 1) * r.x * 0.35;
  s.target.z = (s.rng() * 2 - 1) * r.z * 0.35;
  s.target.y = lerp(r.yMin, r.yMax, 0.35 + s.rng() * 0.3);
  vnormalize(s.heading, vsub(tmpA, s.target, s.pos));
  if (vlen(s.heading) < 1e-6) vset(s.heading, 0, 0, 1);
  s.speed = s.baseSpeed * s.personality.speedScale * 1.6;
  s.targetSpeed = s.speed;
  s.entering = true;
  s.exiting = false;
  s.state = 'cruise';
  s.stateTime = 0;
  s.stateDuration = 4;
}

/** 退场：朝区域外沿当前方向加速离开 */
function startExiting(s) {
  s.exiting = true;
  s.entering = false;
  s.state = 'burst';
  s.stateTime = 0;
  s.stateDuration = 1.2;
  s.targetSpeed = s.baseSpeed * s.personality.speedScale * 3.2;
  // 沿卡片平面朝外离开（去掉法线分量），避免"潜出卡片"的怪动作
  var dx = s.heading.x;
  var dz = s.heading.z;
  var dl = Math.sqrt(dx * dx + dz * dz);
  if (dl < 1e-3) { dx = 0; dz = 1; dl = 1; }
  vset(s.target,
    s.pos.x + (dx / dl) * 3,
    clamp(s.pos.y, s.region.yMin, s.region.yMax),
    s.pos.z + (dz / dl) * 3);
}

var _startleDir = { x: 0, y: 0, z: 0 };

/**
 * 被吓一跳：朝远离威胁点的方向逃窜（冲刺 + 快速摆尾），
 * 1.4 秒后交给状态机自然转入滑行。
 * @param {object} s      鱼的状态
 * @param {object} threat 威胁点（卡片局部坐标，形如 {x, z}）
 */
function startle(s, threat) {
  if (!s) return;
  if (threat && (threat.x != null || threat.z != null)) {
    vset(_startleDir, s.pos.x - (threat.x || 0), 0, s.pos.z - (threat.z || 0));
  } else {
    vset(_startleDir, 0, 0, 0);
  }
  vnormalize(_startleDir, _startleDir);
  if (vlen(_startleDir) < 1e-3) {
    // 威胁点几乎与鱼重合：沿当前朝向逃
    vset(_startleDir, s.heading.x, 0, s.heading.z);
    vnormalize(_startleDir, _startleDir);
    if (vlen(_startleDir) < 1e-3) vset(_startleDir, 0, 0, 1);
  }

  var r = s.region;
  var reach = Math.min(r.x, r.z) * 0.9;
  s.target.x = clamp(s.pos.x + _startleDir.x * reach, -r.x, r.x);
  s.target.z = clamp(s.pos.z + _startleDir.z * reach, -r.z, r.z);
  s.target.y = clamp(s.pos.y, r.yMin, r.yMax);

  enterState(s, 'burst', r, s.personality);
  s.stateDuration = 0.75;                     // 爆发很短，之后立刻转入滑行
  s.targetSpeed = s.baseSpeed * s.personality.speedScale * DEFAULTS.startleSpeedScale;
  s.startleTime = DEFAULTS.startleWindow;
  s.entering = false;
  s.exiting = false;
}

function axisAvoid(out, axis, v, min, max, margin) {
  var hi = max - margin;
  var lo = min + margin;
  if (v > hi) out[axis] -= smoothstep((v - hi) / margin);
  else if (v < lo) out[axis] += smoothstep((lo - v) / margin);
}

function computeDesired(s, region, personality, upRef) {
  var desired = tmpA;
  var seek = tmpB;
  var avoid = tmpC;
  var wander = tmpD;

  // 1) seek：朝目标点，靠近时减速（arrive）
  vsub(seek, s.target, s.pos);
  var dist = vlen(seek);
  if (dist > 1e-6) vscale(seek, seek, 1 / dist);
  if (dist < 0.25) vscale(seek, seek, 0.35);

  // 2) 边界避让：越近越强，软性拐回，不撞墙（退场时不需要，鱼要离开）
  vset(avoid, 0, 0, 0);
  if (!s.exiting) {
    var margin = DEFAULTS.boundaryMargin;
    axisAvoid(avoid, 'x', s.pos.x, -region.x, region.x, margin);
    axisAvoid(avoid, 'y', s.pos.y, region.yMin, region.yMax, margin);
    axisAvoid(avoid, 'z', s.pos.z, -region.z, region.z, margin);
  }

  // 3) 随机游走：缓慢旋转的相位，打破数学感
  var w = s.wanderPhase;
  vset(wander,
    Math.cos(w) * 0.35,
    Math.sin(w * 0.7) * 0.25,
    Math.sin(w * 1.3 + 1.7) * 0.35);

  var wanderWeight = s.exiting ? 0 : 0.45;
  vset(desired,
    seek.x * 1.0 + avoid.x * 2.0 + wander.x * wanderWeight,
    seek.y * 1.0 + avoid.y * 2.0 + wander.y * wanderWeight,
    seek.z * 1.0 + avoid.z * 2.0 + wander.z * wanderWeight);
  vnormalize(desired, desired);

  // 限制"世界竖直方向"上的分量：鱼以水平巡游为主。
  // 同时也保证姿态不需要大幅翻转（否则背方向要跟着转 90°，会滞后）。
  if (upRef && !s.exiting) {
    var along = vdot(desired, upRef);
    var MAX_VERTICAL = 0.55;
    if (Math.abs(along) > MAX_VERTICAL) {
      var excess = along - (along > 0 ? MAX_VERTICAL : -MAX_VERTICAL);
      desired.x -= upRef.x * excess;
      desired.y -= upRef.y * excess;
      desired.z -= upRef.z * excess;
      vnormalize(desired, desired);
    }
  }
  if (vlen(desired) < 1e-6) vcopy(desired, s.heading);
  return desired;
}

/** 限速转向，返回本帧有符号转角（弧度），用于倾斜 */
function steer(s, desired, dt, turnRate) {
  var cosA = clamp(vdot(s.heading, desired), -1, 1);
  var ang = Math.acos(cosA);
  var maxTurn = turnRate * dt;
  if (ang < 1e-4 || ang <= maxTurn) {
    vcopy(s.heading, desired);
    return 0;
  }
  vcross(tmpB, s.heading, desired);
  var sinA = vlen(tmpB);
  var sign;
  if (sinA < 1e-6) {
    // 反向：用 up 作为旋转轴兜底（水平掉头）
    vcopy(tmpB, s.up);
    sign = 1;
  } else {
    vnormalize(tmpB, tmpB);
    sign = vdot(tmpB, s.up) >= 0 ? 1 : -1;
  }
  var cosT = Math.cos(maxTurn);
  var sinT = Math.sin(maxTurn);
  vcross(tmpC, tmpB, s.heading);
  vset(s.heading,
    s.heading.x * cosT + tmpC.x * sinT,
    s.heading.y * cosT + tmpC.y * sinT,
    s.heading.z * cosT + tmpC.z * sinT);
  vnormalize(s.heading, s.heading);
  return sign * maxTurn;
}

/**
 * 把 from 沿最短弧朝 to 旋转 maxAngle（弧度），结果写入 out。
 * 不能用线性插值：当 from 与 to 接近反向时 lerp 是一个不稳定不动点，
 * 姿态会永久卡在翻转状态（实测贴墙场景 p99 误差 171°）。
 */
var _rax = { x: 0, y: 0, z: 0 };
function rotateTowards(out, from, to, maxAngle) {
  var d = clamp(vdot(from, to), -1, 1);
  var ang = Math.acos(d);
  if (ang < 1e-5) { return vcopy(out, to); }
  vcross(_rax, from, to);
  if (vlen(_rax) < 1e-6) {
    // 正好反向：绕任意与 from 垂直的轴转
    vcross(_rax, from, { x: 0, y: 1, z: 0 });
    if (vlen(_rax) < 1e-6) vcross(_rax, from, { x: 1, y: 0, z: 0 });
  }
  vnormalize(_rax, _rax);
  var t = Math.min(ang, maxAngle);
  var cosT = Math.cos(t);
  var sinT = Math.sin(t);
  vcross(tmpC, _rax, from);
  return vset(out,
    from.x * cosT + tmpC.x * sinT,
    from.y * cosT + tmpC.y * sinT,
    from.z * cosT + tmpC.z * sinT);
}

function quatFromBasis(out, right, up, forward) {
  var m00 = right.x, m01 = up.x, m02 = forward.x;
  var m10 = right.y, m11 = up.y, m12 = forward.y;
  var m20 = right.z, m21 = up.z, m22 = forward.z;
  var tr = m00 + m11 + m22;
  var x, y, z, w;
  if (tr > 0) {
    var s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    var s1 = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s1;
    x = 0.25 * s1;
    y = (m01 + m10) / s1;
    z = (m02 + m20) / s1;
  } else if (m11 > m22) {
    var s2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s2;
    x = (m01 + m10) / s2;
    y = 0.25 * s2;
    z = (m12 + m21) / s2;
  } else {
    var s3 = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s3;
    x = (m02 + m20) / s3;
    y = (m12 + m21) / s3;
    z = 0.25 * s3;
  }
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

function quatMultiply(out, a, b) {
  var ax = a[0], ay = a[1], az = a[2], aw = a[3];
  var bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * 推进一帧。
 * @param {object} s      createState 返回的状态
 * @param {number} dt     秒
 * @param {object} env    { upRef:[x,y,z], tuning:{speedScale,turnScale,rangeScale,animSpeedMax} }
 * @returns {object}      { position:[x,y,z], quaternion:[x,y,z,w], speed, animSpeed, bank }
 */
var _out = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  speed: 0,
  animSpeed: 1,
  bank: 0,
  state: 'cruise'
};
var _upRefVec = { x: 0, y: 1, z: 0 };
var _region = { x: 0, yMin: 0, yMax: 0, z: 0 };
var _right = { x: 0, y: 0, z: 0 };
var _up2 = { x: 0, y: 0, z: 0 };
var _q = [0, 0, 0, 1];
var _qBank = [0, 0, 0, 1];

function step(s, dt, env) {
  var e = env || {};
  var tuning = e.tuning || {};
  var speedScale = tuning.speedScale != null ? tuning.speedScale : 1;
  var turnScale = tuning.turnScale != null ? tuning.turnScale : 1;
  var rangeScale = tuning.rangeScale != null ? tuning.rangeScale : 1;
  var animSpeedMax = tuning.animSpeedMax != null ? tuning.animSpeedMax : DEFAULTS.animSpeedMax;

  var d = clamp(dt, 0, 0.05); // 卡帧保护：单帧最多推进 50ms
  s.elapsed += d;
  var startled = s.startleTime > 0;
  if (startled) s.startleTime = Math.max(0, s.startleTime - d);

  // 活动范围（调试面板可缩放）
  var region = _region;
  region.x = s.region.x * rangeScale;
  region.yMin = s.region.yMin;
  region.yMax = Math.max(s.region.yMin + 0.1, s.region.yMin + (s.region.yMax - s.region.yMin) * rangeScale);
  region.z = s.region.z * rangeScale;

  // 1) 状态机
  s.stateTime += d;
  if (!s.entering && !s.exiting) {
    if (s.stateTime >= s.stateDuration) {
      chooseNextState(s, region, s.personality);
    } else if (s.state === 'cruise') {
      vsub(tmpA, s.target, s.pos);
      if (vlen(tmpA) < 0.15) pickTarget(s, region);
    }
  }
  if (s.entering) {
    vsub(tmpA, s.target, s.pos);
    if (vlen(tmpA) < 0.3) {
      s.entering = false;
      enterState(s, 'cruise', region, s.personality);
    }
  }

  // 2) 期望方向 + 限速转向
  var upRefVec = e.upRef ? vset(_upRefVec, e.upRef[0], e.upRef[1], e.upRef[2]) : null;
  var desired = computeDesired(s, region, s.personality, upRefVec);
  // 爆发窗口内朝"世界正上方"偏一点，做出窜起再落下的弧线
  if (startled && upRefVec) {
    desired.x += upRefVec.x * DEFAULTS.startleUpBias;
    desired.y += upRefVec.y * DEFAULTS.startleUpBias;
    desired.z += upRefVec.z * DEFAULTS.startleUpBias;
    vnormalize(desired, desired);
  }
  var turnRate = DEFAULTS.turnRate * s.personality.turnScale * turnScale;
  if (startled) turnRate *= DEFAULTS.startleTurnScale;   // 能瞬间掉头

  var turnAmount = steer(s, desired, d, turnRate);
  s.wanderPhase += d * 0.9;

  // 3) 速度与位置
  var targetSpeed = s.targetSpeed * speedScale;
  var accel;
  if (targetSpeed > s.speed) {
    accel = startled ? DEFAULTS.startleAccel : DEFAULTS.accelUp;
  } else {
    accel = DEFAULTS.accelDown;
  }
  var dv = clamp(targetSpeed - s.speed, -accel * d, accel * d);
  s.speed = Math.max(0, s.speed + dv);
  s.pos.x += s.heading.x * s.speed * d;
  s.pos.y += s.heading.y * s.speed * d;
  s.pos.z += s.heading.z * s.speed * d;

  // 4) 边界兜底（软避让在前，这里只做最后夹取；退场时允许离开）
  if (!s.exiting) {
    s.pos.x = clamp(s.pos.x, -region.x, region.x);
    s.pos.y = clamp(s.pos.y, region.yMin, region.yMax);
    s.pos.z = clamp(s.pos.z, -region.z, region.z);
  }

  // 5) 姿态：平行移动 + 重力矫正
  var proj = vdot(s.up, s.heading);
  s.up.x -= s.heading.x * proj;
  s.up.y -= s.heading.y * proj;
  s.up.z -= s.heading.z * proj;
  if (vlen(s.up) < 1e-3) {
    // 退化：用卡片法线（局部 +Y）去掉朝向分量
    vset(tmpA, 0, 1, 0);
    var p2 = vdot(tmpA, s.heading);
    vset(s.up, -s.heading.x * p2, 1 - s.heading.y * p2, -s.heading.z * p2);
    if (vlen(s.up) < 1e-3) vset(s.up, 0, 0, 1);
  }
  vnormalize(s.up, s.up);

  if (e.upRef) {
    vset(tmpA, e.upRef[0], e.upRef[1], e.upRef[2]);
    var projU = vdot(tmpA, s.heading);
    vset(tmpB, tmpA.x - s.heading.x * projU, tmpA.y - s.heading.y * projU, tmpA.z - s.heading.z * projU);
    if (vlen(tmpB) > 0.15) {
      vnormalize(tmpB, tmpB);
      // 指数收敛到目标角度，且走最短弧（可翻越 180°）
      var errAngle = Math.acos(clamp(vdot(s.up, tmpB), -1, 1));
      var step = errAngle * (1 - Math.exp(-d / DEFAULTS.gravityTau));
      rotateTowards(s.up, s.up, tmpB, step);
      // 重新正交化到垂直于 heading
      var p3 = vdot(s.up, s.heading);
      s.up.x -= s.heading.x * p3;
      s.up.y -= s.heading.y * p3;
      s.up.z -= s.heading.z * p3;
      vnormalize(s.up, s.up);
    }
  }

  // 6) 正交基 → 四元数
  vcross(_right, s.up, s.heading);
  vnormalize(_right, _right);
  vcross(_up2, s.heading, _right);
  vnormalize(_up2, _up2);
  quatFromBasis(_q, _right, _up2, s.heading);

  // 7) 倾斜：转弯时绕前进轴压弯
  var norm = turnRate * d > 1e-9 ? clamp(turnAmount / (turnRate * d), -1, 1) : 0;
  var bankTarget = -norm * DEFAULTS.maxBank;
  s.bank = lerp(s.bank, bankTarget, clamp(d / DEFAULTS.bankTau, 0, 1));
  if (Math.abs(s.bank) > 1e-4) {
    var half = s.bank / 2;
    // 右乘是局部坐标系：绕局部 +Z（前进方向）旋转，前进轴不受影响
    _qBank[0] = 0;
    _qBank[1] = 0;
    _qBank[2] = Math.sin(half);
    _qBank[3] = Math.cos(half);
    quatMultiply(_q, _q, _qBank);
  }

  // 8) 摆尾倍率跟游速联动
  var animCap = startled ? Math.max(animSpeedMax, DEFAULTS.startleAnimMin) : animSpeedMax;
  s.animSpeed = clamp(s.speed / (s.baseSpeed * speedScale), DEFAULTS.animSpeedMin, animCap);

  _out.position[0] = s.pos.x;
  _out.position[1] = s.pos.y;
  _out.position[2] = s.pos.z;
  _out.quaternion[0] = _q[0];
  _out.quaternion[1] = _q[1];
  _out.quaternion[2] = _q[2];
  _out.quaternion[3] = _q[3];
  _out.speed = s.speed;
  _out.animSpeed = s.animSpeed;
  _out.bank = s.bank;
  _out.state = s.state;
  return _out;
}

var FishMotion = {
  DEFAULTS: DEFAULTS,
  createState: createState,
  step: step,
  startEntering: startEntering,
  startExiting: startExiting,
  startle: startle,
  _internals: {
    mulberry32: mulberry32,
    vdot: vdot, vlen: vlen, vcross: vcross, vnormalize: vnormalize, vset: vset, vcopy: vcopy
  }
};

// 浏览器里挂到 window，Node（tools/fish-motion-test.js）里照旧走 module.exports
if (typeof window !== 'undefined') window.FishMotion = FishMotion;
if (typeof module !== 'undefined' && module.exports) module.exports = FishMotion;
