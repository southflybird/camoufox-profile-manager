import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestRead, startRefreshLoop, type RefreshEnvironment } from '../src/lib/auto-refresh'

function unexpected(): never { throw new Error('Unexpected callback') }

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('manual refresh supersedes old reads; repeated background reads share the current request', async () => {
  const reader = new LatestRead<string>()
  const old = deferred<string>()
  const latest = deferred<string>()
  const accepted: string[] = []
  let oldSignal!: AbortSignal
  const first = reader.run(true, signal => { oldSignal = signal; return old.promise }, value => accepted.push(value), unexpected)
  assert.equal(reader.run(true, () => { throw new Error('duplicate read') }, unexpected, unexpected), first)
  const second = reader.run(false, () => latest.promise, value => accepted.push(value), unexpected)
  assert.ok(oldSignal.aborted)
  latest.resolve('new')
  assert.equal(await second, true)
  old.resolve('old')
  assert.equal(await first, false)
  assert.deepEqual(accepted, ['new'])
})

test('disposal aborts reads and prevents late success/error callbacks, including across remount', async () => {
  const reader = new LatestRead<string>()
  const old = deferred<string>()
  let signal!: AbortSignal
  const run = reader.run(false, value => { signal = value; return old.promise }, unexpected, unexpected)
  reader.dispose()
  assert.ok(signal.aborted)
  assert.equal(await reader.run(false, unexpected, unexpected, unexpected), false)
  reader.resume()
  const accepted: string[] = []
  assert.equal(await reader.run(false, async () => 'remounted', value => accepted.push(value), unexpected), true)
  old.reject(new Error('late response'))
  assert.equal(await run, false)
  assert.deepEqual(accepted, ['remounted'])
})

function environment() {
  let visible = true
  let listener: (() => void) | undefined
  const timers = new Map<() => void, number>()
  const env: RefreshEnvironment = {
    visible: () => visible,
    schedule: (callback, delay) => { timers.set(callback, delay); return () => { timers.delete(callback) } },
    subscribe: callback => { listener = callback; return () => { listener = undefined } },
  }
  return {
    env, timers,
    event: () => listener?.(),
    setVisible: (value: boolean) => { visible = value; listener?.() },
    next: async () => { const callback = timers.keys().next().value; assert.ok(callback); timers.delete(callback); callback(); await tick() },
    delay: () => [...timers.values()][0],
  }
}

test('polling backs off failed reads and resumes the normal interval after recovery', async () => {
  const clock = environment()
  let success = false
  const stop = startRefreshLoop(async () => success, 10_000, clock.env)
  assert.equal(clock.delay(), 10_000)
  for (const delay of [20_000, 40_000, 60_000, 60_000]) {
    await clock.next()
    assert.equal(clock.delay(), delay)
    assert.equal(clock.timers.size, 1)
  }
  success = true
  await clock.next()
  assert.equal(clock.delay(), 10_000)
  stop()
  assert.equal(clock.timers.size, 0)
})

test('hidden pages pause; focus refreshes immediately without overlap; cleanup removes future work', async () => {
  const clock = environment()
  const pending = deferred<boolean>()
  let calls = 0
  const stop = startRefreshLoop(() => { calls++; return pending.promise }, 10_000, clock.env)
  clock.setVisible(false)
  assert.equal(calls, 0)
  assert.equal(clock.timers.size, 0)
  clock.setVisible(true)
  assert.equal(calls, 1)
  clock.event()
  clock.event()
  assert.equal(calls, 1)
  assert.equal(clock.timers.size, 0)
  stop()
  pending.resolve(true)
  await tick()
  clock.event()
  assert.equal(calls, 1)
  assert.equal(clock.timers.size, 0)
})
