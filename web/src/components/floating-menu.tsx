'use client'

import { useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Keep row actions outside the table's scroll and stacking contexts. */
export function FloatingMenu({ anchor, onClose, onKeyDown, children }: {
  anchor: HTMLButtonElement
  onClose: () => void
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => { closeRef.current = onClose }, [onClose])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      if (!anchor.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight) {
        closeRef.current()
        return
      }
      const margin = 8
      const gap = 4
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      const below = window.innerHeight - rect.bottom - margin - gap
      const above = rect.top - margin - gap
      const preferredTop = below >= height || below >= above ? rect.bottom + gap : rect.top - height - gap
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
      const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - height - margin))
      setPosition(current => current.left === left && current.top === top ? current : { left, top })
    }
    place()
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    observer.observe(anchor)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-labelledby={anchor.id || undefined}
      className="dialog-in fixed z-30 w-[164px] overflow-y-auto rounded-md border border-line bg-raised py-1 shadow-xl shadow-black/50"
      style={{ ...position, maxHeight: 'calc(100dvh - 16px)', maxWidth: 'calc(100vw - 16px)' }}
      onClick={event => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  )
}
