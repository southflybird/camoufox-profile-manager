import assert from 'node:assert/strict'
import test from 'node:test'
import { authAPI, getApiKey, setApiKey } from '../src/lib/api'

test('blocked local storage does not prevent cookie session verification', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get localStorage() { throw new Error('Storage disabled') } },
  })
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], undefined)
    return Response.json({ authenticated: true, role: 'administrator', can_manage_access: true })
  }
  try {
    assert.equal(getApiKey(), '')
    assert.equal((await authAPI.session()).can_manage_access, true)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a verified API key works with blocked storage; trial keys never replace it', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get localStorage() { throw new Error('Storage disabled') } },
  })
  const sent: string[] = []
  globalThis.fetch = async (_input, init) => {
    sent.push((init?.headers as Record<string, string>)['X-API-Key'])
    return Response.json({ authenticated: true, role: 'administrator' })
  }
  try {
    assert.doesNotThrow(() => setApiKey('verified-test-key'))
    await authAPI.session()
    await authAPI.session('trial-test-key')
    assert.equal(getApiKey(), 'verified-test-key')
    assert.deepEqual(sent, ['verified-test-key', 'trial-test-key'])
    assert.doesNotThrow(() => setApiKey(''))
    assert.equal(getApiKey(), '')
  } finally {
    setApiKey('')
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
