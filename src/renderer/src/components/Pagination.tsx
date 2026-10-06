interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange(page: number): void
  onPageSizeChange(size: number): void
}

const PAGE_SIZES = [5, 10, 20, 50, 100]

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: PaginationProps): React.JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null

  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  // Build page numbers to show (max 7 buttons)
  const pages: (number | '...')[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push('...')
    const start = Math.max(2, page - 1)
    const end = Math.min(totalPages - 1, page + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (page < totalPages - 2) pages.push('...')
    pages.push(totalPages)
  }

  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-[#1e293b] text-xs text-slate-400">
      <div className="flex items-center gap-2">
        <span>共 <span className="text-slate-200 font-medium">{total}</span> 条</span>
        <span className="text-slate-600">|</span>
        <span>显示 {from}–{to}</span>
      </div>

      <div className="flex items-center gap-1">
        <label className="flex items-center gap-1.5 mr-3">
          <span className="text-slate-500">每页</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="input !w-16 !py-1 text-xs"
          >
            {PAGE_SIZES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </label>

        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="btn btn-xs btn-ghost"
        >
          ‹ 上一页
        </button>

        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`dots-${i}`} className="px-1.5 text-slate-600">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`btn btn-xs ${p === page ? 'btn-primary' : 'btn-ghost'}`}
            >
              {p}
            </button>
          )
        )}

        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="btn btn-xs btn-ghost"
        >
          下一页 ›
        </button>
      </div>
    </div>
  )
}
