/**
 * 编辑器里的两条鲤鱼。
 *
 * 和 AR 完全相同的 marker-local 坐标：
 *   X = 宽，Y = 纵深，Z = 卡面内高度
 * 鱼头沿卡片 X/Z 航向，鱼背朝 -Z，Y 方向是鱼缸纵深。
 */
(function () {
  'use strict';

  function createFishSystem(THREE, scene, config) {
    var state = {
      THREE: THREE,
      scene: scene,
      config: config,
      fish: [],
      loaded: 0,
      failed: 0,
      time: 0,
      visible: true
    };
    var tmpUp = new THREE.Vector3(0, 0, -1);
    var tmpForward = new THREE.Vector3();
    var tmpRight = new THREE.Vector3();
    var tmpBasis = new THREE.Matrix4();
    var tmpQuat = new THREE.Quaternion();
    var tmpBank = new THREE.Quaternion();
    var axisZ = new THREE.Vector3(0, 0, 1);
    if (!THREE.GLTFLoader) {
      console.error('AOYU_EDITOR_FISH_NO_GLTFLOADER');
      return { update: function () {}, setConfig: function () {}, setVisible: function () {}, state: state };
    }
    var loader = new THREE.GLTFLoader();
    console.log('AOYU_EDITOR_FISH_INIT');

    function bounds(cfg) {
      var w = Math.max(0.1, Number(cfg.width) || 0.80);
      var h = Math.max(0.1, Number(cfg.height) || 0.56);
      var d = Math.max(0.1, Number(cfg.depth) || 0.50);
      var xHalf = Math.max(0.05, w / 2 - Math.min(0.07, w * 0.12));
      var zHalf = Math.max(0.04, h / 2 - Math.min(0.07, h * 0.12));
      var yMin = Math.min(0.04, d * 0.12);
      var yMax = Math.max(yMin + 0.04, d - Math.min(0.04, d * 0.12));
      return { x: xHalf, z: zHalf, yMin: yMin, yMax: yMax, depth: d };
    }

    function makeFishModel(gltf, index) {
      var root = new THREE.Group();
      var model = gltf.scene || gltf.scenes[0];
      model.rotation.y = Math.PI / 2;
      root.add(model);

      // 归一化到约 0.45 卡宽，和 AR 中鱼身大小接近。
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
        speed: 0.24 + index * 0.015,
        targetSpeed: 0.24 + index * 0.015,
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
      fish.pos.set(
        side * b.x * 0.35,
        b.depth * (fish.index === 0 ? 0.35 : 0.65),
        (Math.random() - 0.5) * b.z
      );
      fish.root.position.copy(fish.pos);
      fish.head = fish.index === 0 ? 0.4 : Math.PI - 0.4;
      fish.target.set(
        -side * b.x * 0.55,
        b.depth * (fish.index === 0 ? 0.7 : 0.3),
        (Math.random() - 0.5) * b.z
      );
    }

    function pickTarget(fish) {
      var b = bounds(state.config);
      var side = fish.index === 0 ? -1 : 1;
      var x = side * b.x * (0.45 + Math.random() * 0.35);
      var z = (Math.random() - 0.5) * b.z * 1.35;
      var y = b.depth * (0.25 + Math.random() * 0.5);
      fish.target.set(x, y, z);
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
      var turnRadius = Math.max(0.16, Math.min(b.x, b.z) * 0.6);
      var maxTurn = Math.max(0.2, fish.speed / turnRadius) * dt * 2.4;
      var turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
      fish.head += turn;
      fish.bank += (-(turn / Math.max(0.001, maxTurn)) * 0.10 - fish.bank) * Math.min(1, dt * 3);

      fish.pos.x += Math.sin(fish.head) * fish.speed * dt;
      fish.pos.z += Math.cos(fish.head) * fish.speed * dt;
      var bob = Math.sin(fish.phase) * Math.min(0.055, b.depth * 0.15);
      fish.pos.y += ((fish.target.y + bob) - fish.pos.y) * Math.min(1, dt * 0.8);

      fish.pos.x = Math.max(-b.x, Math.min(b.x, fish.pos.x));
      fish.pos.z = Math.max(-b.z, Math.min(b.z, fish.pos.z));
      fish.pos.y = Math.max(b.yMin, Math.min(b.yMax, fish.pos.y));

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
      tmpUp.set(0, 0, -1);
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
      for (var i = 0; i < state.fish.length; i++) {
        var fish = state.fish[i];
        if (!fish) continue;
        var b = bounds(next);
        fish.pos.x = Math.max(-b.x, Math.min(b.x, fish.pos.x));
        fish.pos.z = Math.max(-b.z, Math.min(b.z, fish.pos.z));
        fish.pos.y = Math.max(b.yMin, Math.min(b.yMax, fish.pos.y));
        pickTarget(fish);
      }
    }

    function setVisible(visible) {
      state.visible = !!visible;
      for (var i = 0; i < state.fish.length; i++) {
        if (state.fish[i]) state.fish[i].root.visible = visible;
      }
    }

    loader.load('../assets/models/koi_red.glb', function (gltf) { makeFishModel(gltf, 0); }, function (xhr) { if (xhr && xhr.total && xhr.loaded === xhr.total) console.log('AOYU_EDITOR_FISH_DOWNLOAD 0'); }, function (error) {
      state.failed++;
      console.error('AOYU_EDITOR_FISH_ERROR', 0, error);
    });
    loader.load('../assets/models/koi_red.glb', function (gltf) { makeFishModel(gltf, 1); }, function (xhr) { if (xhr && xhr.total && xhr.loaded === xhr.total) console.log('AOYU_EDITOR_FISH_DOWNLOAD 1'); }, function (error) {
      state.failed++;
      console.error('AOYU_EDITOR_FISH_ERROR', 1, error);
    });

    return { update: update, setConfig: setConfig, setVisible: setVisible, state: state };
  }

  window.AOYU_EDITOR_FISH = { create: createFishSystem };
})();
