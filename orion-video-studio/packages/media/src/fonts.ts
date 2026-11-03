import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FontSet } from './graph.ts'

/** Fontes empacotadas (Inter, SIL OFL 1.1) em assets/fonts. */
export function bundledFonts(dir = process.env.FONTS_DIR): FontSet {
  const base = dir ? resolve(dir) : resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts')
  const files: Record<string, string> = {}
  for (const f of readdirSync(base)) {
    if (f.endsWith('.otf') || f.endsWith('.ttf')) files[f.replace(/\.(otf|ttf)$/, '')] = join(base, f)
  }
  return { dir: base, files }
}
