import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

/**
 * Guarda de idioma: os textos visíveis da interface (texto JSX, rótulos,
 * dicas, placeholders, aria-label, toast/confirm/prompt) não podem voltar a
 * usar termos em inglês que já têm tradução estabelecida em pt-BR.
 */
const ROOTS = [resolve(import.meta.dirname, '../src'), resolve(import.meta.dirname, '../../../packages/ui/src')]
const VISIBLE_PROPS = new Set(['label', 'title', 'hint', 'placeholder', 'aria-label', 'description', 'shortcut'])
const VISIBLE_CALLS = new Set(['toast', 'confirm', 'prompt', 'alert', 'notice'])
const BANNED = /\b(Templates?|Ripple|[Kk]eyframes?|[Tt]imeline|[Ww]orkspaces?|Fade|Dissolve|Preset|Status|Setup|Punchline|Snap|Undo|Redo|Delete|Cancel|Save|Loading|Upload|Download|Settings|Extra bold|Semibold)\b/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (f === 'node_modules' || f === '.next') return []
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}

function visibleStrings(file: string): Array<{ text: string; line: number }> {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Array<{ text: string; line: number }> = []
  const add = (n: ts.Node, text: string) => out.push({ text, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1 })
  const literal = (n: ts.Node): string | null =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => s.literal.text).join(' ') : null
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && n.getText().trim()) add(n, n.getText())
    if (ts.isJsxAttribute(n) && VISIBLE_PROPS.has(n.name.getText()) && n.initializer) {
      const init = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer
      const walk = (e: ts.Node | undefined) => {
        if (!e) return
        const t = literal(e)
        if (t !== null) add(e, t)
        else if (ts.isConditionalExpression(e)) {
          walk(e.whenTrue)
          walk(e.whenFalse)
        }
      }
      walk(init)
    }
    if (ts.isCallExpression(n) && VISIBLE_CALLS.has(n.expression.getText().replace(/^.*\./, '').replace(/\?$/, ''))) {
      const t = n.arguments[0] && literal(n.arguments[0])
      if (t) add(n, t)
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

describe('idioma da interface (pt-BR)', () => {
  test('nenhum texto visível usa termos em inglês já traduzidos', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const f of files(root)) {
        for (const s of visibleStrings(f)) if (BANNED.test(s.text)) hits.push(`${f.replace(root, '')}:${s.line} → ${s.text.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })
})
