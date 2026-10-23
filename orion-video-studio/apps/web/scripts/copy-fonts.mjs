// Copia as fontes empacotadas (Inter, SIL OFL 1.1) para public/fonts:
// a prévia usa exatamente os mesmos arquivos que a exportação.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../../../assets/fonts')
const dst = join(here, '../public/fonts')
mkdirSync(dst, { recursive: true })
for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f))
