/**
 * 与官方 AR.js cubemap demo 同构的方向 cube。
 *
 * 这里只创建一个标准 BoxGeometry mesh：
 *   +X / -X / +Y / -Y / +Z / -Z
 * 六个面各有一张方向标签材质，不再额外套 group、sprite 或自定义旋转。
 *
 * editor 模式：X=宽，Y=高，Z=纵深
 * marker 模式：X=宽，Y=纵深，Z=卡面内高度
 */
(function () {
  'use strict';

  var EDITOR_FACE_DEFS = [
    { label: 'RIGHT',  sub: '+X', color: '#ff4b55' },
    { label: 'LEFT',   sub: '-X', color: '#ff858d' },
    { label: 'TOP',    sub: '+Y', color: '#6ee77e' },
    { label: 'BOTTOM', sub: '-Y', color: '#2eaa64' },
    { label: 'FRONT',  sub: '+Z', color: '#5d8cff' },
    { label: 'BACK',   sub: '-Z', color: '#8aabff' }
  ];

  var MARKER_FACE_DEFS = [
    { label: 'RIGHT',  sub: '+X', color: '#ff4b55' },
    { label: 'LEFT',   sub: '-X', color: '#ff858d' },
    { label: 'FRONT',  sub: '+Y', color: '#5d8cff' },
    { label: 'BACK',   sub: '-Y', color: '#8aabff' },
    { label: 'BOTTOM', sub: '+Z', color: '#2eaa64' },
    { label: 'TOP',    sub: '-Z', color: '#6ee77e' }
  ];

  function makeFaceTexture(THREE, def) {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 512);

    // 透明底 + 彩色边框 + 小方向铭牌；六面合起来就是 cube 的方向。
    ctx.strokeStyle = def.color;
    ctx.globalAlpha = 0.92;
    ctx.lineWidth = 9;
    ctx.strokeRect(18, 18, 476, 476);
    ctx.globalAlpha = 1;

    var x = 92, y = 206, w = 328, h = 100, r = 18;
    ctx.fillStyle = 'rgba(12, 17, 23, .86)';
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 4;
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
    ctx.fillStyle = '#f4f8ff';
    ctx.font = '700 46px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(def.label, 256, 244);
    ctx.fillStyle = def.color;
    ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(def.sub, 256, 282);

    var texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.needsUpdate = true;
    return texture;
  }

  function makeMaterials(THREE, defs, opacity) {
    var alpha = opacity == null ? 0.92 : opacity;
    var materials = [];
    for (var i = 0; i < defs.length; i++) {
      materials.push(new THREE.MeshBasicMaterial({
        map: makeFaceTexture(THREE, defs[i]),
        transparent: true,
        opacity: alpha,
        side: THREE.FrontSide,
        depthWrite: false
      }));
    }
    return materials;
  }

  function createMesh(THREE, opacity, axisMode) {
    var defs = axisMode === 'marker' ? MARKER_FACE_DEFS : EDITOR_FACE_DEFS;
    var mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      makeMaterials(THREE, defs, opacity)
    );
    mesh.userData.aoyuTankCube = true;
    return mesh;
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
  }

  window.AOYU_TANK_CUBE = {
    EDITOR_FACE_DEFS: EDITOR_FACE_DEFS.slice(),
    MARKER_FACE_DEFS: MARKER_FACE_DEFS.slice(),
    createMesh: createMesh,
    // 保留给编辑器动画循环的 API；标签现在固定在 box 面上，不需要每帧 billboard 更新。
    updateFaceLabels: function () {}
  };

  if (!window.AFRAME || !window.AFRAME.registerComponent) return;

  AFRAME.registerComponent('tank-cube', {
    dependencies: ['geometry'],
    schema: {
      opacity: { type: 'number', default: 0.92 },
      axisMode: { type: 'string', default: 'editor' }
    },
    init: function () {
      var self = this;
      this.applyMaterials = function () {
        var mesh = self.el.getObject3D('mesh');
        if (!mesh || !mesh.geometry || !mesh.geometry.groups || mesh.geometry.groups.length < 6) return;
        if (self.mesh && self.mesh.material === mesh.material) return;
        var defs = self.data.axisMode === 'marker' ? MARKER_FACE_DEFS : EDITOR_FACE_DEFS;
        var mats = makeMaterials(AFRAME.THREE, defs, self.data.opacity);
        mesh.material = mats;
        self.mesh = mesh;
        self.materials = mats;
      };
      // a-box 的 geometry 可能在组件之后才挂上；两个时机都试一次。
      this.applyMaterials();
      this.el.addEventListener('loaded', this.applyMaterials);
      setTimeout(this.applyMaterials, 0);
    },
    remove: function () {
      if (!this.materials) return;
      for (var i = 0; i < this.materials.length; i++) {
        if (this.materials[i].map) this.materials[i].map.dispose();
        this.materials[i].dispose();
      }
      this.materials = null;
    }
  });

})();
