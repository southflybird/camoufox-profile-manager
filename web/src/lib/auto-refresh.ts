/** A single read owns its response; manual refreshes supersede background reads. */
export class LatestRead<T> {
  private active: { controller: AbortController; promise: Promise<boolean> } | null = null
  private disposed = false

  resume() { this.disposed = false }

  dispose() {
    this.disposed = true
    this.active?.controller.abort()
    this.active = null
  }

  run(background: boolean, read: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, reject: (error: unknown) => void): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (background && this.active) return this.active.promise
    this.active?.controller.abort()
    const request = { controller: new AbortController(), promise: Promise.resolve(false) }
    this.active = request
    request.promise = (async () => {
      try {
        const value = await read(request.controller.signal)
        if (this.active !== request || request.controller.signal.aborted) return false
        accept(value)
        return true
      } catch (error) {
        if (this.active === request && !request.controller.signal.aborted) reject(error)
        return false
      } finally {
        if (this.active === request) this.active = null
      }
    })()
    return request.promise
  }
}

export interface RefreshEnvironment {
  visible: () => boolean
  schedule: (callback: () => void, delay: number) => () => void
  subscribe: (callback: () => void) => () => void
}

const browserEnvironment = (): RefreshEnvironment => ({
  visible: () => document.visibilityState !== 'hidden',
  schedule: (callback, delay) => {
    const timer = window.setTimeout(callback, delay)
    return () => window.clearTimeout(timer)
  },
  subscribe: callback => {
    document.addEventListener('visibilitychange', callback)
    window.addEventListener('focus', callback)
    return () => {
      document.removeEventListener('visibilitychange', callback)
      window.removeEventListener('focus', callback)
    }
  },
})

/** Schedule after completion, pause when hidden, and back off on failed reads. */
export function startRefreshLoop(refresh: () => Promise<boolean>, interval = 10_000, environment: RefreshEnvironment = browserEnvironment()): () => void {
  let stopped = false
  let running = false
  let delay = interval
  let cancelTimer: (() => void) | undefined

  const schedule = () => {
    if (!stopped && environment.visible()) cancelTimer = environment.schedule(() => { void run() }, delay)
  }
  const run = async () => {
    cancelTimer?.()
    cancelTimer = undefined
    if (stopped || running || !environment.visible()) return
    running = true
    let success = false
    try { success = await refresh() } catch { /* Retry transient read failures. */ }
    finally {
      running = false
      delay = success ? interval : Math.min(delay * 2, 60_000)
      schedule()
    }
  }
  const unsubscribe = environment.subscribe(() => { void run() })
  schedule()
  return () => {
    stopped = true
    cancelTimer?.()
    unsubscribe()
  }
}
