import type { OsPlatform } from '@shared/types'

/** 生成器使用的真实分布数据集 */

export interface GpuPreset {
  id: string
  os: OsPlatform
  vendor: string
  renderer: string
  webglVersion: string
  shadingLanguageVersion: string
  extensions: string[]
  parameters: Record<string, string | number>
}

/**
 * WebGPU 的 GPUAdapter info。
 *
 * 必须与 WebGL 预设同源：Chrome 里 navigator.gpu 拿到的厂商/架构与
 * WEBGL_debug_renderer_info 说的是同一块显卡。只改 WebGL 不改这里，
 * 两个 API 会互相打脸（这也是检测站最爱比的一项）。
 */
export interface WebGpuInfo {
  vendor: string
  architecture: string
  device: string
  description: string
}

const WEBGPU_BY_PRESET: Record<string, WebGpuInfo> = {
  'apple-m1': { vendor: 'apple', architecture: 'apple-m1', device: '', description: '' },
  'apple-m2': { vendor: 'apple', architecture: 'apple-m2', device: '', description: '' },
  'apple-m3-pro': { vendor: 'apple', architecture: 'apple-m3-pro', device: '', description: '' },
  'apple-m4': { vendor: 'apple', architecture: 'apple-m4', device: '', description: '' },
  'intel-uhd-macos': { vendor: 'intel', architecture: 'gen-9.5', device: '', description: '' },
  'nvidia-rtx-win': { vendor: 'nvidia', architecture: 'ampere', device: '', description: '' },
  'intel-iris-win': { vendor: 'intel', architecture: 'gen-12', device: '', description: '' }
}

/** 取预设对应的 WebGPU 信息；新增预设忘了登记时按厂商兜底，保证至少同源 */
export function webgpuFor(preset: GpuPreset): WebGpuInfo {
  const hit = WEBGPU_BY_PRESET[preset.id]
  if (hit) return { ...hit }
  const vendor = /apple/i.test(preset.vendor)
    ? 'apple'
    : /nvidia/i.test(preset.vendor)
      ? 'nvidia'
      : /intel/i.test(preset.vendor)
        ? 'intel'
        : /amd/i.test(preset.vendor)
          ? 'amd'
          : 'unknown'
  return { vendor, architecture: 'unknown', device: '', description: '' }
}

/** 兜底版本表；auto 模式会直接读取内核真实版本以保证 Client Hints 一致 */
export const CHROME_VERSIONS: { major: number; full: string }[] = [
  { major: 153, full: '153.0.8010.12' },
  { major: 152, full: '152.0.7950.118' },
  { major: 151, full: '151.0.7900.120' },
  { major: 150, full: '150.0.7871.124' },
  { major: 149, full: '149.0.7827.114' }
]

export const MAC_OS_VERSIONS = ['14_5_0', '14_6_0', '15_1_0', '15_3_0', '15_5_0', '26_0_0', '26_5_0']
export const WINDOWS_OS_VERSIONS = ['10.0', '10.0', '10.0', '11.0']

export const COMMON_WEBGL_EXTENSIONS = [
  'ANGLE_instanced_arrays',
  'EXT_blend_minmax',
  'EXT_clip_control',
  'EXT_color_buffer_half_float',
  'EXT_depth_clamp',
  'EXT_float_blend',
  'EXT_frag_depth',
  'EXT_polygon_offset_clamp',
  'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge',
  'EXT_sRGB',
  'KHR_parallel_shader_compile',
  'OES_element_index_uint',
  'OES_fbo_render_mipmap',
  'OES_standard_derivatives',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
  'OES_texture_half_float_linear',
  'OES_vertex_array_object',
  'WEBGL_blend_func_extended',
  'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_depth_texture',
  'WEBGL_draw_buffers',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'WEBGL_polygon_mode'
]

export function appleParams(samples: number, uniform: number): Record<string, string | number> {
  return {
    MAX_TEXTURE_SIZE: 16384,
    MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
    MAX_RENDERBUFFER_SIZE: 16384,
    MAX_VERTEX_ATTRIBS: 16,
    MAX_VERTEX_UNIFORM_VECTORS: uniform,
    MAX_FRAGMENT_UNIFORM_VECTORS: uniform,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_TEXTURE_IMAGE_UNITS: 16,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 32,
    MAX_SAMPLES: samples,
    MAX_ARRAY_TEXTURE_LAYERS: 2048,
    MAX_VARYING_VECTORS: 30,
    MAX_ELEMENTS_INDICES: 16777215,
    MAX_ELEMENTS_VERTICES: 16777215
  }
}

export const GPU_PRESETS: GpuPreset[] = [
  {
    id: 'apple-m1',
    os: 'macOS',
    vendor: 'Apple Inc.',
    renderer: 'Apple M1',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(4, 1024)
  },
  {
    id: 'apple-m2',
    os: 'macOS',
    vendor: 'Apple Inc.',
    renderer: 'Apple M2',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(4, 1024)
  },
  {
    id: 'apple-m3-pro',
    os: 'macOS',
    vendor: 'Apple Inc.',
    renderer: 'Apple M3 Pro',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(4, 4096)
  },
  {
    id: 'apple-m4',
    os: 'macOS',
    vendor: 'Apple Inc.',
    renderer: 'Apple M4',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(4, 4096)
  },
  {
    id: 'intel-uhd-macos',
    os: 'macOS',
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E98) OpenGL ES 2.0 macOS - 21.0.6, OpenGL)',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS.filter((e) => e !== 'WEBGL_polygon_mode'),
    parameters: appleParams(4, 1024)
  },
  {
    id: 'nvidia-rtx-win',
    os: 'Windows',
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(8, 4096)
  },
  {
    id: 'intel-iris-win',
    os: 'Windows',
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: COMMON_WEBGL_EXTENSIONS,
    parameters: appleParams(4, 4096)
  }
]

export interface ScreenPreset {
  width: number
  height: number
  dpr: number
  os: OsPlatform
}

// 注意：screen.width / height 必须是**逻辑点（DIP）**，不是显示器的原生像素。
// 真实 macOS Chrome 在 Retina 上报的是 1512x982 这类点值，配 devicePixelRatio=2；
// 写 3024x1964 这种原生分辨率没有任何真实浏览器会报，而且窗口根本开不到那么高
// （窗口高度受显示器工作区限制），检测时会一直对不上。
export const SCREEN_PRESETS: ScreenPreset[] = [
  { width: 1512, height: 982, dpr: 2, os: 'macOS' },
  { width: 1728, height: 1117, dpr: 2, os: 'macOS' },
  { width: 1470, height: 956, dpr: 2, os: 'macOS' },
  { width: 1680, height: 1050, dpr: 2, os: 'macOS' },
  { width: 2560, height: 1440, dpr: 2, os: 'macOS' },
  { width: 1920, height: 1080, dpr: 1, os: 'Windows' },
  { width: 2560, height: 1440, dpr: 1, os: 'Windows' },
  { width: 1366, height: 768, dpr: 1, os: 'Windows' },
  { width: 2560, height: 1440, dpr: 1.5, os: 'Windows' },
  { width: 1536, height: 864, dpr: 1.25, os: 'Windows' }
]

export const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland'
]

export const LANGUAGE_PRESETS = [
  { accept: 'en-US,en;q=0.9', languages: ['en-US', 'en'], locale: 'en-US' },
  { accept: 'zh-CN,zh;q=0.9,en;q=0.8', languages: ['zh-CN', 'zh', 'en'], locale: 'zh-CN' },
  { accept: 'en-GB,en;q=0.9', languages: ['en-GB', 'en'], locale: 'en-GB' },
  { accept: 'de-DE,de;q=0.9,en;q=0.8', languages: ['de-DE', 'de', 'en'], locale: 'de-DE' },
  { accept: 'fr-FR,fr;q=0.9,en;q=0.8', languages: ['fr-FR', 'fr', 'en'], locale: 'fr-FR' },
  { accept: 'es-ES,es;q=0.9,en;q=0.8', languages: ['es-ES', 'es', 'en'], locale: 'es-ES' },
  { accept: 'ja-JP,ja;q=0.9,en;q=0.8', languages: ['ja-JP', 'ja', 'en'], locale: 'ja-JP' },
  { accept: 'pt-BR,pt;q=0.9,en;q=0.8', languages: ['pt-BR', 'pt', 'en'], locale: 'pt-BR' }
]

export const HARDWARE_CONCURRENCY = [4, 8, 8, 8, 10, 12, 16, 16, 20]
export const DEVICE_MEMORY = [4, 8, 8, 16, 32]

export const MAC_FONTS = [
  'Helvetica Neue', 'Helvetica', 'Arial', 'Arial Black', 'Arial Narrow', 'Avenir Next', 'Avenir',
  'Baskerville', 'Brush Script MT', 'Chalkboard SE', 'Copperplate', 'Courier New', 'Didot', 'Futura',
  'Geneva', 'Gill Sans', 'Hoefler Text', 'Impact', 'Menlo', 'Monaco', 'Optima', 'Palatino', 'Papyrus',
  'Rockwell', 'Savoye LET', 'Seravek', 'SignPainter', 'Skia', 'Snell Roundhand', 'Symbol',
  'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapf Dingbats'
]

export const WINDOWS_FONTS = [
  'Bahnschrift', 'Cambria', 'Cambria Math', 'Candara', 'Comic Sans MS', 'Consolas', 'Corbel',
  'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Lucida Console',
  'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Black', 'Segoe UI Light',
  'Segoe UI Semibold', 'Segoe UI Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'
]

/** GREASE 化的 Not Brand，Chrome 每个大版本会变化 */
export const NOT_BRANDS = [
  { brand: 'Not_A Brand', version: '8' },
  { brand: 'Not;A=Brand', version: '8' },
  { brand: 'Not?A_Brand', version: '24' },
  { brand: 'Not(A:Brand', version: '99' }
]

/**
 * speechSynthesis.getVoices() 的真实样本。
 *
 * macOS 的语音列表与 Windows 完全不同，且都带 localService: true（系统自带语音）。
 * headless / 精简 Linux 上这个列表常常是空数组 ——
 * 「有 Chrome 却没有任何语音」本身就是自动化特征。
 */
export const MAC_VOICES = [
  { name: 'Alex', lang: 'en-US', voiceURI: 'Alex' },
  { name: 'Alice', lang: 'it-IT', voiceURI: 'Alice' },
  { name: 'Alva', lang: 'sv-SE', voiceURI: 'Alva' },
  { name: 'Daniel', lang: 'en-GB', voiceURI: 'Daniel' },
  { name: 'Fred', lang: 'en-US', voiceURI: 'Fred' },
  { name: 'Karen', lang: 'en-AU', voiceURI: 'Karen' },
  { name: 'Moira', lang: 'en-IE', voiceURI: 'Moira' },
  { name: 'Rishi', lang: 'en-IN', voiceURI: 'Rishi' },
  { name: 'Samantha', lang: 'en-US', voiceURI: 'Samantha' },
  { name: 'Tessa', lang: 'en-ZA', voiceURI: 'Tessa' },
  { name: 'Victoria', lang: 'en-US', voiceURI: 'Victoria' }
]

export const WINDOWS_VOICES = [
  { name: 'Microsoft David Desktop', lang: 'en-US', voiceURI: 'Microsoft David Desktop' },
  { name: 'Microsoft Zira Desktop', lang: 'en-US', voiceURI: 'Microsoft Zira Desktop' },
  { name: 'Microsoft Hazel Desktop', lang: 'en-GB', voiceURI: 'Microsoft Hazel Desktop' },
  { name: 'Microsoft George Desktop', lang: 'en-GB', voiceURI: 'Microsoft George Desktop' },
  { name: 'Microsoft Huihui Desktop', lang: 'zh-CN', voiceURI: 'Microsoft Huihui Desktop' },
  { name: 'Microsoft Yaoyao Desktop', lang: 'zh-CN', voiceURI: 'Microsoft Yaoyao Desktop' }
]
