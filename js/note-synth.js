/**
 * 点击鱼的五声音阶铃声（合成器版）
 *
 * 参数就是 tools/bell-timbre-lab.html 里调定的那一版（用户定稿），
 * 算法与调音台完全一致：正弦基频 + 两个分层分音 + 多路递归延迟混响 + 全通扩散 + 一阶低通。
 * 这样做的好处：不依赖 mp3 文件（现场网络/缓存出问题也能出声），第一次点击前已经预渲染好，点了立刻响。
 *
 * 用法：AOYU_NOTE_SYNTH.init(audioCtx); AOYU_NOTE_SYNTH.prewarm(); AOYU_NOTE_SYNTH.play(0..4);
 */
(function () {
  'use strict';

  // ===== 定稿参数（来自调音台导出的 JSON）=====
  var PRESET = {
    root: 'C', octave: 6,
    attack: 0.002, attackCurve: 2,
    bloomAmount: 0.014, bloomTau: 0.04,
    fastPart: 1, fastTau: 0.27, slowTau: 1,
    duration: 1,
    detune: 0, dry: 0.9,
    reverb: 0.85, preDelay: 0.03,
    reverbTail: 1.35, reverbDensity: 3,
    reverbDecay: 0.35, reverbTone: 0.7,
    reverbWidth: 1.06, reverbSpread: 4,
    peak: 0.2,
    p2mult: 1, p2amp: 2,
    p3mult: 1, p3amp: 2
  };

  // 五声音阶（宫商角徵羽）C6 D6 E6 G6 A6 —— 和 CONFIG.notes 的顺序一一对应
  var SCALE = [1046.50, 1174.66, 1318.51, 1567.98, 1760.00];
  var RELEASE = 0.35;          // 调音台里固定用 0.35 秒收尾（导出的 JSON 不含这一项）
  var SR = 44100;

  var ctx = null;
  var cache = [];

  function render(freq) {
    var P = PRESET;
    var n = Math.floor(SR * P.duration);
    var attack = Math.max(1, Math.floor(SR * P.attack));
    var release = Math.max(1, Math.floor(SR * RELEASE));
    var L = new Float32Array(n), R = new Float32Array(n);
    var pl = 0, pr = 0, i, t;
    for (i = 0; i < n; i++) {
      t = i / SR;
      var decay = P.fastPart * Math.exp(-t / P.fastTau) + (1 - P.fastPart) * Math.exp(-t / P.slowTau);
      var env = 1;
      if (i < attack) env = Math.pow(i / attack, P.attackCurve);
      if (i > n - release) env *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / release);
      var r = t / P.bloomTau;
      var bloom = 1 + P.bloomAmount * r * Math.exp(1 - r);
      pl += 2 * Math.PI * freq * (1 - P.detune) * bloom / SR;
      pr += 2 * Math.PI * freq * (1 + P.detune) * bloom / SR;
      var a = decay * env;
      var vl = Math.sin(pl) * a, vr = Math.sin(pr) * a;
      // 分音也必须乘同一个总包络，否则一上来就是满幅（爆音）
      if (P.p2amp > 0) {
        var a2 = P.p2amp * Math.exp(-t / P.fastTau) * env;
        vl += a2 * Math.sin(pl * P.p2mult);
        vr += a2 * Math.sin(pr * P.p2mult);
      }
      if (P.p3amp > 0) {
        var a3 = P.p3amp * Math.exp(-t / P.slowTau) * env;
        vl += a3 * Math.sin(pl * P.p3mult);
        vr += a3 * Math.sin(pr * P.p3mult);
      }
      L[i] = vl; R[i] = vr;
    }

    if (P.reverb > 0 && (P.dry + P.reverb) > 0) {
      var wetL = new Float32Array(n), wetR = new Float32Array(n);
      var taps = Math.max(2, Math.round(P.reverbDensity));
      var base = (0.008 + 0.014 * P.reverbTail) * P.reverbSpread;
      for (var k = 0; k < taps; k++) {
        var d = Math.max(1, Math.floor(base * (1 + k * 0.41) * SR));
        var g = P.reverbDecay * (0.85 + 0.3 * ((k * 7) % 5) / 4);
        for (i = d; i < n; i++) {
          wetL[i] += (L[i - d] + wetL[i - d]) * g;
          wetR[i] += (R[i - d] + wetR[i - d]) * g;
        }
      }
      // 全通扩散：把离散回声抹成连续尾巴（幅频响应平，不会让正弦抖）
      var DIFFUSE = [0.0043, 0.0067, 0.0091, 0.0127, 0.0173, 0.0229, 0.0281];
      for (k = 0; k < DIFFUSE.length; k++) {
        d = Math.max(1, Math.floor(DIFFUSE[k] * SR));
        g = 0.62 - k * 0.04;
        var tl = Float32Array.from(wetL), tr = Float32Array.from(wetR);
        for (i = d; i < n; i++) {
          wetL[i] = -g * tl[i] + tl[i - d] + g * wetL[i - d];
          wetR[i] = -g * tr[i] + tr[i - d] + g * wetR[i - d];
        }
      }
      var cut = 300 + 12000 * P.reverbTone;
      var alpha = 1 - Math.exp(-2 * Math.PI * cut / SR);
      var sl = 0, sr2 = 0;
      var pre = Math.floor(P.preDelay * SR);
      var norm = 1 / Math.sqrt(taps);
      for (i = 0; i < n; i++) {
        sl += alpha * (wetL[i] - sl);
        sr2 += alpha * (wetR[i] - sr2);
        var wl = sl * norm, wr = sr2 * norm;
        var mid = (wl + wr) / 2, side = (wl - wr) / 2 * P.reverbWidth;
        wl = mid + side; wr = mid - side;
        var idx = i + pre;
        if (idx < n) {
          L[idx] = L[idx] * P.dry + wl * P.reverb;
          R[idx] = R[idx] * P.dry + wr * P.reverb;
        }
      }
    } else {
      for (i = 0; i < n; i++) { L[i] *= P.dry; R[i] *= P.dry; }
    }

    var pk = 0;
    for (i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    var scale = pk > 0 ? P.peak / pk : 1;
    var buf = ctx.createBuffer(2, n, SR);
    var cl = buf.getChannelData(0), cr = buf.getChannelData(1);
    for (i = 0; i < n; i++) { cl[i] = L[i] * scale; cr[i] = R[i] * scale; }
    return buf;
  }

  function ensure(index) {
    if (!ctx) return null;
    if (!cache[index]) cache[index] = render(SCALE[index]);
    return cache[index];
  }

  window.AOYU_NOTE_SYNTH = {
    PRESET: PRESET,
    /** 用主程序已有的 AudioContext（顺便让它的 resume 一起管） */
    init: function (audioCtx) {
      ctx = audioCtx || ctx;
      cache = [];
      return !!ctx;
    },
    /** 预渲染五个音：点下去立刻出声，没有合成等待 */
    prewarm: function () {
      if (!ctx) return 0;
      var ok = 0;
      for (var i = 0; i < SCALE.length; i++) {
        try { if (ensure(i)) ok++; } catch (e) { console.error('AOYU_NOTE_SYNTH_RENDER_ERROR', i, e); }
      }
      console.log('AOYU_NOTE_SYNTH_READY', ok + '/' + SCALE.length, 'duration=' + PRESET.duration + 's');
      return ok;
    },
    ready: function () { return !!(ctx && cache[0]); },
    play: function (index) {
      if (!ctx) return false;
      if (index < 0 || index >= SCALE.length) return false;
      var buf = ensure(index);
      if (!buf) return false;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      return true;
    },
    /** 调试用：每个音的峰值，确认不是静音 */
    peaks: function () {
      return SCALE.map(function (f, i) {
        var buf = cache[i];
        if (!buf) return null;
        var d = buf.getChannelData(0), pk = 0;
        for (var k = 0; k < d.length; k++) pk = Math.max(pk, Math.abs(d[k]));
        return +pk.toFixed(3);
      });
    }
  };
})();
