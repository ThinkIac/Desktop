import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import extract from 'extract-zip'

export const RELEASES_URL = 'https://api.github.com/repos/ThinkIac/ThinkIac/releases'
const REPOSITORY_URL = 'https://github.com/ThinkIac/ThinkIac'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assetByName(release, name) {
  return release.assets?.find((asset) => asset.name === name)
}

export function validateManifest(manifest) {
  const runtime = manifest?.runtime
  assert(manifest?.schemaVersion === 2, 'Manifesto do Runtime incompatível.')
  assert(typeof runtime?.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runtime.version), 'Versão do Runtime inválida.')
  assert(typeof runtime?.entrypoint === 'string' && runtime.entrypoint === 'index.js', 'Entrypoint do Runtime não suportado.')
  assert(typeof runtime?.readinessPath === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]+$/.test(runtime.readinessPath), 'Readiness do Runtime inválida.')
  const platform = runtime.platforms?.['win32-x64']
  assert(platform && typeof platform === 'object', 'A release não possui Runtime para Windows x64.')
  assert(typeof platform.asset === 'string' && basename(platform.asset) === platform.asset && !platform.asset.includes('\\') && platform.asset.endsWith('.zip'), 'Asset do Runtime inválido.')
  assert(typeof platform.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(platform.sha256), 'SHA-256 do Runtime inválido.')
  assert(platform.nodeEntrypoint === 'node/node.exe', 'Node do Runtime inválido.')
  return { ...runtime, platform }
}

export async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ThinkIac-Desktop' } })
  if (!response.ok) throw new Error(`Download falhou (${response.status}): ${url}`)
  return response.json()
}

export async function latestRuntimeRelease(onProgress) {
  onProgress('Consultando a release mais atual do ThinkIac…')
  let issue
  for (let page = 1; ; page++) {
    const releases = await fetchJson(`${RELEASES_URL}?per_page=30&page=${page}`)
    assert(Array.isArray(releases), 'Resposta de releases inválida.')
    for (const release of releases) {
      const manifestAsset = assetByName(release, 'runtime-manifest.json')
      if (!manifestAsset?.browser_download_url || release.draft) continue
      try {
        const manifest = await fetchJson(manifestAsset.browser_download_url)
        const runtime = validateManifest(manifest)
        const archiveAsset = assetByName(release, runtime.platform.asset)
        if (archiveAsset?.browser_download_url) return { release, manifest, runtime, archiveUrl: archiveAsset.browser_download_url }
        issue ??= `A release não contém ${runtime.platform.asset}.`
      } catch (error) {
        issue ??= error.message
      }
    }
    if (releases.length < 30) break
  }
  throw new Error(`Nenhuma release compatível com o Runtime Windows x64 foi encontrada.${issue ? ` ${issue}` : ''}`)
}

export async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000), headers: { 'User-Agent': 'ThinkIac-Desktop' }, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Não foi possível baixar o Runtime (${response.status}).`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }))
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function isInside(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate))
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !pathFromParent.startsWith('/')
}

function hasRuntimeFiles(directory, runtime) {
  return ['node_modules', runtime.entrypoint, runtime.platform.nodeEntrypoint]
    .every((file) => existsSync(join(directory, file)))
}

async function installedRuntime(directory, runtime) {
  try {
    const marker = JSON.parse(await readFile(join(directory, '.thinkiac-runtime.json'), 'utf8'))
    const installed = runtime ?? validateManifest(marker.manifest)
    if (marker.sha256.toLowerCase() === installed.platform.sha256.toLowerCase() && hasRuntimeFiles(directory, installed)) {
      return { directory, runtime: installed, marker }
    }
  } catch {}
}

export async function ensureRuntime({ rootDir, bundledDir, onProgress = () => {} }) {
  const runtimeRoot = join(rootDir, 'runtime')
  await mkdir(runtimeRoot, { recursive: true })
  const manifestPath = bundledDir && join(bundledDir, 'runtime-manifest.json')
  const bundledManifest = manifestPath && existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
  if (!bundledManifest) {
    for (const item of await readdir(runtimeRoot, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.')) continue
      const installed = await installedRuntime(join(runtimeRoot, item.name))
      if (installed) return installed
    }
  }
  const { manifest, runtime, archiveUrl } = bundledManifest
    ? { manifest: bundledManifest, runtime: validateManifest(bundledManifest) }
    : await latestRuntimeRelease(onProgress)
  const destination = join(runtimeRoot, runtime.version)
  const installed = await installedRuntime(destination, runtime)
  if (installed) {
    if (!installed.marker.manifest) await writeMarker(destination, manifest, runtime)
    return installed
  }

  // Preserve data written beside older runtime versions and partial installs.
  const target = existsSync(destination) ? `${destination}-${runtime.platform.sha256.slice(0, 12)}` : destination
  const repaired = await installedRuntime(target, runtime)
  if (repaired) return repaired
  const staging = await mkdtemp(join(runtimeRoot, '.staging-'))
  const archive = bundledManifest ? join(bundledDir, runtime.platform.asset) : join(staging, 'runtime.zip')
  try {
    if (!bundledManifest) {
      onProgress('Baixando Runtime verificado…')
      await download(archiveUrl, archive)
    }
    assert((await sha256(archive)).toLowerCase() === runtime.platform.sha256.toLowerCase(), 'A verificação SHA-256 do Runtime falhou.')
    onProgress('Extraindo Runtime local…')
    await extract(archive, { dir: staging })
    const extracted = join(staging, 'thinkiac-runtime')
    assert(isInside(staging, extracted) && hasRuntimeFiles(extracted, runtime), 'O ZIP do Runtime está incompleto.')
    await writeMarker(extracted, manifest, runtime)
    await rename(extracted, target)
    return { runtime, directory: target }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function writeMarker(directory, manifest, runtime) {
  await writeFile(join(directory, '.thinkiac-runtime.json'), JSON.stringify({
    version: runtime.version, sha256: runtime.platform.sha256, source: REPOSITORY_URL, manifest,
  }, null, 2))
}

export function startRuntime({ directory, runtime, port, mcpPort, dataDir }) {
  const entrypoint = join(directory, runtime.entrypoint)
  const child = spawn(join(directory, runtime.platform.nodeEntrypoint), [entrypoint], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MCP_HOST: '127.0.0.1',
      ...(mcpPort && { MCP_PORT: String(mcpPort) }),
      MCP_ALLOW_REMOTE: '0',
      THINKIAC_DESKTOP: '1',
      THINKIAC_DATA_DIR: dataDir,
      LOGOS_DATA_DIR: dataDir,
    },
    stdio: 'pipe',
    windowsHide: true
  })
  child.stdout?.on('data', (data) => console.log(`[runtime] ${data}`))
  child.stderr?.on('data', (data) => console.error(`[runtime] ${data}`))
  return child
}

export async function waitForReady({ port, readinessPath, child, timeoutMs = 90_000 }) {
  const url = `http://127.0.0.1:${port}${readinessPath}`
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('O Runtime local não respondeu dentro do prazo.')), timeoutMs)
  const onError = (error) => controller.abort(error)
  const onExit = (code, signal) => controller.abort(new Error(`O Runtime local encerrou durante a inicialização (${signal ?? code}).`))
  child?.once('error', onError)
  child?.once('exit', onExit)
  const { signal } = controller
  try {
    if (child && (child.exitCode !== null || child.signalCode !== null)) onExit(child.exitCode, child.signalCode)
    for (;;) {
      signal.throwIfAborted()
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) })
        if (response.ok && (await response.json()).ready === true) return url
        await response.body?.cancel().catch(() => {})
      } catch {}
      await delay(250, undefined, { signal })
    }
  } catch (error) {
    throw signal.reason ?? error
  } finally {
    clearTimeout(deadline)
    child?.off('error', onError)
    child?.off('exit', onExit)
  }
}
