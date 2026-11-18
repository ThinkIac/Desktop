import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { RELEASES_URL, latestRuntimeRelease, validateManifest, waitForReady } from '../electron/runtime-manager.mjs'

test('consulta as releases oficiais do Runtime', () => {
  assert.equal(RELEASES_URL, 'https://api.github.com/repos/ThinkIac/ThinkIac/releases')
})

const windowsManifest = {
  schemaVersion: 2,
  runtime: {
    version: '1.0.0', entrypoint: 'index.js', readinessPath: '/__ready',
    platforms: {
      'win32-x64': { asset: 'thinkiac-runtime-win-x64-1.0.0.zip', sha256: 'a'.repeat(64), nodeEntrypoint: 'node/node.exe' },
    },
  },
}

test('aceita apenas um manifesto compatível', () => {
  const runtime = validateManifest(windowsManifest)
  assert.equal(runtime.version, '1.0.0')
  assert.throws(() => validateManifest({ schemaVersion: 1, runtime: { version: '../bad' } }))
})

test('procura uma release Windows depois de uma release de código-fonte', async (t) => {
  const release = (version, archive) => ({
    assets: [
      { name: 'runtime-manifest.json', browser_download_url: `https://example.test/${version}` },
      ...(archive ? [{ name: archive, browser_download_url: 'https://example.test/runtime.zip' }] : []),
    ],
  })
  const archive = windowsManifest.runtime.platforms['win32-x64'].asset
  const responses = new Map([
    [`${RELEASES_URL}?per_page=30&page=1`, [release('source'), release('windows', archive)]],
    ['https://example.test/source', { schemaVersion: 1 }],
    ['https://example.test/windows', windowsManifest],
  ])
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(responses.get(url)))
  const selected = await latestRuntimeRelease(() => {})
  assert.equal(selected.archiveUrl, 'https://example.test/runtime.zip')
})

test('aguarda readiness JSON após um redirect para login', async (t) => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    if (requests === 1) {
      res.writeHead(302, { Location: '/login', Connection: 'close' }).end()
    } else {
      assert.equal(req.url, '/__ready')
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"ready":true}')
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  await waitForReady({ port: server.address().port, readinessPath: '/__ready', timeoutMs: 2_000 })
  assert.equal(requests, 2)
})

test('reporta erro de execução do Node sem esperar o prazo de readiness', async () => {
  const child = spawn(process.execPath, [], { cwd: 'diretorio-de-runtime-inexistente' })
  await assert.rejects(waitForReady({ port: 1, readinessPath: '/__ready', child }), { code: 'ENOENT' })
})
