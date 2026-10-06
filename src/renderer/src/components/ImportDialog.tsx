import { useState } from 'react'
import { useProxies } from '../store'

interface Props {
  onClose(): void
}

const PLACEHOLDER = [
  '每行一个，支持以下写法：',
  '1.2.3.4:8080',
  '1.2.3.4:8080:账号:密码',
  'socks5://账号:密码@1.2.3.4:1080',
  '# 以 # 开头的行会被忽略'
].join('\n')

export default function ImportDialog({ onClose }: Props): React.JSX.Element {
  const { importText } = useProxies()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: { line: string; reason: string }[] } | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setResult(await importText(text))
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[560px] rounded-xl bg-[#0d1117] border border-slate-700 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-3">批量导入代理</div>
        <textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          className="w-full rounded-md bg-slate-800/70 border border-slate-700 px-3 py-2 text-sm font-mono outline-none focus:border-emerald-500"
        />
        {result && (
          <div className="mt-3 text-xs text-slate-400">
            成功导入 {result.imported} 个
            {result.skipped.length > 0 && (
              <ul className="mt-1 max-h-32 overflow-auto space-y-0.5">
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    <span className="text-rose-300">跳过</span> {s.line} — {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className=" btn btn-secondary px-3 py-1.5 text-sm">
            关闭
          </button>
          <button
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
            className="btn btn-primary disabled:opacity-50 px-4 py-1.5 text-sm"
          >
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
