'use client'

import { LanguageSelector } from '@/components/language-selector'
import { useI18n } from '@/components/i18n-provider'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { authAPI, setApiKey, type AuthSession } from '@/lib/api'

interface AuthState {
  /** The logged-in user, or null when login is off or not yet established. */
  username: string | null
  role: 'administrator' | 'operator' | 'viewer' | null
  canManageAccess: boolean
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState>({ username: null, role: null, canManageAccess: false, logout: async () => {} })

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/**
 * Blocks the app behind a login form when the instance has user accounts.
 * The gate is presentation only — the API guard is what actually protects
 * every request. An unavailable session probe keeps protected content hidden
 * until the caller can be verified.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [probeFailed, setProbeFailed] = useState(false)
  const pendingProbe = useRef<Promise<void> | null>(null)

  const refresh = useCallback(() => {
    if (pendingProbe.current) return pendingProbe.current
    const probe = (async () => {
      try {
        setSession(await authAPI.session())
        setProbeFailed(false)
      } catch {
        setSession(null)
        setProbeFailed(true)
      } finally {
        pendingProbe.current = null
      }
    })()
    pendingProbe.current = probe
    return probe
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    // A resource-level 403 does not invalidate a valid session. Recheck it
    // without unmounting the app and restarting the requests that were denied.
    const denied = () => { void refresh() }
    window.addEventListener('camoufox-access-denied', denied)
    return () => window.removeEventListener('camoufox-access-denied', denied)
  }, [refresh])

  const logout = useCallback(async () => {
    await authAPI.logout().catch(() => undefined)
    await refresh()
  }, [refresh])

  if (!session && !probeFailed) {
    // Nothing until the probe answers: flashing the app to a logged-out user
    // would leak nothing (requests would 401) but looks broken.
    return null
  }

  if (session && !session.authenticated) {
    return session.user_auth_enabled
      ? <LoginScreen onLoggedIn={setSession} />
      : <ApiKeyScreen onLoggedIn={setSession} />
  }

  if (probeFailed) return <SessionUnavailable onRetry={refresh} />

  return (
    <AuthContext.Provider value={{ username: session?.username ?? null, role: session?.role ?? null, canManageAccess: session?.can_manage_access === true, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

function ApiKeyScreen({ onLoggedIn }: { onLoggedIn: (session: AuthSession) => void }) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const value = key.trim()
      const session = await authAPI.session(value)
      if (!session.authenticated) {
        setError(t('The API key is not valid. Check CPM_API_KEY and try again.'))
        setKey('')
        return
      }
      setApiKey(value)
      onLoggedIn(session)
    } catch {
      setError(t('Unable to verify access'))
    } finally {
      setBusy(false)
    }
  }

  return <div className="flex h-screen items-center justify-center">
    <form onSubmit={submit} className="panel flex w-[360px] flex-col gap-3 p-5">
      <LanguageSelector />
      <h1 className="text-[14px] font-semibold">{t('API key required')}</h1>
      <p className="text-ink-dim">{t('This instance requires the API key configured in CPM_API_KEY before you can open the app.')}</p>
      <label className="flex flex-col gap-1">
        <span className="text-ink-dim">{t('API key for this browser')}</span>
        <input type="password" className="field font-mono" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" autoFocus />
      </label>
      {error && <p className="text-danger" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>{busy ? t('Signing in…') : t('Continue')}</button>
    </form>
  </div>
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: (session: AuthSession) => void }) {
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLoggedIn(await authAPI.login(username, password))
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <form onSubmit={submit} className="panel flex w-[300px] flex-col gap-3 p-5">
        <LanguageSelector />
        <h1 className="text-[14px] font-semibold">{t('Sign in')}</h1>
        <label className="flex flex-col gap-1">
          <span className="text-ink-dim">{t('Username')}</span>
          <input
            className="field"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-dim">{t('Password')}</span>
          <input
            type="password"
            className="field"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !username || !password}>
          {busy ? t('Signing in…') : t('Sign in')}
        </button>
      </form>
    </div>
  )
}

function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  return <div className="p-6" role="alert"><p>{t('Unable to verify access')}</p><button className="btn btn-default mt-3" onClick={onRetry}>{t('Retry')}</button></div>
}
