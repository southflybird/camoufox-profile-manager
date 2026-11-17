export interface DesktopAPI {
  get_preferences(user: string): Promise<Record<string, unknown>>
  set_preferences(user: string, value: Record<string, unknown>): Promise<void>
  read_login(): Promise<{ username: string; password: string } | null>
  save_login(username: string, password: string): Promise<void>
  clear_login(): Promise<void>
}
declare global { interface Window { pywebview?: { api?: DesktopAPI } } }
let bridgeProbe: Promise<void> | undefined
export async function desktopAPI(): Promise<DesktopAPI | undefined> {
  if (window.pywebview?.api) return window.pywebview.api
  // pywebview injects its bridge after the document loads.
  bridgeProbe ??= new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); window.removeEventListener('pywebviewready', done); resolve() }
    const timer = setTimeout(done, 1500)
    window.addEventListener('pywebviewready', done, { once: true })
  })
  await bridgeProbe
  return window.pywebview?.api
}
export async function readPreferences(user: string): Promise<Record<string, unknown>> {
  const api = await desktopAPI()
  if (api) return api.get_preferences(user)
  try { const value = JSON.parse(localStorage.getItem('cpm.preferences.' + user) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
export async function writePreferences(user: string, value: Record<string, unknown>) {
  const api = await desktopAPI()
  if (api) await api.set_preferences(user, value)
  else localStorage.setItem('cpm.preferences.' + user, JSON.stringify(value))
}
