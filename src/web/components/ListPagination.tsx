export function ListPagination({ label, page, pageCount, total, pageSize, setPage }: {
  label: string; page: number; pageCount: number; total: number; pageSize: number; setPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return <nav className="actions" aria-label={label}>
    <button type="button" className="btn is-sm is-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
    <span aria-live="polite">{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}</span>
    <button type="button" className="btn is-sm is-ghost" disabled={page + 1 === pageCount} onClick={() => setPage(page + 1)}>Next</button>
  </nav>;
}
