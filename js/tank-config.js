/**
 * 鱼缸尺寸共享配置
 *
 * 尺寸单位 = 鲤鱼码卡宽。默认值对应 AR 里当前调好的基准鱼缸；
 * 编辑器保存后，AR 页面通过 storage 事件实时读取。
 */
(function () {
  'use strict';

  var KEY = 'aoyu-tank-v1';
  var DEFAULTS = { width: 0.80, height: 0.56, depth: 0.50 };
  // 不再设置任何有限业务上限；只防止非有限值和非正尺寸把几何计算弄坏。
  var LIMITS = {
    width: [Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    height: [Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    depth: [Number.MIN_VALUE, Number.POSITIVE_INFINITY]
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function round(value) {
    // 保留极小尺寸，同时不把大尺寸截断到两位小数。
    return Number.isFinite(value) ? Number(value.toPrecision(12)) : value;
  }

  function normalize(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    return {
      width: round(clamp(numberOr(src.width, DEFAULTS.width), LIMITS.width[0], LIMITS.width[1])),
      height: round(clamp(numberOr(src.height, DEFAULTS.height), LIMITS.height[0], LIMITS.height[1])),
      depth: round(clamp(numberOr(src.depth, DEFAULTS.depth), LIMITS.depth[0], LIMITS.depth[1]))
    };
  }

  function eventDetail(config) {
    return {
      width: config.width,
      height: config.height,
      depth: config.depth,
      custom: hasSaved()
    };
  }

  function emit(config) {
    var detail = eventDetail(config);
    try {
      window.dispatchEvent(new CustomEvent('aoyu-tank-change', { detail: detail }));
    } catch (error) {
      /* 老 WebView 不支持 CustomEvent 构造时就算了，storage 事件仍会工作 */
    }
  }

  function hasSaved() {
    try {
      return localStorage.getItem(KEY) != null;
    } catch (error) {
      return false;
    }
  }

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (error) {
      raw = null;
    }
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (error) { parsed = null; }
    }
    var config = normalize(parsed);
    config.custom = !!raw;
    return config;
  }

  function save(next) {
    var config = normalize(next);
    var payload = {
      version: 1,
      width: config.width,
      height: config.height,
      depth: config.depth,
      updatedAt: Date.now()
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch (error) {
      /* 隐私模式写不了时，编辑器和 AR 当前页面仍可各自使用屏幕上的值 */
    }
    emit(config);
    return config;
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (error) { /* ignore */ }
    var config = load();
    emit(config);
    return config;
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') return function () {};
    function notify() { callback(load()); }
    function onStorage(event) {
      if (!event.key || event.key === KEY) notify();
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('aoyu-tank-change', notify);
    return function () {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('aoyu-tank-change', notify);
    };
  }

  window.AOYU_TANK = {
    KEY: KEY,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    normalize: normalize,
    load: load,
    save: save,
    clear: clear,
    subscribe: subscribe
  };
})();
