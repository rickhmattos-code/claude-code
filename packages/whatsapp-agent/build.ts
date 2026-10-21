// Builds the unpacked Chrome extension into packages/whatsapp-agent/dist.
// Usage: bun packages/whatsapp-agent/build.ts
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = import.meta.dir
const outdir = join(root, 'dist')

rmSync(outdir, { recursive: true, force: true })

// Service worker and options page are ES modules; content scripts are not,
// so content.js is bundled as an IIFE.
const builds = [
  { entry: 'src/background.ts', format: 'esm' as const },
  { entry: 'src/options.ts', format: 'esm' as const },
  { entry: 'src/content.ts', format: 'iife' as const },
]

for (const { entry, format } of builds) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir,
    target: 'browser',
    format,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

cpSync(join(root, 'public'), outdir, { recursive: true })
console.log(`Extension built at ${outdir}`)
