import type { Metadata } from 'next'

import { AppShell } from '@/components/app-shell'
import { I18nProvider } from '@/components/i18n-provider'
import { LoginGate } from '@/components/login-gate'
import { ToastProvider } from '@/components/toast'
import { APP_NAME } from '@/lib/distribution'
import './fonts.css'
import './globals.css'

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Antidetect browser profile management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <LoginGate>
            <ToastProvider>
              <AppShell>{children}</AppShell>
            </ToastProvider>
          </LoginGate>
        </I18nProvider>
      </body>
    </html>
  )
}
