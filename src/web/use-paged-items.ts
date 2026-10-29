import { useEffect, useState } from 'react';

/** A filter change resets the page; an explicit reveal can jump beyond it. */
export function usePagedItems<T>(items: readonly T[], pageSize: number, resetKey: string,
  target: T | null | undefined, keyOf: (item: T) => string | number) {
  const [position, setPosition] = useState<{ page: number; resetKey: string; target: T | null | undefined }>({ page: 0, resetKey, target: null });
  let page = position.resetKey === resetKey ? position.page : 0;
  if (target && position.target !== target) {
    const index = items.findIndex(item => keyOf(item) === keyOf(target));
    if (index >= 0) page = Math.floor(index / pageSize);
  }
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  page = Math.max(0, Math.min(page, pageCount - 1));
  useEffect(() => {
    setPosition(current => current.page === page && current.resetKey === resetKey && current.target === target
      ? current : { page, resetKey, target });
  }, [page, resetKey, target]);
  return { page, pageCount, total: items.length, pageSize,
    items: items.slice(page * pageSize, (page + 1) * pageSize),
    setPage: (next: number) => setPosition({ page: next, resetKey, target }),
  };
}
