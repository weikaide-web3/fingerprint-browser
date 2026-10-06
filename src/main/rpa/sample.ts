import type { RpaFlow } from '@shared/rpa'

/**
 * 内置示例流程：第一次打开 RPA 页时用来演示，
 * 同时是集成测试与界面 E2E 的固定样本 —— 所以它必须始终通过静态校验。
 *
 * 放在纯模块里（而不是 services/rpa.ts），这样单测不必把数据库链拉进来。
 */
export function sampleFlow(): RpaFlow {
  return {
    version: 1,
    name: '示例：打开 example.com 并校验标题',
    description: '演示 goto / assertText / text / screenshot 的组合，可直接在任意环境上跑。',
    defaultTimeoutMs: 15000,
    params: { target: 'https://example.com/' },
    steps: [
      { id: 's1', type: 'goto', url: '${target}', label: '打开目标页' },
      { id: 's2', type: 'assertVisible', selector: 'h1', label: '确认标题存在' },
      { id: 's3', type: 'text', selector: 'h1', variable: 'title' },
      { id: 's4', type: 'assertText', expected: 'Example Domain', mode: 'contains', label: '标题包含 Example Domain' },
      { id: 's5', type: 'log', message: '抓到标题：${title}' },
      { id: 's6', type: 'screenshot', filename: 'result.png' }
    ]
  }
}