 'use client'
import { useI18n } from './i18n-provider'
import { useState } from 'react'
import { Modal } from './modal'
import { profilesAPI, isStaleWrite, ApiRequestError, type Profile } from '@/lib/api'

export function ProfileQuickEdit({ profile, field, onClose, onSaved }: { profile: Profile; field: 'name' | 'notes'; onClose: () => void; onSaved: (profile: Profile) => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState(profile[field] ?? '')
  const [version, setVersion] = useState(profile.row_version)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [latest, setLatest] = useState<Profile | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const limit = field === 'name' ? 255 : 1000
  async function save() {
    if (busy || unavailable || value.length > limit || (field === 'name' && !value.trim())) return
    setBusy(true); setError('')
    try {
      const result = await profilesAPI.updateProfile(profile.id, { [field]: field === 'name' ? value.trim() : value || null, row_version: version })
      onSaved(result); onClose()
    } catch (err) {
      if (isStaleWrite(err)) {
        try { const current = await profilesAPI.getProfile(profile.id); setLatest(current); setVersion(current.row_version); setError(t('This profile changed. Compare the latest content before saving your changes again.')) }
        catch { setUnavailable(true); setError(t('Profile deleted or access changed.')) }
      } else { if (err instanceof ApiRequestError && [401, 403, 404].includes(err.status)) setUnavailable(true); setError(String(err)); }
    } finally { setBusy(false) }
  }
  return <Modal open title={field === 'name' ? t('Edit name') : t('Edit notes')} subtitle={profile.id} width={480} onClose={() => { if (!busy) onClose() }} footer={<><button className="btn btn-default" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="btn btn-primary" disabled={busy || unavailable || value.length > limit || (field === 'name' && !value.trim())} onClick={() => void save()}>{busy ? t('Saving…') : latest ? t('Save my changes again') : t('Save')}</button></>}>
    <div className="p-5" onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && (field === 'name' || event.ctrlKey)) { event.preventDefault(); void save() } }}>
      {field === 'name' ? <input aria-label={t('Name')} data-modal-autofocus className="field w-full" maxLength={limit} value={value} onChange={event => setValue(event.target.value)} /> : <textarea aria-label={t('Notes')} data-modal-autofocus className="field min-h-32 w-full" maxLength={limit} value={value} onChange={event => setValue(event.target.value)} />}
      <p className="mt-1 text-right text-ink-dim">{value.length}/{limit}</p>
      {error && <p className="mt-3 text-danger" role="alert">{error}</p>}
      {latest && <div className="mt-3 whitespace-pre-wrap"><p>{t('Latest content:')} {latest[field] || t('(empty)')}</p><button className="btn btn-default mt-2" onClick={() => { setValue(latest[field] ?? ''); setLatest(null); setError('') }}>{t('Load latest content')}</button></div>}
    </div>
  </Modal>
}
