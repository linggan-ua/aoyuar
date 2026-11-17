/**
 * 官方 AR.js cubemap 同款六面材质 cube。
 *
 * 唯一使用的几何是标准 BoxGeometry(1,1,1)，材质顺序严格按：
 *   +X, -X, +Y, -Y, +Z, -Z
 * 对应官方的 xpos/xneg/ypos/yneg/zpos/zneg 六张图。
 *
 * 白底在 shader 里丢弃，只保留方向文字和彩色边框，鱼可以从 cube 内部看见。
 */
(function () {
  'use strict';

  var FACE_FILES = ['xpos', 'xneg', 'ypos', 'yneg', 'zpos', 'zneg'];

  function makeMaterials(THREE, base, opacity) {
    var loader = new THREE.TextureLoader();
    var materials = [];
    for (var i = 0; i < FACE_FILES.length; i++) {
      var texture = loader.load((base || '') + FACE_FILES[i] + '.png', function (loaded) {
        loaded.encoding = THREE.sRGBEncoding;
      });
      materials.push(new THREE.ShaderMaterial({
        uniforms: {
          faceMap: { value: texture },
          faceOpacity: { value: opacity == null ? 0.9 : opacity }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main() {',
          '  vUv = uv;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform sampler2D faceMap;',
          'uniform float faceOpacity;',
          'varying vec2 vUv;',
          'void main() {',
          '  vec4 texel = texture2D(faceMap, vUv);',
          '  if (texel.r > 0.94 && texel.g > 0.94 && texel.b > 0.94) discard;',
          '  gl_FragColor = vec4(texel.rgb, faceOpacity * texel.a);',
          '}'
        ].join('\n'),
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide
      }));
    }
    return materials;
  }

  function createMesh(THREE, base, opacity) {
    var mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      makeMaterials(THREE, base, opacity)
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
        if (mats[i].uniforms && mats[i].uniforms.faceMap && mats[i].uniforms.faceMap.value) {
          mats[i].uniforms.faceMap.value.dispose();
        }
        mats[i].dispose();
      }
    }
  }

  window.AOYU_TANK_CUBE = {
    FACE_FILES: FACE_FILES.slice(),
    createMesh: createMesh,
    updateFaceLabels: function () {}
  };

  if (!window.AFRAME || !window.AFRAME.registerComponent) return;

  AFRAME.registerComponent('tank-cube', {
    dependencies: ['geometry'],
    schema: {
      base: { type: 'string', default: '' },
      opacity: { type: 'number', default: 0.9 }
    },
    init: function () {
      var self = this;
      this.applyMaterials = function () {
        var mesh = self.el.getObject3D('mesh');
        if (!mesh || !mesh.geometry || !mesh.geometry.groups || mesh.geometry.groups.length < 6) return;
        if (self.mesh && self.mesh.material === mesh.material) return;
        var mats = makeMaterials(AFRAME.THREE, self.data.base, self.data.opacity);
        mesh.material = mats;
        self.mesh = mesh;
        self.materials = mats;
      };
      this.applyMaterials();
      this.el.addEventListener('loaded', this.applyMaterials);
      setTimeout(this.applyMaterials, 0);
    },
    remove: function () {
      if (!this.materials) return;
      for (var i = 0; i < this.materials.length; i++) {
        var mat = this.materials[i];
        if (mat.uniforms && mat.uniforms.faceMap && mat.uniforms.faceMap.value) mat.uniforms.faceMap.value.dispose();
        mat.dispose();
      }
      this.materials = null;
    }
  });
})();
