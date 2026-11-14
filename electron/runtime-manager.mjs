import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
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
  assert(manifest?.schemaVersion === 1, 'Manifesto do Runtime incompatível.')
  assert(typeof runtime?.version === 'string' && /^[A-Za-z0-9._-]+$/.test(runtime.version), 'Versão do Runtime inválida.')
  assert(typeof runtime?.asset === 'string' && basename(runtime.asset) === runtime.asset && runtime.asset.endsWith('.zip'), 'Asset do Runtime inválido.')
  assert(typeof runtime?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(runtime.sha256), 'SHA-256 do Runtime inválido.')
  assert(typeof runtime?.entrypoint === 'string' && runtime.entrypoint === 'index.js', 'Entrypoint do Runtime não suportado.')
  assert(typeof runtime?.readinessPath === 'string' && runtime.readinessPath.startsWith('/'), 'Readiness do Runtime inválida.')
  return runtime
}

export async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ThinkIac-Desktop' } })
  if (!response.ok) throw new Error(`Download falhou (${response.status}): ${url}`)
  return response.json()
}

export async function latestRuntimeRelease(onProgress) {
  onProgress('Consultando a release mais atual do ThinkIac…')
  const releases = await fetchJson(RELEASES_URL)
  assert(Array.isArray(releases), 'Resposta de releases inválida.')
  const release = releases.find((candidate) => assetByName(candidate, 'runtime-manifest.json'))
  assert(release, 'Nenhuma release com runtime-manifest.json foi encontrada.')
  const manifestAsset = assetByName(release, 'runtime-manifest.json')
  const manifest = await fetchJson(manifestAsset.browser_download_url)
  const runtime = validateManifest(manifest)
  const archiveAsset = assetByName(release, runtime.asset)
  assert(archiveAsset, `A release não contém ${runtime.asset}.`)
  return { release, manifest, runtime, archiveUrl: archiveAsset.browser_download_url }
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'ThinkIac-Desktop' }, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Não foi possível baixar o Runtime (${response.status}).`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }))
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function isInside(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate))
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !pathFromParent.startsWith('/')
}

async function run(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Comando falhou com código ${code}.`)))
  })
}

export async function installRuntimeDependencies({ runtimeDir, npmCli, electronVersion, onProgress }) {
  if (existsSync(join(runtimeDir, 'node_modules'))) return
  assert(npmCli && existsSync(npmCli), 'O instalador de dependências do Desktop não foi encontrado.')
  onProgress('Instalando dependências locais do Runtime…')
  await run(process.execPath, [npmCli, 'ci', '--omit=dev'], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers'
    }
  })
}

export async function ensureRuntime({ rootDir, npmCli, electronVersion, onProgress = () => {} }) {
  const { runtime, archiveUrl } = await latestRuntimeRelease(onProgress)
  const runtimeRoot = join(rootDir, 'runtime')
  const destination = join(runtimeRoot, runtime.version)
  const marker = join(destination, '.thinkiac-runtime.json')
  if (existsSync(marker)) {
    try {
      const installed = JSON.parse(await readFile(marker, 'utf8'))
      if (installed.sha256 === runtime.sha256) {
        await installRuntimeDependencies({ runtimeDir: destination, npmCli, electronVersion, onProgress })
        return { runtime, directory: destination }
      }
    } catch {}
  }

  await mkdir(runtimeRoot, { recursive: true })
  const staging = join(runtimeRoot, `.staging-${runtime.version}-${Date.now()}`)
  const archive = join(runtimeRoot, `.download-${runtime.version}-${Date.now()}.zip`)
  try {
    onProgress('Baixando Runtime verificado…')
    await download(archiveUrl, archive)
    assert((await sha256(archive)).toLowerCase() === runtime.sha256.toLowerCase(), 'A verificação SHA-256 do Runtime falhou.')
    onProgress('Extraindo Runtime local…')
    await mkdir(staging, { recursive: true })
    await extract(archive, { dir: staging })
    const extracted = join(staging, 'thinkiac-runtime')
    assert(existsSync(extracted) && isInside(staging, extracted), 'O ZIP não contém a raiz esperada do Runtime.')
    await writeFile(join(extracted, '.thinkiac-runtime.json'), JSON.stringify({ version: runtime.version, sha256: runtime.sha256, source: REPOSITORY_URL }, null, 2))
    await installRuntimeDependencies({ runtimeDir: extracted, npmCli, electronVersion, onProgress })
    await rm(destination, { recursive: true, force: true })
    await rename(extracted, destination)
    return { runtime, directory: destination }
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

export function startRuntime({ directory, runtime, port, dataDir }) {
  const entrypoint = join(directory, runtime.entrypoint)
  const child = spawn(process.execPath, [entrypoint], {
    cwd: directory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), THINKIAC_DATA_DIR: dataDir },
    stdio: 'pipe',
    windowsHide: true
  })
  child.stdout?.on('data', (data) => console.log(`[runtime] ${data}`))
  child.stderr?.on('data', (data) => console.error(`[runtime] ${data}`))
  return child
}

export async function waitForReady({ port, readinessPath, timeoutMs = 90_000 }) {
  const url = `http://127.0.0.1:${port}${readinessPath}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return url
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error('O Runtime local não respondeu dentro do prazo.')
}
