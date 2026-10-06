/**
 * 内置检测页：在真实内核里读取一遍所有关键信号，回传给主进程。
 *
 * 用 file:// 而不是 setContent / http://，因为 navigator.userAgentData（Client Hints）
 * 只在安全上下文里暴露 —— 用 file:// 才能把最常见的穿帮点也测出来。
 * 脚本内刻意不使用模板字符串与反引号，避免与 TS 的 template literal 冲突。
 */
export const PROBE_FILENAME = 'fpb-detect-probe.html'

export const PROBE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>指纹检测探针</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0f14;color:#e2e8f0;padding:24px}h2{margin:0 0 8px}code{color:#7dd3fc}</style>
</head>
<body>
<h2>指纹检测探针</h2>
<p>正在采集当前环境的真实信号，请稍候…</p>
<script>
(function () {
  function hashBytes(arr) {
    var h = 7;
    for (var i = 0; i < arr.length; i++) h = (h * 31 + (arr[i] & 255)) >>> 0;
    return h;
  }
  function safe(fn) {
    try { return fn(); } catch (e) { return { __error: String(e && e.message ? e.message : e) }; }
  }
  async function safeAsync(fn) {
    try { return await fn(); } catch (e) { return { __error: String(e && e.message ? e.message : e) }; }
  }

  // 信号在「被调用时」才读取，而不是页面加载时：
  // UA / 时区 / locale 是 CDP 异步覆盖的，加载瞬间可能还没落地。
  window.__fpCollect = function () {
    return (async function () {
    var out = { collectedAt: Date.now(), href: location.href, title: document.title };
    // 有没有真实窗口：headless 下 outer == inner 是内核自身行为，
    // 不能按「桌面 Chrome 有标签栏/地址栏」的标准去判它不一致。
    out.headed = /[?&]headed=1/.test(location.search);

    out.webdriver = navigator.webdriver;
    out.userAgent = navigator.userAgent;
    out.appVersion = navigator.appVersion;
    out.platform = navigator.platform;
    out.vendor = navigator.vendor;
    out.languages = Array.prototype.slice.call(navigator.languages || []);
    out.language = navigator.language;
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = navigator.deviceMemory;
    out.maxTouchPoints = navigator.maxTouchPoints;
    out.doNotTrack = navigator.doNotTrack;
    out.gpc = (typeof navigator.globalPrivacyControl === 'undefined') ? null : navigator.globalPrivacyControl;
    out.plugins = {
      length: (navigator.plugins || []).length,
      names: Array.prototype.slice.call(navigator.plugins || []).map(function (p) { return p.name; }).slice(0, 6)
    };
    out.mimeTypes = (navigator.mimeTypes || []).length;
    out.touchEvents = ('ontouchstart' in window);
    out.pointerFine = window.matchMedia ? window.matchMedia('(pointer: fine)').matches : null;

    out.toStringNative = safe(function () {
      var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
      if (!d || !d.get) return null;
      return /native code/.test(Function.prototype.toString.call(d.get));
    });
    // 被改写过的窗口 getter 也必须伪装成 native code，
    // 否则 getOwnPropertyDescriptor(...).get.toString() 会把注入源码整段吐出来。
    // 注意：本机 Chromium 实测 innerWidth/innerHeight/outerWidth/outerHeight 是
    // window 实例自有 accessor，Window.prototype 上根本没有 —— 只查原型会永远拿到 null。
    out.toStringNativeWindow = safe(function () {
      var d = Object.getOwnPropertyDescriptor(window, 'innerHeight') ||
              Object.getOwnPropertyDescriptor(Window.prototype, 'innerHeight');
      if (!d || !d.get) return null;
      return /native code/.test(Function.prototype.toString.call(d.get));
    });
    // 布局视口那几个 getter 同样被改写，逐个确认没有把源码漏出去
    out.toStringNativeLayout = safe(function () {
      var checks = [
        [Element.prototype, 'clientHeight'],
        [HTMLElement.prototype, 'offsetHeight'],
        (typeof VisualViewport === 'function') ? [VisualViewport.prototype, 'height'] : null
      ];
      var out2 = {};
      for (var i = 0; i < checks.length; i++) {
        var c = checks[i];
        if (!c) continue;
        var d = Object.getOwnPropertyDescriptor(c[0], c[1]);
        out2[c[1]] = (!d || !d.get) ? null : /native code/.test(Function.prototype.toString.call(d.get));
      }
      return out2;
    });

    out.timezone = safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; });
    // 浏览器原生的 getTimezoneOffset 符号约定：UTC+9 => -540
    out.tzOffset = new Date().getTimezoneOffset();
    out.intlLocale = safe(function () { return Intl.DateTimeFormat().resolvedOptions().locale; });
    out.numberFormat = safe(function () { return (1234.5).toLocaleString(); });

    out.screen = {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      availLeft: screen.availLeft, availTop: screen.availTop,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth
    };
    out.dpr = window.devicePixelRatio;
    out.orientation = { type: (screen.orientation || {}).type || null, angle: (screen.orientation || {}).angle };
    out.window = {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight
    };
    // 真实布局视口：注入层改不了这些，用来验证被改写的 inner 有没有和现实打架。
    // 黄条（测试版提示 / 不受支持参数）会把这里压掉 40-60px。
    out.layout = safe(function () {
      var de = document.documentElement;
      var vv = window.visualViewport;
      // 铺满视口的 fixed 元素由内核按真实视口排版，JS 改不掉 ——
      // 这是判断「window.innerHeight 有没有被改写」最硬的证据。
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;margin:0;padding:0;border:0;visibility:hidden';
      document.body.appendChild(probe);
      var fixedH = probe.clientHeight;
      var fixedW = probe.clientWidth;
      probe.remove();
      return {
        clientWidth: de ? de.clientWidth : null,
        clientHeight: de ? de.clientHeight : null,
        offsetWidth: de ? de.offsetWidth : null,
        offsetHeight: de ? de.offsetHeight : null,
        vvWidth: vv ? vv.width : null,
        vvHeight: vv ? vv.height : null,
        fixedWidth: fixedW,
        fixedHeight: fixedH
      };
    });

    out.webgl = safe(function () {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { supported: false };
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var exts = gl.getSupportedExtensions() || [];
      var vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      return {
        supported: true,
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        glVendor: gl.getParameter(gl.VENDOR),
        glRenderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        shadingVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        extCount: exts.length,
        extSample: exts.slice(0, 4),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxViewport: vp ? Array.prototype.slice.call(vp) : null,
        maxAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        // 着色器精度：真实 GPU 之间差异明显，是稳定的设备信号，必须与 vendor 同源
        precision: safe(function () {
          var f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
          var i = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT);
          return f ? {
            floatRange: f.rangeMin + '/' + f.rangeMax, floatPrec: f.precision,
            intRange: i ? i.rangeMin + '/' + i.rangeMax : null
          } : null;
        }),
        // 渲染后读回像素：检测站会渲染固定场景再哈希，真实 GPU 结果各不相同
        pixels: safe(function () {
          gl.clearColor(0.2, 0.4, 0.6, 1.0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          var buf = new Uint8Array(4 * 8);
          gl.readPixels(0, 0, 8, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          return { hash: hashBytes(Array.prototype.slice.call(buf)), first: Array.prototype.slice.call(buf.slice(0, 4)) };
        })
      };
    });

    out.canvas = safe(function () {
      var c = document.createElement('canvas');
      c.width = 220; c.height = 60;
      var ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(20, 10, 120, 30);
      ctx.fillStyle = '#069';
      ctx.fillText('fingerprint-detect', 22, 12);
      var px = ctx.getImageData(0, 0, 40, 20).data;
      return {
        dataUrlLength: c.toDataURL().length,
        hash: hashBytes(Array.prototype.slice.call(px.slice(0, 96))),
        textWidth: ctx.measureText('fingerprint-detect').width
      };
    });

    out.audio = await safeAsync(function () {
      var ctx = new OfflineAudioContext(1, 44100, 44100);
      var osc = ctx.createOscillator();
      var analyser = ctx.createAnalyser();
      osc.type = 'sine';
      osc.connect(analyser);
      analyser.connect(ctx.destination);
      osc.start(0);
      osc.stop(0.01);
      analyser.fftSize = 2048;
      var freq = new Float32Array(analyser.frequencyBinCount);
      var byteFreq = new Uint8Array(analyser.frequencyBinCount);
      var time = new Float32Array(analyser.fftSize);
      return ctx.startRendering().then(function (buf) {
        var d = buf.getChannelData(0);
        var slice = [];
        for (var i = 0; i < 256; i++) slice.push(Math.floor((d[i + 1024] - Math.floor(d[i + 1024])) * 1e13));
        // AnalyserNode 直接往调用方数组里写，完全不经过 AudioBuffer ——
        // 只改 getChannelData 的话，这一路仍会漏出真实音频栈特征。
        analyser.getFloatFrequencyData(freq);
        analyser.getByteFrequencyData(byteFreq);
        analyser.getFloatTimeDomainData(time);
        function quant(arr, n, scale) {
          var out = [];
          for (var k = 0; k < n; k++) out.push(Math.round(arr[k] * scale));
          return out;
        }
        return {
          hash: hashBytes(slice),
          sampleRate: buf.sampleRate,
          channelCount: buf.numberOfChannels,
          analyserFloatHash: hashBytes(quant(freq, 128, 1000)),
          analyserByteHash: hashBytes(Array.prototype.slice.call(byteFreq.subarray(0, 128))),
          analyserTimeHash: hashBytes(quant(time, 128, 1e6))
        };
      });
    });

    out.fonts = safe(function () {
      if (!document.fonts) return null;
      // 字体检测站真正用的手段：比较「指定字体的宽度」与「兜底字体的宽度」。
      // 只改 fonts.check 而不改 measureText，这两者会互相打脸。
      var c = document.createElement('canvas');
      var ctx = c.getContext('2d');
      function widthOf(font) {
        ctx.font = font;
        return ctx.measureText('mmmmmmmmmmlli').width;
      }
      // 用一个几乎不可能存在的字体与通用兜底比较：宽度必须相同，
      // 否则说明「不存在的字体」被报告成了存在。
      var ghost = widthOf('72px ZzzNopeFontX, monospace');
      var mono = widthOf('72px monospace');
      // DOM 侧交叉验证：CSS font 与 canvas 必须给出一致的回退
      var span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;font-size:72px';
      span.style.font = '72px ZzzNopeFontX, monospace';
      span.textContent = 'mmmmmmmmmmlli';
      document.body.appendChild(span);
      var domWidth = span.getBoundingClientRect().width;
      var domMono = 0;
      span.style.font = '72px monospace';
      domMono = span.getBoundingClientRect().width;
      span.remove();
      return {
        size: document.fonts.size,
        arial: document.fonts.check('12px Arial'),
        monospace: document.fonts.check('12px monospace'),
        fake: document.fonts.check('12px ZzzNopeFont'),
        ghostWidth: ghost,
        monoWidth: mono,
        // canvas 与 DOM 都回退到同一个兜底 => 两条探测路径一致
        canvasFallbackMatches: Math.abs(ghost - mono) < 0.5,
        domFallbackMatches: Math.abs(domWidth - domMono) < 0.5,
        domWidth: domWidth
      };
    });

    out.permissionNotifications = await safeAsync(function () {
      if (!navigator.permissions || !navigator.permissions.query) return null;
      return navigator.permissions.query({ name: 'notifications' }).then(function (p) { return p.state; });
    });

    out.connection = safe(function () {
      var c = navigator.connection;
      return c ? { effectiveType: c.effectiveType, rtt: c.rtt, downlink: c.downlink, saveData: c.saveData, type: c.type } : null;
    });

    out.battery = await safeAsync(function () {
      if (typeof navigator.getBattery !== 'function') return null;
      return navigator.getBattery().then(function (b) {
        return { charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
      });
    });

    out.mediaDevices = await safeAsync(function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        return { count: list.length, kinds: list.map(function (d) { return d.kind; }) };
      });
    });

    out.storage = await safeAsync(function () {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      return navigator.storage.estimate().then(function (e) { return { quota: e.quota, usage: e.usage }; });
    });

    out.perfMemory = safe(function () {
      var m = performance.memory;
      return m ? { jsHeapSizeLimit: m.jsHeapSizeLimit, totalJSHeapSize: m.totalJSHeapSize, usedJSHeapSize: m.usedJSHeapSize } : null;
    });

    out.uaData = await safeAsync(function () {
      if (!navigator.userAgentData) return null;
      return navigator.userAgentData.getHighEntropyValues(
        ['platformVersion', 'architecture', 'bitness', 'model', 'formFactors', 'wow64', 'uaFullVersion']
      ).then(function (d) {
        return {
          platform: d.platform, mobile: d.mobile, brands: d.brands, fullVersionList: d.fullVersionList,
          architecture: d.architecture, bitness: d.bitness, model: d.model, formFactors: d.formFactors,
          platformVersion: d.platformVersion, uaFullVersion: d.uaFullVersion, wow64: d.wow64
        };
      });
    });

    out.webgpu = await safeAsync(async function () {
      if (!navigator.gpu) return { supported: false };
      var adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false };
      // 两条读取路径都要采：新版是 adapter.info 属性，旧版是 requestAdapterInfo()。
      // 只补一条，另一条就会漏出真实 GPU。
      var legacy = adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {};
      var modern = adapter.info || {};
      // device / description 在真实 Chrome 里常常是空字符串而不是 null：
      // 探针要照实返回空串，否则与 profile 的空串比对会误报不一致
      return {
        supported: true,
        vendor: String(modern.vendor != null ? modern.vendor : (legacy.vendor != null ? legacy.vendor : '')),
        architecture: String(modern.architecture != null ? modern.architecture : (legacy.architecture != null ? legacy.architecture : '')),
        device: String(modern.device != null ? modern.device : (legacy.device != null ? legacy.device : '')),
        description: String(modern.description != null ? modern.description : (legacy.description != null ? legacy.description : '')),
        // 两条路径给出不同答案 = 只补了一条
        bothAgree: !adapter.requestAdapterInfo || (
          String(modern.vendor || '') === String(legacy.vendor || '') &&
          String(modern.architecture || '') === String(legacy.architecture || '')
        ),
        hasModernInfo: !!adapter.info
      };
    });

    out.webrtc = await safeAsync(function () {
      var PC = (typeof RTCPeerConnection !== 'undefined' && RTCPeerConnection) ||
               (typeof webkitRTCPeerConnection !== 'undefined' && webkitRTCPeerConnection) || null;
      if (!PC) return { supported: false, candidates: [], sdpCandidates: [] };
      var pc = new PC({ iceServers: [] });
      var candidates = [];
      try { pc.createDataChannel('fpb-probe'); } catch (e) {}
      return new Promise(function (resolve) {
        var settled = false;
        function finish() {
          if (settled) return;
          settled = true;
          var sdp = '';
          try { sdp = (pc.localDescription && pc.localDescription.sdp) || ''; } catch (e) {}
          var sdpCandidates = [];
          var lines = String(sdp).split('\\n');
          for (var i = 0; i < lines.length; i++) {
            var t = lines[i].replace(/\\r$/, '');
            if (t.indexOf('a=candidate:') === 0) sdpCandidates.push(t.slice(2));
          }
          try { pc.close(); } catch (e) {}
          resolve({ supported: true, candidates: candidates, sdpCandidates: sdpCandidates });
        }
        pc.onicecandidate = function (ev) {
          if (ev && ev.candidate && ev.candidate.candidate) candidates.push(ev.candidate.candidate);
        };
        pc.onicegatheringstatechange = function () { if (pc.iceGatheringState === 'complete') finish(); };
        pc.createOffer()
          .then(function (offer) { return pc.setLocalDescription(offer); })
          .then(function () { setTimeout(finish, 2500); })
          .catch(function () { finish(); });
      });
    });

    // --- 自动化痕迹与冷门 API ---
    out.stealth = safe(function () {
      var PAT = /^(cdc_|dc_|\\$cdc_|domAutomationController$|__webdriver|__selenium|__driver|callSelenium|_Selenium_IDE_Recorder)/;
      var leaks = [];
      try {
        var names = Object.getOwnPropertyNames(window).concat(Object.getOwnPropertyNames(navigator));
        for (var i = 0; i < names.length; i++) if (PAT.test(names[i])) leaks.push(names[i]);
      } catch (e) {}
      var c = window.chrome || {};
      var voices = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices)
        ? speechSynthesis.getVoices()
        : null;
      var defaultVoice = null;
      if (voices) {
        for (var j = 0; j < voices.length; j++) if (voices[j].default) { defaultVoice = voices[j].name; break; }
      }
      return {
        automationProps: leaks,
        chrome: {
          present: !!window.chrome,
          csi: typeof c.csi,
          loadTimes: typeof c.loadTimes,
          app: typeof c.app,
          runtime: typeof c.runtime
        },
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        hasFocus: safe(function () { return document.hasFocus(); }),
        voices: voices ? voices.length : -1,
        voiceDefault: defaultVoice,
        paymentCanMakePayments: (typeof PaymentRequest !== 'undefined' && typeof PaymentRequest.canMakePayments === 'function')
          ? PaymentRequest.canMakePayments()
          : null,
        patchedFns: (function () {
          // 逐个验证「被改写的函数」是否仍伪装成 native code ——
          // 只抽查两三处不够，BotGuard 会系统性验证 native 标记。
          var list = window.__fpbPatched || [];
          var bad = [];
          var seen = {};
          var hosts = [window, navigator, document, console, history, performance];
          for (var k = 0; k < list.length; k++) {
            var nm = list[k];
            if (seen[nm]) continue;
            seen[nm] = true;
            for (var h = 0; h < hosts.length; h++) {
              if (!hosts[h]) continue;
              var fn = null;
              try { fn = hosts[h][nm]; } catch (e) { continue; }
              if (typeof fn !== 'function') continue;
              var src = '';
              try { src = Function.prototype.toString.call(fn); } catch (e) { src = 'THROW'; }
              if (src.indexOf('[native code]') < 0) bad.push(nm);
              break;
            }
          }
          return { total: list.length, notNative: bad };
        })()
      };
    });

    out.mediaQueries = safe(function () {
      if (!window.matchMedia) return null;
      var QUERIES = [
        '(prefers-color-scheme: dark)', '(prefers-color-scheme: light)',
        '(prefers-reduced-motion: reduce)', '(prefers-contrast: more)',
        '(forced-colors: active)', '(display-mode: browser)',
        '(pointer: fine)', '(hover: hover)', '(any-pointer: coarse)',
        '(update: fast)', '(color-gamut: srgb)', '(scripting: enabled)'
      ];
      var res = {};
      for (var i = 0; i < QUERIES.length; i++) {
        var m = window.matchMedia(QUERIES[i]);
        res[QUERIES[i]] = { matches: !!(m && m.matches), media: m ? m.media : null };
      }
      return res;
    });

    out.mediaCodecs = await safeAsync(function () {
      if (!navigator.mediaCapabilities) return null;
      var TYPES = [
        'video/mp4;codecs="avc1.42E01E"',
        'video/webm;codecs="vp9"',
        'video/webm;codecs="av01.0.05M.08"',
        'audio/mp4;codecs="mp4a.40.2"',
        'audio/mpeg',
        'audio/webm;codecs=opus'
      ];
      return Promise.all(TYPES.map(function (t) {
        var isAudio = t.indexOf('audio') === 0;
        // MediaDecodingType 只有 file / media-source —— 传 'audio' 会被 TypeError 拒绝；
        // VideoConfiguration 的 framerate 是必填 double，缺了同样直接抛错。
        // 这两种情况测出来是 null（采集失败），而不是「不支持该编码」。
        var config = isAudio
          ? { type: 'file', audio: { contentType: t, volume: 1 } }
          : {
              type: 'file',
              video: { contentType: t, width: 1280, height: 720, bitrate: 2000000, framerate: 30 }
            };
        return navigator.mediaCapabilities
          .decodingInfo(config)
          .then(function (r) { return [t, !!(r && r.supported)]; })
          .catch(function () { return [t, null]; });
      })).then(function (pairs) {
        var o = {};
        for (var i = 0; i < pairs.length; i++) o[pairs[i][0]] = pairs[i][1];
        return o;
      });
    });

    // <video>.canPlayType 与 Widevine：这是「品牌化正式版」与
    // 「Chromium / Chrome for Testing」最直白的分水岭 —— 未品牌化构建缺
    // H.264 / AAC / Widevine，服务端一问就知道不是真实用户环境。
    out.canPlayType = safe(function () {
      var v = document.createElement('video');
      var CODECS = [
        'video/mp4;codecs="avc1.42E01E"',
        'video/mp4;codecs="mp4v.20.3"',
        'audio/mp4;codecs="mp4a.40.2"',
        'audio/mpeg',
        'video/webm;codecs="vp8,vorbis"',
        'video/webm;codecs="vp9"',
        'application/ogg;codecs="theora,vorbis"'
      ];
      var o = {};
      for (var i = 0; i < CODECS.length; i++) {
        var r = '';
        try { r = v.canPlayType(CODECS[i]); } catch (e) { r = 'ERR'; }
        o[CODECS[i]] = r || 'no';
      }
      return o;
    });

    out.widevine = await safeAsync(function () {
      if (!navigator.requestMediaKeySystemAccess) return { available: false };
      // 只探测能力，不真的建 session —— 建 session 会拉起 CDM 进程
      return navigator
        .requestMediaKeySystemAccess('com.widevine.alpha', [{
          initDataTypes: ['cenc'],
          videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }],
          audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }]
        }])
        .then(function (a) {
          if (!a) return { available: false };
          var cfg = null;
          try { cfg = a.getConfiguration ? a.getConfiguration() : null; } catch (e) { cfg = null; }
          return { available: true, keySystem: a.keySystem || null, config: cfg };
        })
        .catch(function (e) { return { available: false, error: String(e && e.name ? e.name : e) }; });
    });

    // 自编译补丁内核会在页面里暴露这个标记；官方内核没有，
    // 因此可以据此确认「补丁真的编译进内核了」而不是只做了 JS 注入。
    out.kernelMarker = safe(function () {
      var m = window.__fpbKernel;
      return m === undefined ? null : m;
    });

    // console.log(obj) 会不会被 CDP 序列化触发 getter：
    // 触发即说明「有调试器挂着」，加固后应该不触发。
    out.consoleGetterTrap = safe(function () {
      var triggered = false;
      var probe = {};
      Object.defineProperty(probe, 'fpbTrap', {
        get: function () { triggered = true; return 1; },
        enumerable: true,
        configurable: true
      });
      console.log(probe);
      var src = '';
      try { src = Function.prototype.toString.call(console.log); } catch (e) { src = 'THROW'; }
      return { triggered: triggered, looksNative: src.indexOf('[native code]') >= 0 };
    });

    return out;
    })();
  };
})();
</script>
</body>
</html>
`