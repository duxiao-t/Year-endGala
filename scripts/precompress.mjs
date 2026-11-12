import fs from 'node:fs/promises'
import path from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const assetsDir = path.resolve('web/dist/assets')

try {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true })
  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.endsWith('.gz') &&
      /\.(js|css|svg|json|txt)$/.test(entry.name)
  )
  await Promise.all(
    files.map(async (entry) => {
      const filePath = path.join(assetsDir, entry.name)
      const source = await fs.readFile(filePath)
      await fs.writeFile(`${filePath}.gz`, await gzipAsync(source, { level: 9 }))
    })
  )
  console.log(`Precompressed ${files.length} assets.`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
