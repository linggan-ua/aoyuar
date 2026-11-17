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
    { label: 'BACK',   sub: '+Z', color: '#5d8cff', position: [0, 0,  0.61] },
    { label: 'FRONT',  sub: '-Z', color: '#8aabff', position: [0, 0, -0.61] }
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

  function createMesh(THREE, opacity) {
    var alpha = opacity == null ? 0.88 : opacity;
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

    for (var i = 0; i < FACE_DEFS.length; i++) {
      var def = FACE_DEFS[i];
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

  window.AOYU_TANK_CUBE = {
    FACE_DEFS: FACE_DEFS.slice(),
    createMesh: createMesh
  };

  if (!window.AFRAME || !window.AFRAME.registerComponent) return;

  AFRAME.registerComponent('tank-cube', {
    schema: {
      opacity: { type: 'number', default: 0.88 }
    },
    init: function () {
      var group = createMesh(AFRAME.THREE, this.data.opacity);
      this.el.setObject3D('mesh', group);
      this.mesh = group;
    },
    remove: function () {
      if (!this.mesh) return;
      disposeObject(this.mesh);
      this.mesh = null;
    }
  });
})();
