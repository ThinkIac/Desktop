import test from 'node:test'
import assert from 'node:assert/strict'
import { RELEASES_URL, validateManifest } from '../electron/runtime-manager.mjs'

test('consulta as releases oficiais do Runtime', () => {
  assert.equal(RELEASES_URL, 'https://api.github.com/repos/ThinkIac/ThinkIac/releases')
})

test('aceita apenas um manifesto compatível', () => {
  const runtime = validateManifest({
    schemaVersion: 1,
    runtime: {
      version: '1.0.0', asset: 'thinkiac-runtime-1.0.0.zip',
      sha256: 'a'.repeat(64), entrypoint: 'index.js', readinessPath: '/__ready'
    }
  })
  assert.equal(runtime.version, '1.0.0')
  assert.throws(() => validateManifest({ schemaVersion: 1, runtime: { version: '../bad' } }))
})
