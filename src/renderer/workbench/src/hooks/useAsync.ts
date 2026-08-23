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
  // Mirror of `data` readable inside the effect without re-triggering it, used
  // to distinguish the INITIAL load (no data yet → show the full-screen
  // skeleton) from a refetch (data present → keep the list mounted and silent
  // refresh in place, so the scroll position / open threads are not lost).
  // Without this, refetch set loading=true → pages render <Loading/> → the
  // whole list unmounts and the viewport snaps back to the top on every
  // dismiss / live-push tick ("点完操作就跳到顶部").
  const dataRef = useRef<T | null>(null)

  useEffect(() => {
    let cancelled = false
    const isInitial = dataRef.current === null
    if (isInitial) setLoading(true)
    setError(null)
    fnRef
      .current()
      .then((d) => {
        if (!cancelled) {
          dataRef.current = d
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
    setDataState((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T | null) => T)(prev) : next
      dataRef.current = resolved
      return resolved
    })
  }, [])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  return { data, loading, error, setData, refetch }
}
