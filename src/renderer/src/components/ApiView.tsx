import { useEffect, useState } from 'react'
import { useApi } from '../store'

// btn constant removed – using .btn classes directly in JSX

const ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: 'GET', path: '/health', desc: '服务健康检查（不需要 Token）' },
  { method: 'GET', path: '/api/v1/user/list', desc: '环境列表（page_no / page_size / browser_name）' },
  { method: 'POST', path: '/api/v1/user/create', desc: '新建环境（browser_name，自动生成指纹）' },
  { method: 'POST', path: '/api/v1/user/update', desc: '改环境（user_id + browser_name / remark / group_id）' },
  { method: 'POST', path: '/api/v1/user/delete', desc: '删除环境（user_id）' },
  { method: 'GET/POST', path: '/api/v1/browser/start', desc: '启动环境并返回 CDP 端点（user_id / headless / urls）' },
  { method: 'GET/POST', path: '/api/v1/browser/stop', desc: '关闭环境（user_id）' },
  { method: 'GET', path: '/api/v1/browser/status', desc: '查询单个环境运行状态' },
  { method: 'GET', path: '/api/v1/browser/active', desc: '列出所有运行中的环境' },
  { method: 'GET/POST', path: '/api/v1/browser/open', desc: '在运行中的环境里打开 URL（user_id / urls）' },
  { method: 'GET', path: '/api/v1/ip/check', desc: '查询该环境实际出口 IP / 归属地' }
]

function snippet(baseUrl: string, token: string): string {
  const auth = token ? ` \\\n  -H "Authorization: Bearer ${token}"` : ''
  return [
    '# 启动环境并拿到 CDP 端点',
    `curl -X POST "${baseUrl}/api/v1/browser/start?user_id=<user_id>&headless=1"${auth}`,
    '',
    '// Playwright：直接接管已启动的环境',
    "const { chromium } = require('playwright-core')",
    "const browser = await chromium.connectOverCDP('<http 端点>')",
    'const ctx = browser.contexts()[0]',
    "const page = ctx.pages()[0] ?? (await ctx.newPage())",
    "await page.goto('https://example.com')"
  ].join('\n')
}

export default function ApiView(): React.JSX.Element {
  const { status, loading, busy, error, notice, load, act } = useApi()
  // Token 不进 status 轮询对象，只在用户点「显示」时单独取一次
  const [revealed, setRevealed] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const baseUrl = status?.baseUrl ?? null

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">自动化 API</h2>
        <span className="text-xs text-slate-500">AdsPower 兼容的本机接口，只监听 127.0.0.1</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void (status?.running ? act('stop', '已停止') : act('start', '已启动'))}
            disabled={busy || loading}
            className={`btn ${status?.running ? 'btn-danger' : 'btn-primary'}`}
          >
            {status?.running ? '■ 停止服务' : '▶ 启动服务'}
          </button>
          <button
            onClick={() => void act('restart', '已重启')}
            disabled={busy || loading}
            className="btn btn-secondary"
          >
            ↻ 重启
          </button>
        </div>
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-4 py-2.5 text-sm text-emerald-200 animate-fade-in">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
        <section className="card p-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className={status?.running ? 'text-emerald-300' : 'text-slate-400'}>
              {status?.running ? '● 运行中' : '○ 未运行'}
            </span>
            <span className="text-slate-400">
              配置端口 {status?.configuredPort || '自动'}
              {status?.port ? `（实际 ${status.port}）` : ''}
            </span>
            <span className="text-slate-400">已处理请求 {status?.requests ?? 0}</span>
            <span className={status?.authRequired ? 'text-amber-300' : 'text-slate-400'}>
              {status?.authRequired ? '已开启 Token 鉴权' : '未设置 Token（无鉴权）'}
            </span>
          </div>

          {status?.tokenConfigured && (
            <div className="mt-3 flex items-center gap-2 text-xs">
              <code className="rounded bg-slate-950/70 border border-slate-800 px-2 py-1 font-mono text-slate-300">
                {revealed ? revealed : '•'.repeat(40)}
              </code>
              <button
                onClick={() => {
                  if (revealed) {
                    setRevealed(null)
                  } else {
                    void window.api.api
                      .revealToken()
                      .then(setRevealed)
                      .catch((e: unknown) => setTokenError(e instanceof Error ? e.message : String(e)))
                  }
                }}
                className="text-slate-400 hover:text-slate-200"
              >
                {revealed ? '隐藏' : '显示'}
              </button>
              <button
                onClick={() => {
                  if (revealed) void navigator.clipboard.writeText(revealed)
                  else
                    void window.api.api
                      .revealToken()
                      .then((t) => {
                        setRevealed(t)
                        void navigator.clipboard.writeText(t)
                      })
                      .catch((e: unknown) => setTokenError(e instanceof Error ? e.message : String(e)))
                }}
                className="text-slate-400 hover:text-slate-200"
              >
                复制
              </button>
              <button
                onClick={() => void act('generateToken', '已生成新的 Token，旧 Token 立即失效')}
                className="ml-auto rounded bg-slate-800 hover:bg-slate-700 px-2.5 py-1"
              >
                重新生成
              </button>
            </div>
          )}
          {!status?.tokenConfigured && (
            <div className="mt-2 text-xs text-amber-300/80">
              没有 Token 时，本机任何进程都能驱动这些接口。建议点「重新生成」开启鉴权。
            </div>
          )}
          {tokenError && <div className="mt-2 text-xs text-rose-300/80">读取 Token 失败：{tokenError}</div>}
          <div className="mt-2 text-xs text-slate-500">端口与开关在「设置 → 自动化 API」里改；改完点上面的「重启」生效。</div>
        </section>

        <section className="card">
          <h3 className="section-header text-xs font-semibold text-slate-300">接口清单</h3>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={`${e.method} ${e.path}`} className="border-t border-slate-800/70 first:border-t-0">
                  <td className="px-4 py-1.5 w-14 text-[11px] text-slate-400">{e.method}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-slate-300">{e.path}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-500">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3 className="section-header text-xs font-semibold text-slate-300">调用示例</h3>
          <pre className="px-4 py-3 text-[11px] font-mono text-slate-400 overflow-auto">
            {snippet(baseUrl ?? `http://127.0.0.1:${status?.configuredPort ?? 52222}`, revealed ?? '')}
          </pre>
        </section>
      </div>
    </>
  )
}