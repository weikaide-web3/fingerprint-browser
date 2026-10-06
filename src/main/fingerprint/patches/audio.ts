import type { FingerprintConfig } from '@shared/types'

/** AudioContext / OfflineAudioContext / AnalyserNode 音频指纹扰动 */
export function audioPatch(_fp: FingerprintConfig): string {
  return `
// --- Audio ---
(function () {
  const A = CFG.audio;
  if (A.mode === 'off') return;
  const factor = Math.max(0, A.noiseFactor);
  const base = strHash(String(A.seed || CFG.seed) + '|audio');

  function noiseAt(index, value) {
    let h = (base ^ (index * 2246822519) ^ Math.imul(Math.round(value * 1e6), 2654435761)) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 2246822507) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return ((h % (2 * Math.round(factor * 1e6) + 1)) - Math.round(factor * 1e6)) / 1e6;
  }
  function applyNoise(channel) {
    if (factor <= 0) return;
    for (let i = 0; i < channel.length; i++) channel[i] = channel[i] + noiseAt(i, channel[i]);
  }

  const bufProto = typeof AudioBuffer !== 'undefined' ? AudioBuffer.prototype : null;
  const rawGetChannel = bufProto ? bufProto.getChannelData : null;
  const rawNumChannels = bufProto
    ? Object.getOwnPropertyDescriptor(bufProto, 'numberOfChannels').get
    : null;
  if (bufProto && rawGetChannel) {
    bufProto.getChannelData = hideNative(function getChannelData(channelIndex) {
      const data = rawGetChannel.call(this, channelIndex);
      applyNoise(data);
      return data;
    }, 'getChannelData');
    define(bufProto, 'sampleRate', { get: function () { return A.sampleRate; } });
    define(bufProto, 'numberOfChannels', { get: function () { return A.numberOfChannels; } });
  }

  if (typeof OfflineAudioContext !== 'undefined' && rawGetChannel && rawNumChannels) {
    const origStart = OfflineAudioContext.prototype.startRendering;
    if (origStart && A.offlineNoise) {
      OfflineAudioContext.prototype.startRendering = hideNative(function startRendering() {
        return origStart.apply(this, arguments).then(function (buffer) {
          // 必须用原生通道数遍历，numberOfChannels 已被改写
          const channels = rawNumChannels.call(buffer);
          for (let c = 0; c < channels; c++) applyNoise(rawGetChannel.call(buffer, c));
          return buffer;
        });
      }, 'startRendering');
    }
    define(OfflineAudioContext.prototype, 'sampleRate', { get: function () { return A.sampleRate; } });
    define(OfflineAudioContext.prototype, 'channelCount', { get: function () { return A.channelCount; } });
  }

  // --- AnalyserNode ---
  // 音频指纹的另一条主流路径：createAnalyser() 后把频谱直接读进调用方给的数组，
  // 完全不经过 AudioBuffer，所以只改 getChannelData 会被绕过。
  const analyserProto = typeof AnalyserNode !== 'undefined' ? AnalyserNode.prototype : null;
  if (analyserProto) {
    function noiseIdx(i, v) {
      let h = (base ^ Math.imul(i + 1, 2246822519) ^ Math.imul(Math.round((v + 200) * 1000), 2654435761)) >>> 0;
      h = (h ^ (h >>> 15)) >>> 0;
      h = Math.imul(h, 2246822507) >>> 0;
      h = (h ^ (h >>> 13)) >>> 0;
      return (h % 1000) / 1000 - 0.5;
    }
    const origFloat = analyserProto.getFloatFrequencyData;
    if (origFloat && factor > 0) {
      analyserProto.getFloatFrequencyData = hideNative(function getFloatFrequencyData(array) {
        origFloat.call(this, array);
        const span = factor * 40; // dB 域：噪声幅度按 factor 放大
        for (let i = 0; i < array.length; i++) array[i] = array[i] + noiseIdx(i, array[i]) * span;
      }, 'getFloatFrequencyData');
    }
    const origByte = analyserProto.getByteFrequencyData;
    if (origByte && factor > 0) {
      analyserProto.getByteFrequencyData = hideNative(function getByteFrequencyData(array) {
        origByte.call(this, array);
        const span = Math.max(1, Math.round(factor * 2000));
        for (let i = 0; i < array.length; i++) {
          const d = Math.round(noiseIdx(i, array[i]) * span);
          array[i] = Math.max(0, Math.min(255, array[i] + d));
        }
      }, 'getByteFrequencyData');
    }
    const origTime = analyserProto.getFloatTimeDomainData;
    if (origTime && factor > 0) {
      analyserProto.getFloatTimeDomainData = hideNative(function getFloatTimeDomainData(array) {
        origTime.call(this, array);
        for (let i = 0; i < array.length; i++) array[i] = array[i] + noiseIdx(i, array[i]) * factor * 2;
      }, 'getFloatTimeDomainData');
    }
  }

  // --- 采样率 / 声道：AudioContext 本体也要一致 ---
  if (typeof BaseAudioContext !== 'undefined') {
    define(BaseAudioContext.prototype, 'sampleRate', { get: function () { return A.sampleRate; } });
  }
  if (typeof AudioContext !== 'undefined') {
    define(AudioContext.prototype, 'sampleRate', { get: function () { return A.sampleRate; } });
  }
})();
`
}
