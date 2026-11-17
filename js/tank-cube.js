/**
 * 官方 AR.js cubemap 坐标的鱼缸 cube。
 *
 * 不再用一块大面积透明贴图盖住鱼，而是：
 *   - 透明的 unit cube 体积
 *   - 六面各一个小方向铭牌：RIGHT/LEFT/TOP/BOTTOM/BACK/FRONT
 *     （对应官方 cube 的 +X/-X/+Y/-Y/+Z/-Z）
 *   - 微弱的 cube 轮廓线
 *
 * marker / cube 局部坐标轴：
 *   X = 鱼缸宽度
 *   Y = 鱼缸高度（从鲤鱼码平面向上）
 *   Z = 鱼缸纵深
 */
(function () {
  'use strict';

  var FACE_DEFS = [
    { label: 'RIGHT',  sub: '+X', color: '#ff4b55', position: [ 0.61, 0, 0] },
    { label: 'LEFT',   sub: '-X', color: '#ff858d', position: [-0.61, 0, 0] },
    { label: 'TOP',    sub: '+Y', color: '#6ee77e', position: [0,  0.61, 0] },
    { label: 'BOTTOM', sub: '-Y', color: '#2eaa64', position: [0, -0.61, 0] },
    { label: 'FRONT',  sub: '+Z', color: '#5d8cff', position: [0, 0,  0.61] },
    { label: 'BACK',   sub: '-Z', color: '#8aabff', position: [0, 0, -0.61] }
  ];

  // 直接使用 AR.js marker-local 坐标时，marker 的 Y 是卡面法线，
  // Z 是卡面内的上下轴；方向文本要跟着物理朝向换名。
  var MARKER_FACE_DEFS = [
    { label: 'RIGHT',  sub: '+X', color: '#ff4b55', position: [ 0.61, 0, 0] },
    { label: 'LEFT',   sub: '-X', color: '#ff858d', position: [-0.61, 0, 0] },
    { label: 'FRONT',  sub: '+Y', color: '#5d8cff', position: [0,  0.61, 0] },
    { label: 'BACK',   sub: '-Y', color: '#8aabff', position: [0, -0.61, 0] },
    { label: 'BOTTOM', sub: '+Z', color: '#2eaa64', position: [0, 0,  0.61] },
    { label: 'TOP',    sub: '-Z', color: '#6ee77e', position: [0, 0, -0.61] }
  ];

  function makeLabelTexture(THREE, def) {
    var canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 144;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var x = 3, y = 4, w = canvas.width - 6, h = canvas.height - 8, r = 22;
    ctx.fillStyle = 'rgba(12, 17, 23, .88)';
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f5f9ff';
    ctx.font = '700 43px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(def.label, canvas.width / 2, 60);
    ctx.fillStyle = def.color;
    ctx.font = '700 31px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(def.sub, canvas.width / 2, 109);

    var texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.needsUpdate = true;
    return texture;
  }

  function createMesh(THREE, opacity, axisMode) {
    var alpha = opacity == null ? 0.88 : opacity;
    var faceDefs = axisMode === 'marker' ? MARKER_FACE_DEFS : FACE_DEFS;
    var group = new THREE.Group();
    var box = new THREE.BoxGeometry(1, 1, 1);
    var fill = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
      color: 0x61d2ff,
      transparent: true,
      opacity: 0.05 * (alpha / 0.88),
      side: THREE.DoubleSide,
      depthWrite: false
    }));
    group.add(fill);

    var edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({
        color: 0x7fe8ff,
        transparent: true,
        opacity: 0.82 * (alpha / 0.88),
        depthWrite: false
      })
    );
    group.add(edges);

    for (var i = 0; i < faceDefs.length; i++) {
      var def = faceDefs[i];
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeLabelTexture(THREE, def),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false
      }));
      sprite.position.set(def.position[0], def.position[1], def.position[2]);
      sprite.scale.set(0.16, 0.06, 1);
      sprite.userData.aoyuFaceLabel = def.label;
      sprite.userData.faceNormal = new THREE.Vector3(
        def.position[0], def.position[1], def.position[2]
      ).normalize();
      group.add(sprite);
    }

    group.userData.aoyuTankCube = true;
    return group;
  }

  function disposeObject(object) {
    if (!object) return;
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      var mats = Array.isArray(object.material) ? object.material : [object.material];
      for (var i = 0; i < mats.length; i++) {
        if (mats[i].map) mats[i].map.dispose();
        mats[i].dispose();
      }
    }
    for (var j = 0; j < object.children.length; j++) disposeObject(object.children[j]);
  }

  function updateFaceLabels(group, camera) {
    if (!group || !camera) return;
    group.updateWorldMatrix(true, false);
    var center = group.userData._labelCenter || (group.userData._labelCenter = new THREE.Vector3());
    var cam = group.userData._labelCam || (group.userData._labelCam = new THREE.Vector3());
    var normal = group.userData._labelNormal || (group.userData._labelNormal = new THREE.Vector3());
    group.getWorldPosition(center);
    camera.getWorldPosition(cam);
    var toCamera = cam.sub(center).normalize();
    for (var i = 0; i < group.children.length; i++) {
      var child = group.children[i];
      if (!child.userData || !child.userData.faceNormal) continue;
      normal.copy(child.userData.faceNormal).transformDirection(group.matrixWorld).normalize();
      child.visible = normal.dot(toCamera) > 0.04;
    }
  }

  window.AOYU_TANK_CUBE = {
    FACE_DEFS: FACE_DEFS.slice(),
    MARKER_FACE_DEFS: MARKER_FACE_DEFS.slice(),
    createMesh: createMesh,
    updateFaceLabels: updateFaceLabels
  };

  if (!window.AFRAME || !window.AFRAME.registerComponent) return;

  AFRAME.registerComponent('tank-cube', {
    schema: {
      opacity: { type: 'number', default: 0.88 },
      axisMode: { type: 'string', default: 'editor' }
    },
    init: function () {
      var group = createMesh(AFRAME.THREE, this.data.opacity, this.data.axisMode);
      this.el.setObject3D('mesh', group);
      this.mesh = group;
    },
    tick: function () {
      var camera = this.el.sceneEl && this.el.sceneEl.camera;
      updateFaceLabels(this.mesh, camera);
    },
    remove: function () {
      if (!this.mesh) return;
      disposeObject(this.mesh);
      this.mesh = null;
    }
  });
})();
