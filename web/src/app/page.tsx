'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  Globe,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Tags,
  Cookie,
  Puzzle,
  Bookmark,
  Upload,
  Users,
} from 'lucide-react'

import { subscribeProfileEvents } from '@/lib/profile-events'
import { readPreferences, writePreferences } from '@/lib/desktop'
import { SystemIcon } from '@/components/system-icon'
import { FloatingMenu } from '@/components/floating-menu'
import { ProfileQuickEdit } from '@/components/profile-quick-edit'
import { useI18n } from '@/components/i18n-provider'
import { useAuth } from '@/components/login-gate'
import { ProfileSyncPanel, syncPhaseLabel } from '@/components/profile-sync-panel'
import { profileSyncAPI, type ProfileSyncBinding } from '@/lib/sync-api'
import { BrowserSetup } from '@/components/browser-setup'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog, Modal } from '@/components/modal'
import { ProfileForm } from '@/components/profile-form'
import { CookieTransfer } from '@/components/cookie-transfer'
import { ProfileExtensionsModal } from '@/components/profile-extensions-modal'
import { TemplateFromProfileModal } from '@/components/template-from-profile-modal'
import { ProfileTagsDialog } from '@/components/profile-tags-dialog'
import { SavedProfileViews } from '@/components/saved-profile-views'
import { BatchProfileOperations } from '@/components/batch-profile-operations'
import { MAX_BATCH_SIZE, type BatchTarget } from '@/lib/batch-queue'
import { DEFAULT_VIEW, profileViewQuery, readProfileView } from '@/lib/profile-views'
import { LatestRead, startRefreshLoop } from '@/lib/auto-refresh'
import { useToast } from '@/components/toast'
import {
  browsersAPI,
  ApiRequestError,
  browserCloseFailure,
  groupsAPI,
  hasGeography,
  profilesAPI,
  readProxyCheck,
  type Group,
  type Profile,
  type ProfileViewConfig,
  type ProxyCheckRecord,
} from '@/lib/api'

type SortKey = 'name' | 'id' | 'group' | 'os' | 'status' | 'last_used' | 'created_at'
type ProfileSnapshot = { profiles: Profile[]; groups: Group[] | null; bindings: ProfileSyncBinding[] | null }

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'id', label: 'ID' },
  { key: 'group', label: 'Group' },
  { key: 'status', label: 'Status' },
  { key: 'last_used', label: 'Last used' },
  { key: 'created_at', label: 'Created at' },
]

export default function ProfilesPage() {
  const { t, locale } = useI18n()
  const { canManageAccess, role, username } = useAuth()
  const can = (profile: Profile, permission: 'view' | 'edit' | 'launch' | 'export') => canManageAccess || profile.permissions?.[permission] === true
  const [syncFor, setSyncFor] = useState<Profile | 'available' | null>(null)
  const [syncBindings, setSyncBindings] = useState<ProfileSyncBinding[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ProfileViewConfig['status']>('all')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [tagFilters, setTagFilters] = useState<string[]>([])
  const [urlReady, setUrlReady] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('created_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const perPage = 25

  const [checkingProxies, setCheckingProxies] = useState<Set<string>>(new Set())
  const [proxyDiagnostics, setProxyDiagnostics] = useState<{ name: string; record: ProxyCheckRecord }[]>([])
  const [proxyDiagnosticsOpen, setProxyDiagnosticsOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [confirm, setConfirm] = useState<null | {
    title: string
    body: string
    label: string
    run: () => Promise<void>
  }>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [cookiesFor, setCookiesFor] = useState<Profile | null>(null)
  const [extensionsFor, setExtensionsFor] = useState<Profile | null>(null)
  const [templateFor, setTemplateFor] = useState<Profile | null>(null)
  const [tagsFor, setTagsFor] = useState<Profile[] | null>(null)
  const [batch, setBatch] = useState<{ action: 'launch' | 'close'; targets: BatchTarget[] } | null>(null)

  const [quickEdit, setQuickEdit] = useState<{ profile: Profile; field: 'name' | 'notes' } | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [preferencesReady, setPreferencesReady] = useState(false)
  const toast = useToast()
  const copy = (value: string) => { void navigator.clipboard.writeText(value).then(() => toast('ok', t('Copied')), () => toast('error', t('Copy failed'))) }
  const editButton = (profile: Profile, field: 'name' | 'notes') => can(profile, 'edit') && <button className="ml-2 inline-flex opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={field === 'name' ? t('Quick edit name') : t('Quick edit notes')} onClick={() => setQuickEdit({ profile, field })}><Pencil size={13} /></button>
  const cellStyle = (key: string) => hiddenColumns.includes(key) ? { display: 'none' } : undefined
  const exactTime = (value?: string | null) => {
    if (!value) return t('Never used')
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return value.replace('T', ' ').slice(0, 19)
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('sv-SE')
  }
  const importRef = useRef<HTMLInputElement>(null)
  const archiveRef = useRef<HTMLInputElement>(null)
  const updateEpoch = useRef(0)
  const profileReads = useRef(new LatestRead<ProfileSnapshot>())
  const runningReads = useRef(new LatestRead<string[]>())

  const refreshProfiles = useCallback((background: boolean) => { updateEpoch.current += 1; return profileReads.current.run(background, async signal => {
      // The API paginates; pull every page so sorting and search stay client-side
      // and instant. Guarded so a bad has_next can never spin forever.
      const collected: Profile[] = []
      for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
        const response = await profilesAPI.getProfiles({ page: pageNumber, per_page: 100 }, signal)
        collected.push(...response.profiles)
        if (!response.has_next) break
        if (pageNumber === 200) throw new Error('The profile collection is too large to load completely. No partial filter results are shown.')
      }
      signal.throwIfAborted()
      let bindings: ProfileSyncBinding[] | null = null
      if (canManageAccess) {
        try { const result = await profileSyncAPI.list(signal); if (!Array.isArray(result.profiles)) throw new Error('Invalid sync status'); bindings = result.profiles }
        catch { /* Keep existing bindings marked unknown if synchronization is unavailable. */ }
      }
      signal.throwIfAborted()
      const groups = await groupsAPI.list(signal).then(result => result.groups).catch(() => null)
      return { profiles: collected, bindings, groups }
    }, snapshot => {
      setProfiles(snapshot.profiles)
      const ids = new Set(snapshot.profiles.map(profile => profile.id))
      setSelected(current => new Set([...current].filter(id => ids.has(id))))
      if (snapshot.groups) setGroups(snapshot.groups)
      if (canManageAccess) setSyncBindings(current => snapshot.bindings ?? current.map(binding => ({ ...binding, phase: 'unknown' })))
      setError(null)
      setLoading(false)
    }, err => {
      // Access loss must still clear protected data. A transient background
      // failure must not erase rows, selections or an in-progress edit.
      const accessLost = err instanceof ApiRequestError && (err.status === 401 || err.status === 403)
      if (background && !accessLost) return
      if (accessLost) {
        setProxyDiagnostics([])
        setProxyDiagnosticsOpen(false)
        setProfiles([])
        setSelected(new Set())
        setEditing(null)
        setFormOpen(false)
        setBatch(null)
      }
      setError(String(err instanceof Error ? err.message : err))
      setLoading(false)
    }) }, [canManageAccess])
  const loadProfiles = useCallback(async () => { await refreshProfiles(false) }, [refreshProfiles])

  const refreshRunning = useCallback((background: boolean) => runningReads.current.run(background,
    async signal => (await browsersAPI.active(signal)).active_browsers.map(browser => browser.profile_id),
    ids => setRunning(new Set(ids)),
    () => { /* Best-effort status polling retains the previous state on failure. */ },
  ), [])
  const loadRunning = useCallback(async () => { await refreshRunning(false) }, [refreshRunning])

  useEffect(() => {
    const profiles = profileReads.current
    const browsers = runningReads.current
    profiles.resume()
    browsers.resume()
    void loadProfiles()
    void loadRunning()
    const stopProfiles = startRefreshLoop(() => refreshProfiles(true), 60_000)
    const pending = new Set<string>()
    let reset = false
    let active = false
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = async () => {
      if (active || disposed) return
      active = true
      try {
        while (!disposed && (reset || pending.size)) {
          const full = reset || pending.size > 20
          reset = false
          const ids = [...pending]; pending.clear()
          if (full) { await loadProfiles(); continue }
          // Stop older collection snapshots from replacing newer detail responses.
          profiles.dispose(); profiles.resume()
          const epoch = ++updateEpoch.current
          for (const id of ids) {
            try {
              const updated = await profilesAPI.getProfile(id)
              if (epoch !== updateEpoch.current) { reset = true; break }
              if (!disposed) setProfiles(current => current.some(item => item.id === id) ? current.map(item => item.id === id ? updated : item) : [...current, updated])
            } catch (error) {
              if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
                if (!disposed) { setProfiles(current => current.filter(item => item.id !== id)); setSelected(current => new Set([...current].filter(item => item !== id))) }
              } else reset = false
            }
          }
        }
      } finally { active = false }
    }
    const stopEvents = subscribeProfileEvents(id => {
      if (id) pending.add(id); else reset = true
      if (!timer) timer = setTimeout(() => { timer = undefined; void flush() }, 100)
    }, () => window.dispatchEvent(new CustomEvent('camoufox-access-denied')))
    const stopBrowsers = startRefreshLoop(() => refreshRunning(true), 5000)
    return () => {
      disposed = true
      clearTimeout(timer)
      stopEvents()
      stopProfiles()
      stopBrowsers()
      profiles.dispose()
      browsers.dispose()
    }
  }, [loadProfiles, loadRunning, refreshProfiles, refreshRunning])

  useEffect(() => {
    // Close on any click that is not on a trigger or inside an open menu.
    // Relying on stopPropagation in the trigger's React handler is not enough:
    // React delegates to its root container, so the document listener could
    // still fire and shut the menu in the same click that opened it.
    const close = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('[data-menu-trigger], [role="menu"]')) return
      setMenuFor(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  // Go back to the first page when the filters change. Adjusted during render
  // rather than in an effect: an effect would paint the new results clamped to
  // whatever page number survived, then snap to the first one, and React
  // documents this as the way to derive state from a change in props or state.
  const [filterForPage, setFilterForPage] = useState(() => ({ search, statusFilter, groupFilter, tagFilters: tagFilters.join('\0') }))
  if (filterForPage.search !== search || filterForPage.statusFilter !== statusFilter || filterForPage.groupFilter !== groupFilter || filterForPage.tagFilters !== tagFilters.join('\0')) {
    setFilterForPage({ search, statusFilter, groupFilter, tagFilters: tagFilters.join('\0') })
    setPage(1)
    setSelected(new Set())
  }

  const viewConfig = useMemo<ProfileViewConfig>(() => ({ search, status: statusFilter, group: groupFilter, tags: tagFilters, sort_key: sortKey, sort_direction: sortDir }), [search, statusFilter, groupFilter, tagFilters, sortKey, sortDir])
  function applyView(config: ProfileViewConfig, targetPage = 1) {
    setSearch(config.search); setStatusFilter(config.status); setGroupFilter(config.group); setTagFilters(config.tags)
    setSortKey(config.sort_key); setSortDir(config.sort_direction); setPage(targetPage); setSelected(new Set())
    setFilterForPage({ search: config.search, statusFilter: config.status, groupFilter: config.group, tagFilters: config.tags.join('\0') })
  }

  useEffect(() => {
    let cancelled = false
    const read = async () => {
      const prefs = await readPreferences(username ?? '__local__').catch(() => ({} as Record<string, unknown>))
      if (cancelled) return
      const params = new URLSearchParams(window.location.search)
      if (![...params.keys()].some(key => ['sort', 'direction', 'search', 'status', 'group', 'tags', 'tag', 'page'].includes(key))) {
        params.set('sort', typeof prefs.sort === 'string' ? prefs.sort : 'created_at')
        params.set('direction', prefs.direction === 'asc' ? 'asc' : 'desc')
      }
      const view = readProfileView(params); applyView(view.config, view.page)
      setHiddenColumns(Array.isArray(prefs.hidden) ? prefs.hidden.filter((item): item is string => typeof item === 'string') : [])
      setPreferencesReady(true); setUrlReady(true)
    }
    // Read only after mount: the bundled static page has no request URL.
    read()
    window.addEventListener('popstate', read)
    return () => { cancelled = true; window.removeEventListener('popstate', read) }
  }, [username])

  useEffect(() => {
    if (!preferencesReady) return
    const timer = setTimeout(() => { void writePreferences(username ?? '__local__', { sort: sortKey, direction: sortDir, hidden: hiddenColumns }).catch(() => undefined) }, 300)
    return () => clearTimeout(timer)
  }, [username, preferencesReady, sortKey, sortDir, hiddenColumns])


  const groupNames = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups],
  )

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = profiles.filter((profile) => {
      if (statusFilter !== 'all' && profile.status !== statusFilter) return false
      if (groupFilter === '__ungrouped__' && profile.group) return false
      if (groupFilter && groupFilter !== '__ungrouped__' && profile.group !== groupFilter) return false
      if (!tagFilters.every(tag => (profile.tags ?? []).includes(tag))) return false
      if (!needle) return true
      return (
        profile.name.toLowerCase().includes(needle) || profile.id.toLowerCase().includes(needle)
      )
    })

    const direction = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const compare = () => { switch (sortKey) {
        case 'id':
          return a.id.localeCompare(b.id) * direction
        case 'group':
          return (groupNames.get(a.group ?? '') ?? '').localeCompare(
            groupNames.get(b.group ?? '') ?? '',
          ) * direction
        case 'os':
          return (a.browser_settings?.os ?? '').localeCompare(b.browser_settings?.os ?? '') * direction
        case 'status':
          return a.status.localeCompare(b.status) * direction
        case 'created_at':
          return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * direction
        case 'last_used':
          if (!a.last_used || !b.last_used) return a.last_used ? -1 : b.last_used ? 1 : 0
          return (
            (new Date(a.last_used ?? 0).getTime() - new Date(b.last_used ?? 0).getTime()) * direction
          )
        default:
          return a.name.localeCompare(b.name) * direction
      } }
      return compare() || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)
    })
  }, [profiles, search, statusFilter, groupFilter, tagFilters, sortKey, sortDir, groupNames])

  // Offering the bulk clear when nothing selected would change is just noise.
  const selectedWithGeography = useMemo(
    () => profiles.filter((profile) => selected.has(profile.id) && hasGeography(profile)).length,
    [profiles, selected],
  )

  // Same rule as the clear above: a profile with no proxy has nothing to check.
  const selectedWithProxy = useMemo(
    () => profiles.filter((profile) => selected.has(profile.id) && profile.proxy_config).length,
    [profiles, selected],
  )

  const totalPages = Math.max(1, Math.ceil(visible.length / perPage))
  // Deleting the last rows of a page must not strand the user on an empty one.
  const currentPage = Math.min(page, totalPages)
  const pageRows = visible.slice((currentPage - 1) * perPage, currentPage * perPage)
  const availableTags = [...new Set(profiles.flatMap(profile => profile.tags ?? []))].sort()
  useEffect(() => {
    if (!urlReady || loading) return
    const query = profileViewQuery(viewConfig, currentPage, new URLSearchParams(window.location.search))
    const target = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', target)
  }, [viewConfig, currentPage, urlReady, loading])
  const allOnPageSelected = pageRows.length > 0 && pageRows.every((row) => selected.has(row.id))

  /** Close the row menu and hand focus back to the button that opened it.
   *
   * Focus moves first: removing the menu while one of its items still has focus
   * drops focus to <body>, and a refocus queued after the close races that reset.
   */
  function closeMenu(profileId: string) {
    document.querySelector<HTMLButtonElement>(`[data-menu-trigger="${profileId}"]`)?.focus({ preventScroll: true })
    setMenuFor(null)
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  async function withBusy(id: string, action: () => Promise<void>) {
    setBusy((current) => new Set(current).add(id))
    try {
      await action()
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  async function launch(profile: Profile) {
    await withBusy(profile.id, async () => {
      try {
        await profilesAPI.startProfile(profile.id)
        await Promise.all([loadRunning(), loadProfiles()])
      } catch (err) {
        toast('error', t('Could not launch browser'), String(err))
      }
    })
  }

  async function stop(profile: Profile) {
    await withBusy(profile.id, async () => {
      try {
        await profilesAPI.closeProfile(profile.id)
        await loadRunning()
      } catch (err) {
        toast('error', t('Could not close browser'), browserCloseFailure(err, t) ?? String(err))
      }
    })
  }

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  async function exportArchive(profile: Profile) {
    toast('info', t('Packing the profile…'), t('Cookies and history make this take a moment.'))
    try {
      const blob = await profilesAPI.exportArchive(profile.id)
      const safe = profile.name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '')
      download(blob, `${safe || profile.id}.camoufox.zip`)
      toast(
        'ok',
        t('Profile exported'),
        t('The archive holds session cookies and the proxy password — keep it like a password.'),
      )
    } catch (err) {
      toast('error', t('Could not export the profile'), String(err))
    }
  }

  async function importArchive(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const profile = await profilesAPI.importArchive(file)
      toast('ok', t('Profile imported'), profile.name)
      loadProfiles()
    } catch (err) {
      toast('error', t('Could not import the profile'), String(err))
    }
  }

  async function clone(profile: Profile) {
    try {
      await profilesAPI.cloneProfile(profile.id, t('{name} copy', { name: profile.name }))
      toast('ok', t('Profile cloned'), t('{name} copy', { name: profile.name }))
      loadProfiles()
    } catch (err) {
      toast('error', t('Could not clone profile'), String(err))
    }
  }

  /** Diagnostics have their own report; they never replace successful launch history. */
  async function checkProxy(profile: Profile): Promise<ProxyCheckRecord | null> {
    setCheckingProxies((current) => new Set(current).add(profile.id))
    try {
      const result = await profilesAPI.checkProxy(profile.id)
      const record: ProxyCheckRecord = {
        checked_at: result.checked_at ?? new Date().toISOString(),
        reachable: result.reachable,
        error: result.error,
        latency_ms: result.latency_ms,
        ip: result.location?.ip ?? null,
        country: result.location?.country ?? null,
        timezone: result.location?.timezone ?? null,
        findings: result.findings,
      }
      setProfiles((current) =>
        current.map((row) => (row.id === profile.id ? { ...row, proxy_check: record } : row)),
      )
      setProxyDiagnostics(current => [...current, { name: profile.name, record }])
      return record
    } catch (err) {
      toast('error', t('Could not check the proxy'), String(err))
      return null
    } finally {
      setCheckingProxies((current) => {
        const next = new Set(current)
        next.delete(profile.id)
        return next
      })
    }
  }

  /**
   * Check every selected profile that has a proxy.
   *
   * A few at a time: a hundred proxies opened at once is a hundred sockets and a
   * self-inflicted timeout, and rows landing one by one reads as progress where
   * a single wait reads as a hang.
   */
  async function checkSelectedProxies() {
    const queue = profiles.filter((profile) => selected.has(profile.id) && profile.proxy_config)
    if (!queue.length) return
    setProxyDiagnostics([])
    setProxyDiagnosticsOpen(true)

    // Counted before the workers start draining the queue.
    const total = queue.length
    // Three outcomes, not two: a check that never reached our own API left its
    // row untouched, and reporting that as success is how a summary ends up
    // contradicting the table it summarises.
    let clean = 0
    let flagged = 0
    let unchecked = 0
    const workers = Array.from({ length: Math.min(5, total) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const record = await checkProxy(next)
        if (!record) unchecked += 1
        else if (readProxyCheck(record).tone === 'ok') clean += 1
        else flagged += 1
      }
    })
    await Promise.all(workers)

    // Worded from the same rule the dots use, so a red row is never counted as
    // an answer just because the proxy replied.
    const parts = [
      flagged ? t('{count} need attention', { count: flagged }) : null,
      unchecked ? t('{count} could not be checked', { count: unchecked }) : null,
    ].filter(Boolean)

    if (parts.length)
      toast('error', parts.join(', '), t('Proxy check results'))
    else toast('ok', clean === 1 ? t('1 proxy is healthy') : t('{count} proxies are healthy', { count: clean }))
  }

  function askDelete(profile: Profile) {
    setConfirm({
      title: t('Move profile to Trash'),
      body: t('"{name}" and its browser data will move to Trash. You can restore them from the sidebar.', { name: profile.name }),
      label: t('Move to Trash'),
      run: async () => {
        await profilesAPI.deleteProfile(profile.id)
        toast('ok', t('Profile moved to Trash'), profile.name)
        setSelected((current) => {
          const next = new Set(current)
          next.delete(profile.id)
          return next
        })
        loadProfiles()
      },
    })
  }

  function askBulkDelete() {
    const count = selected.size
    setConfirm({
      title: count === 1 ? t('Move 1 profile to Trash') : t('Move {count} profiles to Trash', { count }),
      body: t('The selected profiles and their browser data will move to Trash. You can restore them from the sidebar.'),
      label: t('Move to Trash'),
      run: async () => {
        for (const id of selected) await profilesAPI.deleteProfile(id)
        toast('ok', count === 1 ? t('Moved 1 profile to Trash') : t('Moved {count} profiles to Trash', { count }))
        setSelected(new Set())
        loadProfiles()
      },
    })
  }

  /**
   * The profiles this exists for were all created the same way — with the
   * timezone and coordinates of a randomly chosen region — so the useful unit is
   * a selection, not one profile at a time. Only those that actually state a
   * location are named, so the confirmation says what will really change.
   */
  function askClearGeography() {
    const ids = profiles.filter((p) => selected.has(p.id) && hasGeography(p)).map((p) => p.id)
    setConfirm({
      title: ids.length === 1 ? t('Clear geography of 1 profile') : t('Clear geography of {count} profiles', { count: ids.length }),
      body:
        t("The stored timezone and coordinates are unset, so Camoufox derives both — and the WebRTC address — from where each profile's proxy comes out, as a profile created today does. Languages and the pinned machine are untouched."),
      label: t('Clear'),
      run: async () => {
        const result = await profilesAPI.clearGeography(ids)
        toast('ok', result.cleared.length === 1 ? t('Cleared 1 profile') : t('Cleared {count} profiles', { count: result.cleared.length }))
        setSelected(new Set())
        loadProfiles()
      },
    })
  }

  function askCloseAll() {
    setConfirm({
      title: t('Close all browsers'),
      body: running.size === 1 ? t('1 running browser will be closed.') : t('{count} running browsers will be closed.', { count: running.size }),
      label: t('Close all'),
      run: async () => {
        const result = await browsersAPI.closeAll()
        toast('ok', result.message)
        loadRunning()
      },
    })
  }

  async function runConfirmed() {
    if (!confirm) return
    const action = confirm
    setConfirm(null)
    try {
      await action.run()
    } catch (err) {
      toast('error', t('Action failed'), browserCloseFailure(err, t) ?? String(err))
    }
  }

  async function exportExcel() {
    setExportOpen(false)
    try {
      const blob = await profilesAPI.exportExcel()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'camoufox-profiles.xlsx'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast('ok', t('Exported to camoufox-profiles.xlsx'), t('The file contains proxy passwords in clear text.'))
    } catch (err) {
      toast('error', t('Export failed'), String(err))
    }
  }

  async function importExcel(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const result = await profilesAPI.importExcel(file)
      if (result.success) {
        toast('ok', t('Imported {count} profiles', { count: result.data?.created_count ?? 0 }))
        loadProfiles()
      } else {
        toast(
          'error',
          t('Import finished with errors'),
          (result.data?.errors ?? []).slice(0, 3).join('\n') || result.message,
        )
      }
    } catch (err) {
      toast('error', t('Import failed'), String(err))
    }
  }

  return (
    <>
      <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-line bg-canvas/85 px-5 backdrop-blur">
        <h1 className="text-[14px] font-semibold">{t('Profiles')}</h1>
        <span className="font-mono text-ink-faint">{visible.length}</span>

        <div className="relative ml-3 w-[240px]">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            className="field field-compact pl-7"
            placeholder={t('Search name or ID')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t('Search profiles')}
          />
        </div>

        <select
          className="field field-compact w-[132px]"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as ProfileViewConfig['status'])}
          aria-label={t('Filter by status')}
        >
          <option value="all">{t('All statuses')}</option>
          <option value="active">{t('Active')}</option>
          <option value="inactive">{t('Inactive')}</option>
          <option value="blocked">{t('Blocked')}</option>
          <option value="maintenance">{t('Maintenance')}</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          {canManageAccess && <button className="btn btn-default" onClick={() => setSyncFor('available')}>{t('Profiles from trusted devices')}</button>}
          {running.size > 0 && (canManageAccess || role === 'operator') && (
            <button className="btn btn-default" onClick={askCloseAll}>
              <Square size={12} fill="currentColor" />
              {t('Close {count} running', { count: running.size })}
            </button>
          )}
          {profiles.some(profile => can(profile, 'export')) && <button className="btn btn-ghost" onClick={() => setExportOpen(true)} title={t('Export to Excel')}>
            <Download size={14} />
          </button>}
          {canManageAccess && <>
          <button
            className="btn btn-ghost"
            onClick={() => importRef.current?.click()}
            title={t('Import from Excel')}
          >
            <Upload size={14} />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={importExcel}
            className="hidden"
          />
          <button
            className="btn btn-ghost"
            onClick={() => archiveRef.current?.click()}
            title={t('Import a profile archive')}
          >
            <PackageOpen size={14} />
          </button>
          <input
            ref={archiveRef}
            type="file"
            accept=".zip"
            onChange={importArchive}
            className="hidden"
          />
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus size={14} strokeWidth={2.5} />
            {t('New profile')}
          </button>
          </>}
        </div>
      </header>

      <section aria-label={t('Profile filters and saved views')} className="border-b border-line bg-surface px-5 py-3">
        {canManageAccess && <SavedProfileViews config={viewConfig} onApply={applyView} />}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="profile-group-filter" className="text-ink-dim">{t('Group')}</label>
          <select id="profile-group-filter" className="field field-compact w-[170px]" value={groupFilter ?? ''} onChange={event => setGroupFilter(event.target.value || null)}><option value="">{t('All groups')}</option><option value="__ungrouped__">{t('Ungrouped')}</option>{groupFilter && groupFilter !== '__ungrouped__' && !groups.some(group => group.id === groupFilter) && <option value={groupFilter}>{t('Unavailable group ({id})', { id: groupFilter })}</option>}{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
          <label htmlFor="profile-tag-filter" className="text-ink-dim">{t('Tags')}</label>
          <select id="profile-tag-filter" className="field field-compact w-[170px]" value="" disabled={tagFilters.length >= 20} onChange={event => { if (event.target.value && !tagFilters.includes(event.target.value)) setTagFilters(current => [...current, event.target.value]) }}><option value="">{t('Add tag filter')}</option>{availableTags.filter(tag => !tagFilters.includes(tag)).map(tag => <option key={tag} value={tag}>{tag}</option>)}</select>
          {tagFilters.map(tag => <button key={tag} className="btn btn-default h-7" onClick={() => setTagFilters(current => current.filter(value => value !== tag))} aria-label={t('Remove tag filter {tag}', { tag })}>{tag} ×</button>)}
          {tagFilters.length > 0 && <span className="text-[11px] text-ink-dim">{t('Match all selected tags')}</span>}
          <button className="btn btn-ghost ml-auto" onClick={() => applyView(DEFAULT_VIEW)}>{t('Clear filters')}</button>
        </div>
      </section>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-raised px-5 py-2">
          <span>{t('{count} selected', { count: selected.size })}</span>
          {(canManageAccess || role === 'operator') && <>
            <button className="btn btn-default h-7" disabled={selected.size > MAX_BATCH_SIZE || busy.size > 0} onClick={() => setBatch({ action: 'launch', targets: profiles.filter(profile => selected.has(profile.id) && can(profile, 'launch')).map(({ id, name }) => ({ id, name })) })}><Play size={13} aria-hidden="true" />{t('Launch selected')}</button>
            <button className="btn btn-default h-7" disabled={selected.size > MAX_BATCH_SIZE || busy.size > 0} onClick={() => setBatch({ action: 'close', targets: profiles.filter(profile => selected.has(profile.id) && can(profile, 'launch')).map(({ id, name }) => ({ id, name })) })}><Square size={13} aria-hidden="true" />{t('Stop selected')}</button>
            {selected.size > MAX_BATCH_SIZE && <span className="text-ink-dim">{t('Select up to {count} profiles per batch.', { count: MAX_BATCH_SIZE })}</span>}
          </>}
          <button className="btn btn-default h-7" onClick={() => setTagsFor(profiles.filter(profile => selected.has(profile.id)))}><Tags size={13} aria-hidden="true" />{t('Edit tags')}</button>
          {selectedWithProxy > 0 && (
            <button
              className="btn btn-default h-7"
              disabled={checkingProxies.size > 0}
              onClick={checkSelectedProxies}
            >
              <Globe size={13} />
              {checkingProxies.size > 0
                ? t('Checking… ({count})', { count: checkingProxies.size })
                : t('Check proxies ({count})', { count: selectedWithProxy })}
            </button>
          )}
          {selectedWithGeography > 0 && (
            <button className="btn btn-default h-7" onClick={askClearGeography}>
              <Globe size={13} />
              {t('Clear geography ({count})', { count: selectedWithGeography })}
            </button>
          )}
          <button className="btn btn-danger h-7" onClick={askBulkDelete}>
            <Trash2 size={13} />
            {t('Move to Trash')}
          </button>
          <button className="btn btn-ghost h-7" onClick={() => setSelected(new Set())}>
            {t('Clear')}
          </button>
        </div>
      )}

      {canManageAccess && !loading && !error && <BrowserSetup firstProfile={profiles.length === 0} onCreate={() => { setEditing(null); setFormOpen(true) }} />}

      <div className="flex items-center justify-end gap-3 p-2"><button className="btn btn-default" onClick={() => void loadProfiles()}>{t('Refresh')}</button><details className="relative"><summary className="cursor-pointer">{t('Visible columns')}</summary><div className="absolute right-0 z-30 min-w-40 rounded border border-line bg-raised p-3">{[['id',t('ID')],['group',t('Group')],['status',t('Status')],['last_used',t('Last used')],['created_at',t('Created at')],['tags',t('Tags')],['notes',t('Notes')],['ip',t('IP and location')]].map(([key,label]) => <label key={key} className="flex gap-2 py-1"><input type="checkbox" disabled={!preferencesReady} checked={!hiddenColumns.includes(key)} onChange={() => setHiddenColumns(current => current.includes(key) ? current.filter(item => item !== key) : [...current,key])} />{label}</label>)}</div></details></div>
      {error ? (
        <EmptyState
          icon={<Users size={18} />}
          title={t('Cannot reach the API')}
          body={error}
          action={
            <button className="btn btn-default" onClick={loadProfiles}>
              {t('Retry')}
            </button>
          }
        />
      ) : loading ? (
        <p className="px-5 py-8 text-ink-faint">{t('Loading…')}</p>
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={<Users size={18} />}
          title={t('No profiles yet')}
          body={canManageAccess ? t('A profile is one isolated browser identity — its own fingerprint, proxy, cookies and storage. Create one to get started.') : t('Ask an administrator to grant you access to profiles.')}
          action={canManageAccess && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus size={14} strokeWidth={2.5} />
              {t('Create your first profile')}
            </button>
          )}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search size={18} />}
          title={t('No matches')}
          body={t('No profile matches the current search and filter.')}
          action={
            <button
              className="btn btn-default"
              onClick={() => {
                applyView(DEFAULT_VIEW)
              }}
            >
              {t('Clear filters')}
            </button>
          }
        />
      ) : (
        <div data-profile-table-scroll className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.05em] text-ink-faint">
              <th className="w-9 py-2 pl-5">
                <input
                  type="checkbox"
                  className="accent-signal"
                  disabled={!canManageAccess && role !== 'operator'}
                  checked={allOnPageSelected}
                  aria-label={t('Select all on this page')}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      pageRows.forEach((row) =>
                        allOnPageSelected ? next.delete(row.id) : next.add(row.id),
                      )
                      return next
                    })
                  }
                />
              </th>
              {COLUMNS.map((column) => (
                <Fragment key={column.key}>{column.key === 'status' && <>              <th style={cellStyle('tags')} className="py-2 pr-4">{t('Tags')}</th>
              <th style={cellStyle('notes')} className="py-2 pr-4">{t('Notes')}</th>
              <th style={cellStyle('ip')} className="py-2 pr-4">{t('IP and location')}</th>
</>}<th style={cellStyle(column.key)} key={column.key} className="py-2 pr-4 font-medium">
                  <button
                    className="inline-flex items-center gap-1 hover:text-ink"
                    disabled={!preferencesReady}
                    onClick={() => toggleSort(column.key)}
                  >
                    {t(column.label)}
                    {sortKey === column.key &&
                      (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                </th></Fragment>
              ))}
              <th className="sticky right-0 w-[104px] bg-canvas py-2 pr-5" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((profile, index) => {
              const syncBinding = syncBindings.find(binding => binding.local_id === profile.id)
              const syncBlocked = !!syncBinding && (syncBinding.phase !== 'held' || syncBinding.lifecycle?.state === 'trashed' || syncBinding.local_trashed === true)
              const isRunning = running.has(profile.id)
              const isBusy = busy.has(profile.id)
              return (
                <tr
                  key={profile.id}
                  className="row-in group border-b border-line/60 bg-canvas hover:bg-surface"
                  style={{ animationDelay: `${Math.min(index, 12) * 12}ms` }}
                >
                  <td className="relative py-2.5 pl-5">
                    {/* Hairline marker: a running profile is visible at a glance. */}
                    {isRunning && (
                      <span className="absolute left-0 top-0 h-full w-[2px] bg-signal" aria-hidden />
                    )}
                    <input
                      type="checkbox"
                      className="accent-signal"
                      disabled={!can(profile, 'edit')}
                      checked={selected.has(profile.id)}
                      aria-label={t('Select {name}', { name: profile.name })}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (next.has(profile.id)) next.delete(profile.id)
                          else next.add(profile.id)
                          return next
                        })
                      }
                    />
                  </td>

                  <td className="py-2.5 pr-4 font-medium">
                    <div className="flex items-center gap-2">
                      <SystemIcon os={profile.browser_settings?.os} />
                      <span>{profile.name}</span>
                      {editButton(profile, 'name')}
                    </div>
                  </td>
                  <td style={cellStyle('id')} className="whitespace-nowrap py-2.5 pr-4 font-mono text-ink-faint">
                    <div className="flex items-center gap-2">
                      <span>{profile.id}</span>
                      <button title={t('Copy ID')} aria-label={t('Copy ID')} className="inline-flex shrink-0 hover:text-ink" onClick={() => copy(profile.id)}><Copy size={11} /></button>
                    </div>
                  </td>
                  <td style={cellStyle('group')} className="py-2.5 pr-4 text-ink-dim">{profile.group ? (groupNames.get(profile.group) ?? profile.group) : '—'}</td>
                  <td style={cellStyle('tags')} className="py-2.5 pr-4"><div className="flex gap-1">{profile.tags?.slice(0, 2).map(tag => <button key={tag} className="rounded border border-line px-1" onClick={() => setTagFilters([tag])}>{tag}</button>)}{(profile.tags?.length ?? 0) > 2 && <span title={profile.tags?.join(', ')}>+{profile.tags!.length - 2}</span>}</div></td>
                  <td style={cellStyle('notes')} className="py-2.5 pr-4"><span tabIndex={0} title={profile.notes ?? ''} className="inline-block max-w-[180px] truncate align-middle">{profile.notes || '—'}</span>{editButton(profile, 'notes')}</td>
                  <td style={cellStyle('ip')} className="py-2.5 pr-4 text-ink-dim" title={[
                    profile.last_browser_exit ? t(profile.last_browser_exit.legacy ? 'Last recorded exit: {time}' : 'Last successful launch: {time}', { time: exactTime(profile.last_browser_exit.checked_at) }) : '',
                    profile.last_browser_exit?.proxy_changed ? t('Proxy changed; the exit will update after the next successful launch.') : '',
                  ].filter(Boolean).join('\n')}>
                    {profile.last_browser_exit ? <>
                      <button className="font-mono" onClick={() => copy(profile.last_browser_exit!.ip)}>{profile.last_browser_exit.ip} <Copy size={11} className="inline" /></button>
                      <div>{profile.last_browser_exit.country || t('Unknown location')}</div>
                      {profile.last_browser_exit.proxy_changed && <div className="text-[11px] text-warn">{t('Proxy changed')}</div>}
                    </> : t('Not launched yet')}
                  </td>
                  <td style={cellStyle('status')} className="py-2.5 pr-4">
                    <StatusCell status={profile.status} running={isRunning} />
                    {syncBinding && <button className="mt-1 block text-left text-xs text-ink-dim underline underline-offset-2" onClick={() => setSyncFor(profile)}>{t(syncBinding.lifecycle?.state === 'trashed' ? 'Synchronized profile is in Trash' : syncPhaseLabel(syncBinding.phase))}</button>}
                  </td>
                  <td style={cellStyle('last_used')} className="py-2.5 pr-4 text-ink-dim whitespace-nowrap">{exactTime(profile.last_used)}</td>
                  <td style={cellStyle('created_at')} className="py-2.5 pr-4 text-ink-dim whitespace-nowrap">{exactTime(profile.created_at)}</td>


                  <td className="sticky right-0 bg-inherit py-2.5 pr-5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="btn btn-default h-7"
                        disabled={isBusy || !can(profile, 'launch') || (!isRunning && syncBlocked)}
                        onClick={() => (isRunning ? stop(profile) : launch(profile))}
                      >
                        {isRunning ? (
                          <>
                            <Square size={11} fill="currentColor" />
                            {t('Stop')}
                          </>
                        ) : (
                          <>
                            <Play size={11} fill="currentColor" />
                            {t('Run')}
                          </>
                        )}
                      </button>

                      <div className="relative">
                        <button
                          className="btn btn-ghost h-7 w-7 p-0"
                          aria-label={t('Actions for {name}', { name: profile.name })}
                          aria-haspopup="menu"
                          aria-expanded={menuFor === profile.id}
                          id={`profile-actions-${profile.id}`}
                          data-menu-trigger={profile.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            setMenuAnchor(event.currentTarget)
                            setMenuFor(menuFor === profile.id ? null : profile.id)
                          }}
                        >
                          <Ellipsis size={15} />
                        </button>

                        {menuFor === profile.id && menuAnchor && (
                          <FloatingMenu
                            anchor={menuAnchor}
                            onClose={() => closeMenu(profile.id)}
                            onKeyDown={(event) => {
                              const items = Array.from(
                                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                  '[role="menuitem"]',
                                ),
                              )
                              const index = items.indexOf(document.activeElement as HTMLButtonElement)
                              if (event.key === 'Escape') {
                                event.stopPropagation()
                                closeMenu(profile.id)
                              } else if (event.key === 'ArrowDown') {
                                event.preventDefault()
                                items[(index + 1) % items.length]?.focus()
                              } else if (event.key === 'ArrowUp') {
                                event.preventDefault()
                                items[(index - 1 + items.length) % items.length]?.focus()
                              }
                            }}
                          >
                            <MenuItem
                              icon={<Pencil size={13} />}
                              allowed={can(profile, 'edit')} label={t('Edit')}
                              onClick={() => {
                                setEditing(profile)
                                setFormOpen(true)
                                closeMenu(profile.id)
                              }}
                            />
                            <MenuItem
                              icon={<Copy size={13} />}
                              allowed={canManageAccess} label={t('Duplicate')}
                              onClick={() => {
                                clone(profile)
                                closeMenu(profile.id)
                              }}
                            />
                            <MenuItem
                              icon={<Globe size={13} />}
                              allowed={can(profile, 'edit')} label={t('Check proxy')}
                              onClick={() => {
                                // The set holds ids, not a count, so a second
                                // check of the same row would clear the first
                                // one's "Checking…" when it finished.
                                if (!checkingProxies.has(profile.id)) {
                                  setProxyDiagnostics([])
                                  setProxyDiagnosticsOpen(true)
                                  void checkProxy(profile)
                                }
                                closeMenu(profile.id)
                              }}
                            />
                            <MenuItem icon={<Globe size={13} />} allowed={canManageAccess} label={t('Device synchronization')} onClick={() => { setSyncFor(profile); closeMenu(profile.id) }} />
                            <MenuItem icon={<Cookie size={13} />} allowed={can(profile, 'edit') || can(profile, 'export')} label={t('Cookies')} onClick={() => { setCookiesFor(profile); closeMenu(profile.id) }} />
                            <MenuItem icon={<Bookmark size={13} />} allowed={canManageAccess} label={t('Save as template')} onClick={() => { setTemplateFor(profile); closeMenu(profile.id) }} />
                            <MenuItem icon={<Puzzle size={13} />} allowed={can(profile, 'edit')} label={t('Extensions')} onClick={() => { setExtensionsFor(profile); closeMenu(profile.id) }} />
                            <MenuItem
                              icon={<PackageOpen size={13} />}
                              allowed={can(profile, 'export')} label={t('Export…')}
                              onClick={() => {
                                exportArchive(profile)
                                closeMenu(profile.id)
                              }}
                            />
                            <MenuItem
                              icon={<Trash2 size={13} />}
                              allowed={can(profile, 'edit')} label={t('Move to Trash')}
                              danger
                              onClick={() => {
                                askDelete(profile)
                                closeMenu(profile.id)
                              }}
                            />
                          </FloatingMenu>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-3 text-ink-dim">
          <span>
            {t('{start}–{end} of {count}', { start: (currentPage - 1) * perPage + 1, end: Math.min(currentPage * perPage, visible.length), count: visible.length })}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost h-7 w-7 p-0"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              aria-label={t('Previous page')}
            >
              <ChevronLeft size={15} />
            </button>
            <span className="px-2 font-mono">
              {currentPage} / {totalPages}
            </span>
            <button
              className="btn btn-ghost h-7 w-7 p-0"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
              aria-label={t('Next page')}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}

      {cookiesFor && <CookieTransfer profile={cookiesFor} onClose={() => setCookiesFor(null)} onChanged={loadProfiles} />}
      {templateFor && <TemplateFromProfileModal profile={templateFor} onClose={() => setTemplateFor(null)} onSaved={loadProfiles} />}
      {syncFor && <ProfileSyncPanel profile={syncFor === 'available' ? null : syncFor} running={syncFor !== 'available' && running.has(syncFor.id)} onClose={() => setSyncFor(null)} onSaved={loadProfiles} />}
      {extensionsFor && <ProfileExtensionsModal profile={extensionsFor} onClose={() => setExtensionsFor(null)} onSaved={loadProfiles} />}
      {tagsFor && <ProfileTagsDialog profiles={tagsFor} onClose={() => setTagsFor(null)} onUpdated={updated => { setProfiles(current => current.map(profile => updated.find(item => item.id === profile.id) ?? profile)); setSelected(new Set()) }} />}
      {batch && <BatchProfileOperations action={batch.action} targets={batch.targets} onClose={() => setBatch(null)} onUpdated={async () => { await Promise.all([loadRunning(), loadProfiles()]) }} />}

      <Modal open={proxyDiagnosticsOpen} title={t('Proxy check results')} onClose={() => setProxyDiagnosticsOpen(false)}>
        <p className="mb-4 text-ink-dim">{t('Proxy checks do not change the last browser exit.')}</p>
        {checkingProxies.size > 0 && <p className="mb-3 text-ink-dim">{t('Checking… ({count})', { count: checkingProxies.size })}</p>}
        {proxyDiagnostics.map(({ name, record }, index) => {
          const health = readProxyCheck(record, locale)
          return <div key={index} className="mb-4 rounded border border-line p-3">
            <p className="font-medium">{name}</p>
            <p className={health.tone === 'ok' ? 'text-ok' : health.tone === 'danger' ? 'text-danger' : 'text-warn'}>{health.label}</p>
            {record.ip && <p className="font-mono">{record.ip} · {record.country || t('Unknown location')}</p>}
            <p className="mt-2 whitespace-pre-line text-ink-dim">{health.detail}</p>
          </div>
        })}
      </Modal>
      {quickEdit && <ProfileQuickEdit profile={quickEdit.profile} field={quickEdit.field} onClose={() => setQuickEdit(null)} onSaved={updated => { updateEpoch.current += 1; profileReads.current.dispose(); profileReads.current.resume(); setProfiles(current => current.map(item => item.id === updated.id ? updated : item)) }} />}
      <ProfileForm
        open={formOpen}
        profile={editing}
        groups={groups}
        onClose={() => setFormOpen(false)}
        onSaved={updated => {
          if (!updated) { void loadProfiles(); return }
          updateEpoch.current += 1; profileReads.current.dispose(); profileReads.current.resume()
          setProfiles(current => current.some(item => item.id === updated.id) ? current.map(item => item.id === updated.id ? updated : item) : [...current, updated])
          if ((search && !updated.name.toLowerCase().includes(search.toLowerCase()) && !updated.id.includes(search)) || (groupFilter && updated.group !== groupFilter && groupFilter !== '__ungrouped__') || (statusFilter !== 'all' && statusFilter !== updated.status) || !tagFilters.every(tag => updated.tags?.includes(tag))) toast('ok', t('Profile saved; current filters may hide it.'))
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        confirmLabel={confirm?.label}
        destructive={confirm?.label === 'Delete'}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />

      <Modal
        open={exportOpen}
        title={t('Export to Excel')}
        onClose={() => setExportOpen(false)}
        width={440}
        footer={
          <>
            <button className="btn btn-default" onClick={() => setExportOpen(false)}>
              {t('Cancel')}
            </button>
            <button className="btn btn-primary" onClick={exportExcel}>
              {t('Export')}
            </button>
          </>
        }
      >
        <p className="text-ink-dim">
          {t('The spreadsheet includes every profile setting so it can be imported back — including proxy passwords in clear text. Store the file somewhere you would keep the passwords themselves.')}
        </p>
      </Modal>
    </>
  )
}

/** The configured proxy, and under it the last answer it gave.
 *
 * Two lines rather than a column of its own: the table is already wide, and the
 * second line only exists once there is something to say, so a list nobody has
 * checked looks exactly as it did before.
 */
function StatusCell({ status, running }: { status: string; running: boolean }) {
  const { t } = useI18n()
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-signal">
        <span className="signal-pulse h-1.5 w-1.5 rounded-full bg-signal" />
        {t('Running')}
      </span>
    )
  }
  const tone =
    status === 'blocked' ? 'bg-danger' : status === 'maintenance' ? 'bg-ink-dim' : 'bg-ink-faint'
  return (
    <span className="inline-flex items-center gap-1.5 capitalize text-ink-dim">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {t(status)}
    </span>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  autoFocus,
  allowed = true,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  autoFocus?: boolean
  allowed?: boolean
}) {
  if (!allowed) return null
  return (
    <button
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-line focus:bg-line ${
        danger ? 'text-danger' : 'text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
