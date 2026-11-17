'use client'

import { useCallback, useEffect, useState } from 'react'
import { Archive, Download, ExternalLink, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Modal } from '@/components/modal'
import { CUSTOM_RELEASES, isReleaseLink } from '@/lib/distribution'
import { useToast } from '@/components/toast'
import { recoveryAPI, systemAPI, type AppUpdate, type BackupInfo, type BackupCleanupStatus } from '@/lib/api'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** The download is exposed only after the server has completed its backup. */
export function UpdateSettings() {
  const { t } = useI18n()
  const [update, setUpdate] = useState<AppUpdate | null>(null)
  const [checking, setChecking] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<{ url: string; count: number } | null>(null)
  const [preview, setPreview] = useState(false)
  async function check() {
    setChecking(true); setError(null); setPrepared(null)
    try {
      const result = await systemAPI.updates(preview)
      setUpdate(result)
      if (result.error) setError(result.error)
    } catch (err) { setError(message(err)) }
    finally { setChecking(false) }
  }
  async function prepare() {
    setPreparing(true); setError(null)
    try {
      const result = await systemAPI.prepareUpdate(preview)
      if (!isReleaseLink(result.release_url)) throw new Error(t('The server returned an unverified release link. Check for updates again.'))
      setPrepared({ url: result.release_url, count: result.backup_count })
      window.dispatchEvent(new Event('camoufox-backups-changed'))
    } catch (err) { setError(message(err)) }
    finally { setPreparing(false) }
  }

  return <section aria-labelledby="updates-title">
    <h2 id="updates-title" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{t('App updates')}</h2>
    <div className="panel p-4">
      <p className="mb-3 text-ink-dim">{t('CPM Custom uses manual updates from its own release page. Keep a complete data backup before updating.')}</p>
      <a className="btn btn-default mb-3" href={CUSTOM_RELEASES} target="_blank" rel="noopener noreferrer">{t('Custom release downloads')}<ExternalLink size={12} aria-hidden="true" /></a>
      <p className="font-medium">{t('Check for a new desktop release')}</p>
      <p className="mt-1 text-ink-dim">{t('Close all running profiles before updating. We create a backup of every profile before making the release download available. Install the downloaded release to update the app.')}</p>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-ink-dim"><input type="checkbox" checked={preview} disabled={checking || preparing} onChange={event => { setPreview(event.target.checked); setUpdate(null); setPrepared(null); setError(null) }} />{t('Include preview releases (opt-in)')}</label>
      {preview && <p className="text-ink-dim">{t('Preview installers may be unsigned and are intended for testing. Stable remains the default channel.')}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-default" disabled={checking || preparing} onClick={check}>{checking && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{checking ? t('Checking…') : t('Check for updates')}</button>
        {update?.available && !prepared && !error && <button className="btn btn-primary" disabled={preparing || checking} onClick={prepare}><Archive size={13} aria-hidden="true" />{preparing ? t('Creating backups…') : t('Back up and prepare update')}</button>}
      </div>
      {update && !error && <p className="mt-3 text-ink-dim" role="status">{update.available ? t('Version {latest} is available. You have {current}.', { latest: update.latest_version, current: update.current_version }) : t('You are up to date ({version}).', { version: update.current_version })}</p>}
      {error && <p className="mt-3 text-danger" role="alert">{t(error)}</p>}
      {prepared && <div className="mt-3 rounded-md border border-line bg-raised p-3">
        <p role="status">{t('{count} profile backups created. Your release is ready to download.', { count: prepared.count })}</p>
        <a className="btn btn-primary mt-3" href={prepared.url} target="_blank" rel="noopener noreferrer"><Download size={13} aria-hidden="true" />{t('Open release downloads')}<ExternalLink size={12} aria-hidden="true" /></a>
        <p className="mt-2 text-ink-dim">{t('Download the asset for your operating system. Backups remain in Settings after the update.')}</p>
      </div>}
      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer font-medium">{t('Update recovery')}</summary>
        <p className="mt-2 text-ink-dim">{t('Downgrading requires the matching application and complete data backup. Profile archives alone are not a complete rollback.')}</p>
      </details>
    </div>
  </section>
}

export function BackupSettings() {
  const { t, locale } = useI18n()
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [restore, setRestore] = useState<BackupInfo | null>(null)
  const [deleting, setDeleting] = useState<BackupInfo | null>(null)
  const [policy, setPolicy] = useState({ retention: 2, interval_hours: 24 })
  const [cleanup, setCleanup] = useState<BackupCleanupStatus | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState(false)
  const toast = useToast()
  const load = useCallback(async () => {
    try { const data = await recoveryAPI.backupOverview(); setBackups(data.backups); setPolicy({ retention: data.retention ?? 2, interval_hours: data.interval_hours ?? 24 }); setError(null) }
    catch (err) { setError(message(err)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    // The request completes asynchronously; this effect starts the initial API read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    window.addEventListener('camoufox-backups-changed', load)
    return () => window.removeEventListener('camoufox-backups-changed', load)
  }, [load])
  useEffect(() => {
    if (cleanup?.state !== 'running') return
    const timer = window.setInterval(() => {
      recoveryAPI.cleanupStatus().then(status => {
        setCleanup(status)
        if (status.state !== 'running') { setBusy(false); void load() }
      }).catch(err => { setError(message(err)); setBusy(false); setCleanup(null) })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [cleanup?.state, load])
  async function organize(execute: boolean) {
    setBusy(true); setError(null); setCleanupPreview(!execute)
    try { setCleanup(await recoveryAPI.cleanup(execute)) }
    catch (err) { setError(message(err)); setBusy(false) }
  }
  async function create() {
    setBusy(true); setError(null); setResult(null)
    try {
      const response = await recoveryAPI.createBackup()
      await load()
      setResult([t('{count} backups created.', { count: response.backups.length }), response.reused?.length ? t('{count} profiles already have an up-to-date backup.', { count: response.reused.length }) : '', response.skipped.length ? t('{count} profiles skipped: {details}', { count: response.skipped.length, details: response.skipped.map(item => `${item.profile_id}: ${item.reason}`).join('; ') }) : ''].filter(Boolean).join(' '))
    } catch (err) { setError(message(err)) }
    finally { setBusy(false) }
  }
  async function restoreBackup() {
    if (!restore || busy) return
    setBusy(true); setError(null)
    try {
      const profile = await recoveryAPI.restoreBackup(restore.id)
      toast('ok', t('Backup restored as a new profile'), t('{name} is available in Profiles.', { name: profile.name }))
      setRestore(null)
    } catch (err) { setError(message(err)); setRestore(null) }
    finally { setBusy(false) }
  }
  async function deleteBackup() {
    if (!deleting || busy) return
    setBusy(true); setError(null); setResult(null)
    try {
      await recoveryAPI.deleteBackup(deleting.id)
      setBackups(current => current.filter(backup => backup.id !== deleting.id))
      setDeleting(null)
      setResult(t('Backup deleted'))
    } catch (err) { setError(message(err)) }
    finally { setBusy(false) }
  }

  return <section aria-labelledby="backups-title">
    <h2 id="backups-title" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{t('Profile backups')}</h2>
    <div className="panel overflow-hidden">
      <div className="p-4">
        <p className="text-ink-dim">{t('Backups include profile settings and browser data. Close running profiles before backing up; running profiles are skipped. Restoring creates a new profile with a new ID and preserves the current profile.')}</p>
        <p className="mt-2 text-ink-dim">{t('Backups are not encrypted. They can contain signed-in sessions and proxy passwords; keep them private.')}</p>
        <p className="mt-2 text-ink-dim">{t('Keep {count} routine versions and one before-operation version. Check changed, closed profiles every {hours} hours. Unchanged content is reused.', { count: policy.retention, hours: policy.interval_hours })}</p>
        <div className="mt-3 flex gap-2">
          <button className="btn btn-default" disabled={busy || loading} onClick={create}><Archive size={13} aria-hidden="true" />{busy ? t('Working…') : t('Back up profiles')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={load}>{t('Refresh')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => organize(false)}>{t('Organize backups and default extension data')}</button>
        </div>
        {cleanup && <div className="mt-3 text-ink-dim" role="status">
          <p>{cleanup.state === 'running' ? t('Working…') : t('Cleanup: {count} processed; {kb} KB released.', { count: cleanup.processed ?? 0, kb: Math.round((cleanup.released_bytes ?? 0) / 1024) })}</p>
          {cleanupPreview && cleanup.state === 'complete' && <><p>{t('{count} cleanup candidates; approximately {kb} KB can be released.', { count: cleanup.candidates ?? 0, kb: Math.round((cleanup.estimated_bytes ?? 0) / 1024) })}</p><p>{t('This removes confirmed default uBlock data and old backup versions. User-installed extensions and website storage are kept. MyDrive archives must be organized in MyDrive.')}</p><button className="btn btn-default mt-2" disabled={busy} onClick={() => organize(true)}>{t('Run cleanup')}</button></>}
          {[...(cleanup.skipped ?? []), ...(cleanup.failed ?? [])].map((item, index) => <p key={`${item.id}-${index}`}>{item.id}: {item.reason}</p>)}
        </div>}
        {result && <p className="mt-3 break-words text-ink-dim" role="status">{result}</p>}
        {error && <p className="mt-3 break-words text-danger" role="alert">{t(error)}</p>}
      </div>
      {loading ? <p className="border-t border-line px-4 py-3 text-ink-dim" role="status">{t('Loading backups…')}</p> : backups.length === 0 ? <p className="border-t border-line px-4 py-3 text-ink-dim">{t('No backups yet.')}</p> :
        <ul className="max-h-[360px] divide-y divide-line overflow-y-auto border-t border-line">{backups.map(backup => <li key={backup.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1"><p className="break-words font-medium">{backup.profile_name}</p><p className="text-ink-dim">{new Date(backup.created_at).toLocaleString(locale)} · {Math.max(1, Math.round(backup.size_bytes / 1024))} KB · {backup.uses ? Object.keys(backup.uses).map(use => t(use === 'checkpoint' ? 'Before operation' : 'Routine backup')).join(' · ') : t(backup.reason)}</p></div>
          <button className="btn btn-default shrink-0" disabled={busy} onClick={() => setRestore(backup)} aria-label={t('Restore backup of {name} from {date}', { name: backup.profile_name, date: new Date(backup.created_at).toLocaleString(locale) })}><RotateCcw size={13} aria-hidden="true" />{t('Restore')}</button>
          <button className="btn btn-danger shrink-0" disabled={busy} onClick={() => { setError(null); setDeleting(backup) }} aria-label={t('Delete backup of {name} from {date}', { name: backup.profile_name, date: new Date(backup.created_at).toLocaleString(locale) })}><Trash2 size={13} aria-hidden="true" />{t('Delete')}</button>
        </li>)}</ul>}
    </div>
    <Modal open={!!restore} title={t('Restore backup as a new profile')} onClose={() => { if (!busy) setRestore(null) }} width={460} footer={<>
      <button className="btn btn-default" disabled={busy} onClick={() => setRestore(null)}>{t('Cancel')}</button>
      <button className="btn btn-primary" disabled={busy} onClick={restoreBackup}>{busy ? t('Restoring…') : t('Restore as new profile')}</button>
    </>}><p className="text-ink-dim">{restore && t('Restore {name} from {date}? A separate profile with its saved cookies, storage and fingerprint will be created. Your current profiles and this backup are preserved.', { name: restore.profile_name, date: new Date(restore.created_at).toLocaleString(locale) })}</p></Modal>
    <Modal open={!!deleting} title={t('Delete backup')} onClose={() => { if (!busy) setDeleting(null) }} width={460} footer={<>
      <button className="btn btn-default" disabled={busy} onClick={() => setDeleting(null)}>{t('Cancel')}</button>
      <button className="btn btn-danger" disabled={busy} onClick={deleteBackup}>{busy ? t('Deleting…') : t('Delete permanently')}</button>
    </>}>
      <p className="text-ink-dim">{deleting && t('Permanently delete the backup of {name} from {date}? This cannot be undone. Your current profiles and other backups are preserved.', { name: deleting.profile_name, date: new Date(deleting.created_at).toLocaleString(locale) })}</p>
      {error && <p className="mt-3 break-words text-danger" role="alert">{t(error)}</p>}
    </Modal>
  </section>
}
