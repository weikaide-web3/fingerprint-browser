import type { FingerprintConfig } from '@shared/types'

/**
 * WebRTC ICE 候选控制。
 *
 * 为什么必须在 JS 层做：页面只要 new RTCPeerConnection() 再 createDataChannel，
 * 就能通过 onicecandidate 读到本机内网 IP（192.168.x.x）与真实公网 IP —— 完全绕过
 * --proxy-server。Google / X 与各家检测站都直接用这一手验证「你是不是真在代理后面」。
 *
 * 两层配合：
 * - 网络层：--force-webrtc-ip-handling-policy=disable_non_proxied_udp 阻止 UDP 直连泄漏；
 * - JS 层：改写 / 丢弃候选与 SDP 里的 candidate 行，让页面读到的地址与 profile 一致。
 * 只有网络层不够，因为 Chrome 仍会把 host 候选（内网 IP）交给页面。
 *
 * 注意不能直接删掉 RTCPeerConnection：真实 Chrome 必然存在它，删掉本身就是特征。
 */
export function webrtcPatch(_fp: FingerprintConfig): string {
  return `
// --- WebRTC ICE 候选 ---
(function () {
  const W = CFG.webrtc;
  const RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!RTC) return;
  const mode = W.mode;
  const publicIp = W.publicIp || '';
  const localPool = (W.localIps && W.localIps.length) ? W.localIps : ['192.168.1.10', '10.0.0.10'];

  function isPrivate(ip) {
    return /^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.|127\\.|0\\.)/.test(ip) || ip.indexOf(':') >= 0;
  }

  // 假内网地址由 seed 决定：同一 profile 每次一致，不同 profile 不同
  let hostIdx = 0;
  function fakeHostIp() {
    const pick = localPool[hostIdx % localPool.length];
    hostIdx++;
    return pick;
  }

  const CAND = /^candidate:(\\S+)\\s+(\\d+)\\s+(\\S+)\\s+(\\d+)\\s+(\\S+)\\s+(\\d+)\\s+typ\\s+(\\w+)(.*)$/;

  /** 返回改写后的 candidate 行；返回 null 表示丢弃该候选 */
  function rewriteLine(line) {
    const m = CAND.exec(line);
    if (!m) return line;
    const type = m[7];
    let ip = m[5];
    if (mode === 'disable') return null;
    if (type === 'host') {
      // mDNS 候选（xxxx.local）本身不泄漏，但会让「有没有做伪装」前后不一致
      if (!W.maskLocalIps && isPrivate(ip) && ip.indexOf('.local') < 0) return line;
      ip = fakeHostIp();
    } else if (type === 'srflx' || type === 'prflx' || type === 'relay') {
      if (publicIp) ip = publicIp;
      else if (mode === 'fake') return null;
    }
    return 'candidate:' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] + ' ' + ip + ' ' + m[6] + ' typ ' + type + m[8];
  }

  function makeCandidate(orig, newLine) {
    if (newLine === null) return null;
    // RTCIceCandidate.candidate 是只读访问器，直接改会抛；
    // 用 own property 遮蔽原型访问器，保留 instanceof 与其余字段。
    try {
      Object.defineProperty(orig, 'candidate', { value: newLine, configurable: true, enumerable: true });
      return orig;
    } catch (e) {
      return {
        candidate: newLine,
        sdpMid: orig && orig.sdpMid,
        sdpMLineIndex: orig && orig.sdpMLineIndex,
        usernameFragment: orig && orig.usernameFragment,
        toJSON: function () { return { candidate: newLine }; }
      };
    }
  }

  function filterEvent(ev) {
    if (!ev) return;
    let cand;
    try { cand = ev.candidate; } catch (e) { return; }
    if (!cand) return;
    const line = rewriteLine(cand.candidate || '');
    try {
      Object.defineProperty(ev, 'candidate', { value: makeCandidate(cand, line), configurable: true });
    } catch (e) {}
  }

  const proto = RTC.prototype;

  // 1) onicecandidate 属性：包装用户传入的 handler
  const onDesc = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  if (onDesc && onDesc.set) {
    define(proto, 'onicecandidate', {
      configurable: true,
      enumerable: onDesc.enumerable,
      get: onDesc.get,
      set: hideNative(function set(handler) {
        if (typeof handler !== 'function') { onDesc.set.call(this, handler); return; }
        const self = this;
        const wrapped = function (ev) { filterEvent(ev); return handler.call(self, ev); };
        onDesc.set.call(this, wrapped);
      }, 'set onicecandidate')
    });
  }

  // 2) addEventListener('icecandidate')
  const origAdd = proto.addEventListener;
  if (origAdd) {
    proto.addEventListener = hideNative(function addEventListener(type, listener, options) {
      if (type === 'icecandidate' && typeof listener === 'function') {
        const self = this;
        const wrapped = function (ev) { filterEvent(ev); return listener.call(self, ev); };
        return origAdd.call(this, type, wrapped, options);
      }
      return origAdd.apply(this, arguments);
    }, 'addEventListener');
  }

  // 3) SDP：localDescription 里的 a=candidate: 行同样会泄漏
  function rewriteSdp(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const kept = [];
    const lines = sdp.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].replace(/\\r$/, '');
      if (/^a=candidate:/.test(trimmed)) {
        const rewritten = rewriteLine(trimmed.slice(2));
        if (rewritten !== null) kept.push(rewritten + '\\r\\n');
      } else {
        kept.push(trimmed + '\\r\\n');
      }
    }
    return kept.join('');
  }

  const descProps = ['localDescription', 'remoteDescription'];
  for (let i = 0; i < descProps.length; i++) {
    const prop = descProps[i];
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) continue;
    define(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: hideNative(function get() {
        const desc = d.get.call(this);
        if (!desc || !desc.sdp) return desc;
        try {
          const sdp = rewriteSdp(desc.sdp);
          return { type: desc.type, sdp: sdp, toJSON: function () { return { type: this.type, sdp: this.sdp }; } };
        } catch (e) {
          return desc;
        }
      }, 'get ' + prop)
    });
  }

  // 4) 页面自己用 SDP 字符串构造 RTCIceCandidate 时也走同一套改写
  if (typeof RTCIceCandidate === 'function') {
    const origInit = RTCIceCandidate;
    const Wrapped = function (init) {
      const patched = (init && typeof init.candidate === 'string')
        ? Object.assign({}, init, { candidate: rewriteLine(init.candidate) || '' })
        : init;
      return new origInit(patched);
    };
    try { Wrapped.prototype = origInit.prototype; } catch (e) {}
    try {
      Object.defineProperty(window, 'RTCIceCandidate', { value: Wrapped, configurable: true, writable: false });
    } catch (e) {}
  }

  // 5) disable 模式：构造时清空 iceServers 并强制 relay，引擎收集不到任何候选
  if (mode === 'disable') {
    const OrigPC = RTC;
    function WrappedPC(config, options) {
      const c = Object.assign({}, config || {});
      c.iceServers = [];
      c.iceTransportPolicy = 'relay';
      return new OrigPC(c, options);
    }
    WrappedPC.prototype = OrigPC.prototype;
    try {
      Object.defineProperty(window, 'RTCPeerConnection', { value: WrappedPC, configurable: true, writable: false });
      Object.defineProperty(window, 'webkitRTCPeerConnection', { value: WrappedPC, configurable: true, writable: false });
    } catch (e) {}
  }
})();
`
}