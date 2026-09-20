/**
 * fish-motion 的不变量测试（Node 直接跑）：
 *   node tools/fish-motion-test.js
 *
 * 检查：无 NaN、不越界、朝向与速度一致（头朝前）、四元数连续不翻转、
 *       姿态能按重力对齐、状态机四个状态都会被访问、速度与摆尾倍率在范围内。
 */
const path = require('path');
const MODULE = path.join(__dirname, '..', 'js', 'fish-motion.js');
const M = require(MODULE);

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function quatRotate(q, v) {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  const tx = cx + w * v[0];
  const ty = cy + w * v[1];
  const tz = cz + w * v[2];
  return [
    v[0] + 2 * (y * tz - z * ty),
    v[1] + 2 * (z * tx - x * tz),
    v[2] + 2 * (x * ty - y * tx)
  ];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));

function run(label, upRef, frames) {
  console.log(`\n【${label}】upRef = [${upRef.join(', ')}]`);
  const s = M.createState({ seed: 12345 });
  M.startEntering(s);
  const dt = 1 / 60;
  const seenStates = new Set();
  let maxSpeed = 0, minSpeed = Infinity, maxAnim = 0, minAnim = Infinity;
  let prevPos = null, prevQ = null, prevH = null, maxStep = 0, minQDot = 1;
  let forwardErr = 0, nanFound = false, outOfBounds = 0;
  let upsideDown = 0;            // 水平巡游时背朝向翻转（>90°）
  const steadyErrors = [];       // 不转弯时的姿态误差

  for (let i = 0; i < frames; i++) {
    const out = M.step(s, dt, { upRef, tuning: {} });
    const seg = s.region;
    if (out.position.some((v) => !Number.isFinite(v)) || out.quaternion.some((v) => !Number.isFinite(v))) {
      nanFound = true;
      break;
    }
    if (Math.abs(out.position[0]) > seg.x + 1e-6 ||
        Math.abs(out.position[2]) > seg.z + 1e-6 ||
        out.position[1] < seg.yMin - 1e-6 || out.position[1] > seg.yMax + 1e-6) outOfBounds++;

    // 头朝前：四元数作用到模型局部 +Z 必须等于 heading
    const fwd = quatRotate(out.quaternion, [0, 0, 1]);
    const h = [s.heading.x, s.heading.y, s.heading.z];
    forwardErr = Math.max(forwardErr, 1 - dot(fwd, h));

    // 姿态：只在"水平巡游"（目标方向良态）时判定
    const proj = upRef.map((c, k) => c - h[k] * dot(upRef, h));
    const projLen = len(proj);
    if (projLen > 0.86) {
      const target = proj.map((c) => c / projLen);
      const upWorld = quatRotate(out.quaternion, [0, 1, 0]);
      const errDeg = Math.acos(Math.max(-1, Math.min(1, dot(upWorld, target)))) * 180 / Math.PI;
      if (errDeg > 90) upsideDown++;
      if (prevH) {
        const turnDeg = Math.acos(Math.max(-1, Math.min(1, dot(h, prevH)))) * 180 / Math.PI;
        if (turnDeg < 0.35) steadyErrors.push(errDeg);
      }
    }
    prevH = h;

    if (prevPos) maxStep = Math.max(maxStep, len(out.position.map((c, k) => c - prevPos[k])));
    if (prevQ) minQDot = Math.min(minQDot, Math.abs(prevQ.reduce((acc, c, k) => acc + c * out.quaternion[k], 0)));
    prevPos = out.position.slice();
    prevQ = out.quaternion.slice();

    seenStates.add(out.state);
    maxSpeed = Math.max(maxSpeed, out.speed);
    minSpeed = Math.min(minSpeed, out.speed);
    maxAnim = Math.max(maxAnim, out.animSpeed);
    minAnim = Math.min(minAnim, out.animSpeed);
  }

  steadyErrors.sort((a, b) => a - b);
  const p90 = steadyErrors.length ? steadyErrors[Math.floor(steadyErrors.length * 0.9)] : 0;
  const median = steadyErrors.length ? steadyErrors[Math.floor(steadyErrors.length * 0.5)] : 0;

  check('无 NaN', !nanFound);
  check('不越界', outOfBounds === 0, `${outOfBounds} 帧越界`);
  check('头朝前（局部 +Z == heading）', forwardErr < 1e-5, `最大偏差 ${forwardErr.toExponential(2)}`);
  check('水平巡游时不会翻肚皮（误差 <90°）', upsideDown === 0, `${upsideDown} 帧翻转`);
  check('不转弯时姿态收敛到重力方向（p90 <30°）', p90 < 30,
    `中位 ${median.toFixed(1)}°，p90 ${p90.toFixed(1)}°`);
  check('四元数连续（无翻转）', minQDot > 0.98, `|dot| 最小 ${minQDot.toFixed(4)}`);
  check('单帧位移不超过速度上限', maxStep < 0.02, `最大 ${maxStep.toFixed(4)}`);
  check('速度非负且在合理范围', minSpeed >= 0 && maxSpeed < 1.2, `[${minSpeed.toFixed(3)}, ${maxSpeed.toFixed(3)}]`);
  check('摆尾倍率在 [0.35, 2.2]', minAnim >= 0.349 && maxAnim <= 2.201, `[${minAnim.toFixed(2)}, ${maxAnim.toFixed(2)}]`);
  check('四个状态都被访问', seenStates.size === 4, `实际 ${[...seenStates].join('/')}`);
  console.log(`    速度 ${minSpeed.toFixed(2)}–${maxSpeed.toFixed(2)}，摆尾 ${minAnim.toFixed(2)}–${maxAnim.toFixed(2)}，姿态中位 ${median.toFixed(1)}°`);
}

console.log('fish-motion 不变量测试');
run('卡片平放（法线朝上）', [0, 1, 0], 60 * 90);
run('卡片竖直贴墙（世界正上方在卡片局部 Z 轴）', [0, 0, 1], 60 * 90);
run('卡片倾斜 45 度', [0, Math.SQRT1_2, Math.SQRT1_2], 60 * 90);

console.log('\n【退场行为】');
{
  const s = M.createState({ seed: 7 });
  for (let i = 0; i < 300; i++) M.step(s, 1 / 60, { upRef: [0, 0, 1], tuning: {} });
  M.startExiting(s);
  let escaped = false;
  for (let i = 0; i < 90; i++) {
    const out = M.step(s, 1 / 60, { upRef: [0, 0, 1], tuning: {} });
    if (Math.abs(out.position[0]) > 1.0 || Math.abs(out.position[2]) > 0.75) escaped = true;
  }
  check('退场后离开活动区域', escaped, '鱼没有游出区域');
}

console.log('\n【惊吓行为】爆发式逃窜');
{
  const s = M.createState({ seed: 21 });
  for (let i = 0; i < 600; i++) M.step(s, 1 / 60, { upRef: [0, 1, 0], tuning: {} });
  const before = { x: s.pos.x, z: s.pos.z };
  const speedBefore = s.speed;
  M.startle(s, { x: before.x - 1.2, z: before.z });
  let t = 0, peakSpeed = 0, peakAt = 0, peakAnim = 0, maxAway = 0, outOfBounds = 0;
  for (let i = 0; i < 150; i++) {
    const out = M.step(s, 1 / 60, { upRef: [0, 1, 0], tuning: {} });
    t += 1 / 60;
    if (out.speed > peakSpeed) { peakSpeed = out.speed; peakAt = t; }
    peakAnim = Math.max(peakAnim, out.animSpeed);
    // 统计逃窜最初 1 秒内"远离威胁点"的最大位移（更晚鱼可能已冲到边界折返）
    if (t <= 1.0) maxAway = Math.max(maxAway, out.position[0] - before.x);
    if (Math.abs(out.position[0]) > s.region.x + 1e-6 ||
        Math.abs(out.position[2]) > s.region.z + 1e-6) outOfBounds++;
  }
  check('峰值速度达到爆发级（>1.5 单位/秒）', peakSpeed > 1.5,
    `峰值 ${peakSpeed.toFixed(2)}（受惊前 ${speedBefore.toFixed(2)}）`);
  check('起步够突然（峰值在 0.2 秒内）', peakAt > 0 && peakAt < 0.2,
    `峰值出现在 ${peakAt.toFixed(2)} 秒`);
  check('摆尾炸开（峰值 >3×）', peakAnim > 3.0, `峰值 ${peakAnim.toFixed(2)}×`);
  check('朝远离威胁点的方向逃窜', maxAway > 0.3, `1 秒内朝 +X 最远 ${maxAway.toFixed(2)}`);
  check('逃窜过程不越界', outOfBounds === 0, `${outOfBounds} 帧越界`);
}

console.log('\n【性格差异】不同种子应有不同速度基准');
{
  const a = M.createState({ seed: 1 });
  const b = M.createState({ seed: 999 });
  const different = Math.abs(a.personality.speedScale - b.personality.speedScale) > 0.02;
  check('两条鱼性格不同', different,
    `a=${a.personality.speedScale.toFixed(3)} b=${b.personality.speedScale.toFixed(3)}`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
