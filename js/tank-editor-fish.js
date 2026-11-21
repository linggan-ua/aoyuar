/**
 * 编辑器里的两条鲤鱼。
 *
 * 编辑器使用墙面坐标（不是 AR 的 marker-local 坐标）：
 *   X = 宽，Y = 高，Z = 从鱼缸后墙向外的纵深
 * 鱼头沿 X/Z 水平面，鱼背朝 +Y；鱼缸 cube 只是同一空间的可视化。
 * AR 渲染层会把这组尺寸映射到 marker-local 的 X/Y/Z。
 */
(function () {
  'use strict';

  function createFishSystem(THREE, scene, config, options) {
    options = options || {};
    var state = {
      THREE: THREE,
      scene: scene,
      config: config,
      modelScale: isFinite(Number(options.modelScale)) && Number(options.modelScale) >= 0 ? Number(options.modelScale) : 1,
      fish: [],
      loaded: 0,
      failed: 0,
      time: 0,
      visible: true
    };
    var tmpUp = new THREE.Vector3(0, 1, 0);
    var tmpForward = new THREE.Vector3();
    var tmpRight = new THREE.Vector3();
    var tmpBasis = new THREE.Matrix4();
    var tmpQuat = new THREE.Quaternion();
    var tmpBank = new THREE.Quaternion();
    var axisZ = new THREE.Vector3(0, 0, 1);
    if (!THREE.GLTFLoader) {
      console.error('AOYU_EDITOR_FISH_NO_GLTFLOADER');
      return {
        update: function () {},
        setConfig: function () {},
        setModelScale: function () {},
        getMotionScale: function () { return 1; },
        setVisible: function () {},
        state: state
      };
    }
    var loader = new THREE.GLTFLoader();
    console.log('AOYU_EDITOR_FISH_INIT');

    // 与 AR 主程序使用同一套运动尺度：鱼变大或鱼缸变宽/变深时，
    // 编辑器里的游速也一起放大，避免预览比现场慢半拍。
    function motionScale() {
      var w = Math.max(0.05, Number(state.config.width) || 0.80);
      var d = Math.max(0.05, Number(state.config.depth) || 0.50);
      var tankScale = Math.sqrt((w / 0.80) * (d / 0.50));
      var scale = Math.max(state.modelScale, tankScale);
      return scale > 0 && isFinite(scale) ? scale : 1;
    }

    function refreshMotion() {
      var motion = motionScale();
      for (var i = 0; i < state.fish.length; i++) {
        var fish = state.fish[i];
        if (!fish) continue;
        fish.root.scale.setScalar(state.modelScale);
        fish.targetSpeed = fish.baseSpeed * motion;
      }
    }

    function bounds(cfg) {
      var w = Math.max(0.1, Number(cfg.width) || 0.80);
      var h = Math.max(0.1, Number(cfg.height) || 0.56);
      var d = Math.max(0.1, Number(cfg.depth) || 0.50);
      return {
        x: Math.max(0.05, w / 2 - Math.min(0.07, w * 0.12)),
        y: Math.max(0.04, h / 2 - Math.min(0.07, h * 0.12)),
        zMin: Math.min(0.06, d * 0.12),
        zMax: Math.max(0.08, d - Math.min(0.06, d * 0.12)),
        depth: d
      };
    }

    function makeFishModel(gltf, index) {
      var root = new THREE.Group();
      var model = gltf.scene || gltf.scenes[0];
      model.rotation.y = Math.PI / 2;
      root.add(model);

      // 归一化到约 0.45 卡宽，和小程序/AR 里常见的鱼身大小接近。
      var box = new THREE.Box3().setFromObject(model);
      var size = box.getSize(new THREE.Vector3());
      var major = Math.max(size.x, size.z, 0.001);
      var scale = 0.45 / major;
      model.scale.setScalar(scale);
      model.updateMatrixWorld(true);

      var fish = {
        index: index,
        root: root,
        model: model,
        mixer: null,
        action: null,
        pos: new THREE.Vector3(),
        head: 0,
        baseSpeed: 0.24 + index * 0.015,
        speed: (0.24 + index * 0.015) * motionScale(),
        targetSpeed: (0.24 + index * 0.015) * motionScale(),
        target: new THREE.Vector3(),
        targetTime: 0,
        phase: Math.random() * Math.PI * 2,
        bank: 0,
        paused: false
      };

      if (gltf.animations && gltf.animations.length) {
        fish.mixer = new THREE.AnimationMixer(model);
        fish.action = fish.mixer.clipAction(gltf.animations[0]);
        fish.action.setLoop(THREE.LoopRepeat, Infinity);
        fish.action.play();
      }

      root.visible = state.visible;
      root.scale.setScalar(state.modelScale);
      scene.add(root);
      state.fish[index] = fish;
      state.loaded++;
      pickTarget(fish);
      placeInitial(fish);
      console.log('AOYU_EDITOR_FISH_READY', index, gltf.animations && gltf.animations[0] ? gltf.animations[0].name : 'no-clip');
    }

    function placeInitial(fish) {
      var b = bounds(state.config);
      var side = fish.index === 0 ? -1 : 1;
      fish.pos.set(side * b.x * 0.35, (Math.random() - 0.5) * b.y, b.depth * (fish.index === 0 ? 0.35 : 0.65));
      fish.root.position.copy(fish.pos);
      fish.head = fish.index === 0 ? 0.4 : Math.PI - 0.4;
      fish.target.set(-side * b.x * 0.55, 0, b.depth * (fish.index === 0 ? 0.7 : 0.3));
    }

    function pickTarget(fish) {
      var b = bounds(state.config);
      var other = state.fish[1 - fish.index];
      var side = fish.index === 0 ? -1 : 1;
      var x = side * b.x * (0.45 + Math.random() * 0.35);
      var z = b.depth * (0.25 + Math.random() * 0.5);
      if (other && other.pos && Math.hypot(x - other.pos.x, z - other.pos.z) < Math.min(0.3, b.x)) {
        x = -x;
      }
      fish.target.set(x, (Math.random() - 0.5) * b.y * 1.2, z);
      fish.targetTime = 4 + Math.random() * 4;
    }

    function updateFish(fish, dt) {
      var b = bounds(state.config);
      fish.targetTime -= dt;
      if (fish.targetTime <= 0) pickTarget(fish);

      fish.phase += dt * (1.2 + fish.speed * 2.5);
      fish.speed += (fish.targetSpeed - fish.speed) * Math.min(1, dt * 0.8);

      var dx = fish.target.x - fish.pos.x;
      var dz = fish.target.z - fish.pos.z;
      var dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        pickTarget(fish);
        dx = fish.target.x - fish.pos.x;
        dz = fish.target.z - fish.pos.z;
        dist = Math.hypot(dx, dz) || 0.001;
      }

      var want = Math.atan2(dx, dz);
      var diff = ((want - fish.head + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      var turnRadius = Math.max(0.16, Math.min(b.x, b.depth) * 0.38);
      var maxTurn = Math.max(0.2, fish.speed / turnRadius) * dt * 2.4;
      var turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
      fish.head += turn;
      fish.bank += (-(turn / Math.max(0.001, maxTurn)) * 0.10 - fish.bank) * Math.min(1, dt * 3);

      fish.pos.x += Math.sin(fish.head) * fish.speed * dt;
      fish.pos.z += Math.cos(fish.head) * fish.speed * dt;
      var bob = Math.sin(fish.phase) * Math.min(0.12, b.y * 0.45);
      fish.pos.y += ((fish.target.y + bob) - fish.pos.y) * Math.min(1, dt * 0.8);

      fish.pos.x = Math.max(-b.x, Math.min(b.x, fish.pos.x));
      fish.pos.z = Math.max(b.zMin, Math.min(b.zMax, fish.pos.z));
      fish.pos.y = Math.max(-b.y, Math.min(b.y, fish.pos.y));

      // 两条鱼保持一点间距，避免编辑器里看起来重叠。
      var other = state.fish[1 - fish.index];
      if (other) {
        var sx = fish.pos.x - other.pos.x;
        var sy = fish.pos.y - other.pos.y;
        var sz = fish.pos.z - other.pos.z;
        var d = Math.sqrt(sx * sx + sy * sy + sz * sz);
        var minGap = Math.min(0.55, Math.max(0.28, b.x * 0.75));
        if (d > 0.0001 && d < minGap) {
          fish.pos.x += sx / d * (minGap - d) * 0.45 * dt;
          fish.pos.y += sy / d * (minGap - d) * 0.45 * dt;
          fish.pos.z += sz / d * (minGap - d) * 0.45 * dt;
        }
      }

      fish.root.position.copy(fish.pos);
      tmpForward.set(Math.sin(fish.head), 0, Math.cos(fish.head)).normalize();
      tmpUp.set(0, 1, 0);
      tmpUp.addScaledVector(tmpForward, -tmpUp.dot(tmpForward)).normalize();
      tmpRight.crossVectors(tmpUp, tmpForward).normalize();
      tmpBasis.makeBasis(tmpRight, tmpUp, tmpForward);
      tmpQuat.setFromRotationMatrix(tmpBasis);
      tmpBank.setFromAxisAngle(axisZ, fish.bank);
      fish.root.quaternion.copy(tmpQuat).multiply(tmpBank);

      if (fish.mixer) fish.mixer.update(dt * (0.85 + fish.speed * 1.4));
    }

    function update(dt) {
      state.time += dt;
      for (var i = 0; i < state.fish.length; i++) {
        if (state.fish[i] && !state.fish[i].paused) updateFish(state.fish[i], dt);
      }
    }

    function setConfig(next) {
      state.config = next;
      refreshMotion();
      for (var i = 0; i < state.fish.length; i++) {
        var fish = state.fish[i];
        if (!fish) continue;
        var b = bounds(next);
        fish.pos.x = Math.max(-b.x, Math.min(b.x, fish.pos.x));
        fish.pos.y = Math.max(-b.y, Math.min(b.y, fish.pos.y));
        fish.pos.z = Math.max(b.zMin, Math.min(b.zMax, fish.pos.z));
        pickTarget(fish);
      }
    }

    function setModelScale(scale) {
      var n = Number(scale);
      if (!(n > 0) || !isFinite(n)) return;
      state.modelScale = n;
      refreshMotion();
      for (var i = 0; i < state.fish.length; i++) {
        var fish = state.fish[i];
        if (fish) pickTarget(fish);
      }
    }

    function setVisible(visible) {
      state.visible = !!visible;
      for (var i = 0; i < state.fish.length; i++) {
        if (state.fish[i]) state.fish[i].root.visible = visible;
      }
    }

    // 两条独立加载，避免 SkinnedMesh.clone() 共享骨架导致两条鱼同步抖动。
    loader.load('../assets/models/koi_red.glb', function (gltf) { makeFishModel(gltf, 0); }, function (xhr) { if (xhr && xhr.total && xhr.loaded === xhr.total) console.log('AOYU_EDITOR_FISH_DOWNLOAD 0'); }, function (error) {
      state.failed++;
      console.error('AOYU_EDITOR_FISH_ERROR', 0, error);
    });
    loader.load('../assets/models/koi_red.glb', function (gltf) { makeFishModel(gltf, 1); }, function (xhr) { if (xhr && xhr.total && xhr.loaded === xhr.total) console.log('AOYU_EDITOR_FISH_DOWNLOAD 1'); }, function (error) {
      state.failed++;
      console.error('AOYU_EDITOR_FISH_ERROR', 1, error);
    });

    return {
      update: update,
      setConfig: setConfig,
      setModelScale: setModelScale,
      getMotionScale: motionScale,
      setVisible: setVisible,
      state: state
    };
  }

  window.AOYU_EDITOR_FISH = { create: createFishSystem };
})();
