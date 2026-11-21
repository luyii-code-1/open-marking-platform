import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const root = path.resolve(process.argv[2] || 'dist')
const target = path.join(root, '.http-enc')
const br = promisify(brotliCompress)
const gz = promisify(gzip)

async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (entry.isFile() && /\.(?:html|js|mjs|css|svg|json|webmanifest|txt|wasm)$/i.test(entry.name)) yield file
  }
}

await mkdir(target, { recursive: true })
let count = 0
for await (const file of sources(root)) {
  const data = await readFile(file)
  if (data.length < 256) continue
  const digest = createHash('sha256').update(data).digest('hex')
  const [brotli, zipped] = await Promise.all([
    br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
    gz(data, { level: 9 }),
  ])
  for (const [encoding, compressed] of [['br', brotli], ['gz', zipped]]) {
    if (compressed.length + 32 >= data.length) continue
    await writeFile(path.join(target, digest + '.' + encoding), compressed)
    count++
  }
}
console.log(`Prepared ${count} compressed HTTP representations`)
