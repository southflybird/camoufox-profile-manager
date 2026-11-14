import { version } from '../../package.json'

export const APP_NAME = 'CPM Custom'
export const APP_VERSION = version
export const CUSTOM_RELEASES = 'https://github.com/southflybird/camoufox-profile-manager/releases'

/** Accept only release pages belonging to this distribution. */
export function isReleaseLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'https://github.com' && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash &&
      /^\/southflybird\/camoufox-profile-manager\/releases\/tag\/custom-v\d+\.\d+\.\d+-r[1-9]\d*\/?$/.test(parsed.pathname)
  } catch { return false }
}
