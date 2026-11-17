import { Monitor } from 'lucide-react'
import { OS_LABELS } from '@/lib/api'

/** Small inline platform marks; independent of the host's emoji fonts. */
export function SystemIcon({ os }: { os?: string }) {
  const label = OS_LABELS[os ?? ''] ?? os ?? 'OS'
  const className = 'h-4 w-4 shrink-0 text-blue-500'

  if (os !== 'windows' && os !== 'macos' && os !== 'linux') {
    return <Monitor size={16} className={className} role="img" aria-label={label}><title>{label}</title></Monitor>
  }

  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" role="img" aria-label={label}>
      <title>{label}</title>
      {os === 'windows' && <path d="M2 4.8 10.5 3.6v7.6H2zm10-1.4L22 2v9.2H12zM2 12.8h8.5v7.6L2 19.2zm10 0h10V22l-10-1.4z" />}
      {os === 'macos' && <path d="M17.1 2c.2 1.4-.4 2.8-1.2 3.7-.9 1-2.3 1.7-3.6 1.6-.2-1.4.5-2.8 1.3-3.6.9-1 2.4-1.7 3.5-1.7ZM20.5 17.5c-.5 1.1-.8 1.6-1.4 2.5-.9 1.2-2.2 2.8-3.7 2.8-1.3 0-1.6-.9-3.4-.9-1.8 0-2.1.9-3.4.9-1.5 0-2.7-1.4-3.6-2.6C2.5 16.7 2 12.3 3.6 9.9c1.1-1.7 2.9-2.6 4.6-2.6 1.4 0 2.3.9 3.5.9 1.2 0 1.9-.9 3.6-.9 1.4 0 2.9.8 4 2.1-3.5 1.9-2.9 6.9 1.2 8.1Z" />}
      {os === 'linux' && <>
        <path d="M12 2c-3 0-4.5 2.5-4.5 6.2 0 1.8-1.1 3.4-2.1 5.2-1.4 2.5-1.2 5.1.4 6.2 1.6 1.1 3.8 1.4 6.2 1.4s4.6-.3 6.2-1.4c1.6-1.1 1.8-3.7.4-6.2-1-1.8-2.1-3.4-2.1-5.2C16.5 4.5 15 2 12 2Z" />
        <ellipse cx="12" cy="14.8" rx="4" ry="5" fill="var(--color-canvas)" />
        <ellipse cx="10.4" cy="7.1" rx="1" ry="1.4" fill="var(--color-canvas)" />
        <ellipse cx="13.6" cy="7.1" rx="1" ry="1.4" fill="var(--color-canvas)" />
        <path d="m9 9 3-1 3 1-3 2zM4 19l5 1-1 2H2zm11 1 5-1 2 3h-6z" />
      </>}
    </svg>
  )
}
