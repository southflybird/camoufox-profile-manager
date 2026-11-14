import assert from 'node:assert/strict'
import test from 'node:test'
import { isReleaseLink } from '../src/lib/distribution'

test('custom download links reject upstream packages, foreign hosts and invalid tags', () => {
  assert.ok(isReleaseLink('https://github.com/southflybird/camoufox-profile-manager/releases/tag/custom-v0.7.0-r1'))
  for (const url of [
    'https://github.com/polyackiy/camoufox-profile-manager/releases/tag/v0.7.0',
    'https://github.com/southflybird/camoufox-profile-manager/releases/tag/v999.0.0',
    'https://github.com.evil.invalid/southflybird/camoufox-profile-manager/releases/tag/custom-v0.7.0-r1',
    'https://user:password@github.com/southflybird/camoufox-profile-manager/releases/tag/custom-v0.7.0-r1',
    'https://github.com/southflybird/camoufox-profile-manager/releases/tag/custom-v0.7.0-r1?redirect=official',
    'javascript:alert(1)',
  ]) assert.equal(isReleaseLink(url), false, url)
})
