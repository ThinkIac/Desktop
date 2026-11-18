import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { download, latestRuntimeRelease, sha256 } from '../electron/runtime-manager.mjs'

const output = process.argv[2]
if (!output) throw new Error('Informe o diretório do bundle.')
const { manifest, runtime, archiveUrl } = await latestRuntimeRelease(console.log)
await mkdir(output, { recursive: true })
const archive = join(output, runtime.platform.asset)
await download(archiveUrl, archive)
if ((await sha256(archive)).toLowerCase() !== runtime.platform.sha256.toLowerCase()) {
  throw new Error('A verificação SHA-256 do Runtime falhou.')
}
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2))
