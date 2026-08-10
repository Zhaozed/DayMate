import { useCallback, useEffect, useRef, useState } from 'react'

// Async data hook for workbench pages. Centralizes the loading / error / data
// triad so every page renders consistent skeletons and error banners instead
// of silently swallowing IPC rejections (Spec §18: surface clear user-facing
// errors). Live push channels merge in via `setData` (e.g. onActivityChanged).
export interface AsyncResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
  /** Replace or functional-update the cached data (for live pushes). */
  setData: (next: T | ((prev: T | null) => T)) => void
  /** Re-run the async function (force-refresh). */
  refetch: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncResult<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [nonce, setNonce] = useState(0)
  // Keep the latest fn without retriggering the effect on identity changes.
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fnRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setDataState(d)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // Re-run when declared deps change OR refetch bumps the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const setData = useCallback((next: T | ((prev: T | null) => T)) => {
    setDataState((prev) =>
      typeof next === 'function' ? (next as (p: T | null) => T)(prev) : next
    )
  }, [])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  return { data, loading, error, setData, refetch }
}
