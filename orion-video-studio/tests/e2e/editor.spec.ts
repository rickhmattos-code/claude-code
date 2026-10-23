import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

const FIX = resolve(import.meta.dirname, '../fixtures/media')
const tmp = mkdtempSync(join(tmpdir(), 'orion-e2e-'))
const email = `e2e-${Date.now()}@exemplo.com`
const password = 'senha-forte-e2e-123'

async function login(page: Page) {
  await page.goto('/login')
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForURL('/')
}

const clips = (page: Page) => page.locator('[aria-label^="Clipe "]')

async function waitSaved(page: Page) {
  await expect(page.getByText('Salvo', { exact: true })).toBeVisible({ timeout: 30_000 })
}

/** luminância média (0–255) de uma imagem reduzida a 32×56 via FFmpeg */
function grayPixels(png: string): Uint8Array {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=32:56:flags=area,format=gray', '-f', 'rawvideo', '-'])
  return new Uint8Array(out)
}

test.describe.serial('fluxo principal do editor', () => {
  let projectUrl = ''

  test('cadastro, projeto, upload, timeline, dividir, salvar e reabrir', async ({ page }) => {
    await page.goto('/register')
    await page.fill('#name', 'Pessoa E2E')
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.getByRole('button', { name: 'Criar conta' }).click()
    await page.waitForURL('/')
    await expect(page.getByText('Nenhum projeto ainda')).toBeVisible()

    await page.getByRole('button', { name: 'Novo projeto' }).first().click()
    await page.fill('#pname', 'Projeto E2E')
    await page.getByRole('button', { name: /16:9 Horizontal/ }).click()
    await page.getByRole('button', { name: 'Criar projeto' }).click()
    await page.waitForURL(/\/projects\//)
    projectUrl = page.url()

    // upload pelo seletor de arquivos (URL assinada direto ao armazenamento)
    await page.setInputFiles('input[aria-label="Selecionar arquivos"]', join(FIX, 'video_30fps_1080p_20s.mp4'))
    const item = page.locator('li', { hasText: 'video_30fps_1080p_20s.mp4' })
    await expect(item.getByRole('button', { name: 'Adicionar' })).toBeEnabled({ timeout: 120_000 })
    await item.getByRole('button', { name: 'Adicionar' }).click()
    await expect(clips(page)).toHaveCount(1)

    // cursor em 5 s e dividir com o atalho S
    await page.locator('[role=slider][aria-label="Posição do cursor"]').click({ position: { x: 5 * 40 + 2, y: 10 } })
    await page.keyboard.press('s')
    await expect(clips(page)).toHaveCount(2)
    // desfazer/refazer
    await page.keyboard.press('Control+z')
    await expect(clips(page)).toHaveCount(1)
    await page.keyboard.press('Control+Shift+z')
    await expect(clips(page)).toHaveCount(2)
    await waitSaved(page)

    await page.reload()
    await expect(clips(page)).toHaveCount(2)
  })

  test('alterações não salvas são recuperadas após recarregar (sem rede)', async ({ page }) => {
    await login(page)
    await page.goto(projectUrl)
    await expect(clips(page)).toHaveCount(2)
    // bloqueia o salvamento para simular queda antes do autosave
    await page.route('**/api/projects/*', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()))
    await clips(page).first().click()
    await page.keyboard.press('Delete')
    await expect(clips(page)).toHaveCount(1)
    await page.waitForTimeout(400)
    await page.unroute('**/api/projects/*')
    await page.reload()
    await expect(page.getByText('Alterações não salvas foram recuperadas')).toBeVisible()
    await expect(clips(page)).toHaveCount(1)
    await waitSaved(page)
  })

  test('exporta pela interface e a prévia coincide com o arquivo exportado', async ({ page, request }) => {
    await login(page)
    await page.goto(projectUrl)
    await expect(clips(page)).toHaveCount(1)
    // adiciona um título para comparar texto também
    await page.getByRole('tab', { name: 'Texto' }).click()
    await page.getByRole('button', { name: /Título/ }).click()
    await waitSaved(page)

    // quadro da prévia em t = 7 s (dentro do vídeo: o trecho 0–5 s foi excluído no teste anterior)
    await page.locator('[role=slider][aria-label="Posição do cursor"]').click({ position: { x: 7 * 40 + 1, y: 10 } })
    await page.waitForFunction(() => (document.querySelector('canvas')?.dataset.media ?? '').includes('video:4'), null, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    const dataUrl = await page.evaluate(() => document.querySelector('canvas')!.toDataURL('image/png'))
    const previewPng = join(tmp, 'preview.png')
    writeFileSync(previewPng, Buffer.from(dataUrl.split(',')[1]!, 'base64'))
    const headerTime = await page.locator('text=/\\d{2}:\\d{2}:\\d{2}:\\d{2} \\//').first().innerText()

    await page.getByRole('button', { name: 'Exportar' }).click()
    await page.getByLabel('Resolução').selectOption('720p')
    await page.getByRole('button', { name: 'Iniciar exportação' }).click()
    await expect(page.getByText('Concluído').first()).toBeVisible({ timeout: 240_000 })
    const href = await page.getByRole('link', { name: /Baixar MP4/ }).getAttribute('href')
    expect(href).toBeTruthy()
    const res = await request.get(href!)
    expect(res.ok()).toBe(true)
    const mp4 = join(tmp, 'export.mp4')
    writeFileSync(mp4, await res.body())

    // compara: frame exportado no mesmo instante do cursor da prévia
    const [hh, mm, ss, ff] = headerTime.split(' ')[0]!.split(':').map(Number)
    const t = hh! * 3600 + mm! * 60 + ss! + ff! / 30
    const exportPng = join(tmp, 'export.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(4), '-i', mp4, '-frames:v', '1', exportPng])
    const a = grayPixels(previewPng)
    const b = grayPixels(exportPng)
    let diff = 0
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!)
    const mean = diff / a.length
    console.log(`diferença média de luminância prévia × exportação: ${mean.toFixed(2)} / 255`)
    expect(mean).toBeLessThan(12)
  })

  test('máscara: a prévia recorta igual ao arquivo exportado', async ({ page, request }) => {
    await login(page)
    await page.goto(projectUrl)
    // o clipe de vídeo (o título adicionado antes não aceita máscara)
    await page.locator('[aria-label^="Clipe video_30fps"]').first().click()
    await page.getByLabel('Adicionar efeito').selectOption('mask')
    await expect(page.getByText('Máscara (retângulo ou elipse)')).toBeVisible()
    await waitSaved(page)
    await page.locator('[role=slider][aria-label="Posição do cursor"]').click({ position: { x: 8 * 40 + 1, y: 10 } })
    await page.waitForFunction(() => (document.querySelector('canvas')?.dataset.media ?? '').includes('video:4'), null, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    const dataUrl = await page.evaluate(() => document.querySelector('canvas')!.toDataURL('image/png'))
    const previewPng = join(tmp, 'preview-mask.png')
    writeFileSync(previewPng, Buffer.from(dataUrl.split(',')[1]!, 'base64'))
    const headerTime = await page.locator('text=/\\d{2}:\\d{2}:\\d{2}:\\d{2} \\//').first().innerText()
    await page.getByRole('button', { name: 'Exportar' }).click()
    await page.getByLabel('Resolução').selectOption('720p')
    await page.getByRole('button', { name: 'Iniciar exportação' }).click()
    await expect(page.getByText('Concluído').first()).toBeVisible({ timeout: 240_000 })
    const href = await page.getByRole('link', { name: /Baixar MP4/ }).first().getAttribute('href')
    const mp4 = join(tmp, 'export-mask.mp4')
    writeFileSync(mp4, await (await request.get(href!)).body())
    const [hh, mm, ss, ff] = headerTime.split(' ')[0]!.split(':').map(Number)
    const t = hh! * 3600 + mm! * 60 + ss! + ff! / 30
    const exportPng = join(tmp, 'export-mask.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(4), '-i', mp4, '-frames:v', '1', exportPng])
    const a = grayPixels(previewPng)
    const b = grayPixels(exportPng)
    let diff = 0
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!)
    const mean = diff / a.length
    // cantos fora da elipse ficam pretos nos dois; o centro mostra o vídeo
    expect(a[0]).toBeLessThan(20)
    expect(b[0]).toBeLessThan(20)
    let centerSum = 0
    for (let y = 24; y < 32; y++) for (let x = 10; x < 22; x++) centerSum += b[y * 32 + x]!
    expect(centerSum / 96).toBeGreaterThan(60)
    console.log(`máscara — diferença média prévia × exportação: ${mean.toFixed(2)} / 255`)
    expect(mean).toBeLessThan(12)
  })

  test('edição pelo texto: excluir uma frase corta o trecho em todas as trilhas', async ({ page }) => {
    await login(page)
    await page.goto(projectUrl)
    await page.getByRole('tab', { name: 'Legendas' }).click()
    const srt = join(tmp, 'frases.srt')
    writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nPrimeira frase\n\n2\n00:00:06,000 --> 00:00:09,000\nSegunda frase\n')
    await page.setInputFiles('input[aria-label="Arquivo de legendas"]', srt)
    await expect(page.getByText('2 legendas importadas.')).toBeVisible()
    const total = async () => (await page.locator('text=/\\d{2}:\\d{2}:\\d{2}:\\d{2} \\//').first().innerText()).split('/ ')[1]!.trim()
    const before = await total()
    await page.getByRole('tab', { name: 'Transcrição' }).click()
    const transcript = page.getByLabel('Transcrição editável')
    await expect(transcript.getByText('Segunda frase')).toBeVisible()
    await transcript.locator('div', { hasText: 'Segunda frase' }).last().getByLabel('frase inteira').check()
    await page.getByRole('button', { name: /Excluir seleção \(3 s\)/ }).click()
    await expect(transcript.getByText('Segunda frase')).toHaveCount(0)
    const after = await total()
    expect(after).not.toBe(before)
    await waitSaved(page)
  })

  test('templates: projeto a partir de template com campo preenchido', async ({ page }) => {
    await login(page)
    await page.goto('/templates')
    const card = page.locator('li', { hasText: 'Reflexão Aurora' })
    await card.getByRole('button', { name: 'Usar template' }).click()
    await page.fill('#f-frase', 'Disciplina é liberdade.')
    await page.getByRole('button', { name: 'Criar projeto' }).click()
    await page.waitForURL(/\/projects\//)
    await expect(page.locator('[aria-label="Clipe Disciplina é liberdade."]')).toBeVisible()
  })

  test('layout móvel mostra preview, barra de ferramentas e áreas alternáveis', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await page.goto(projectUrl)
    const nav = page.getByRole('navigation', { name: 'Áreas do editor' })
    await expect(nav).toBeVisible()
    await nav.getByRole('button', { name: 'Propriedades' }).click()
    await expect(page.getByText('Selecione um clipe para editar', { exact: false }).last()).toBeVisible()
    await nav.getByRole('button', { name: 'Recursos' }).click()
    await expect(page.getByRole('button', { name: 'Enviar arquivos' }).last()).toBeVisible()
  })

  test('nenhuma chave ou segredo do servidor chega ao navegador', async ({ page, request }) => {
    // valores reais do .env do servidor (nomes podem aparecer em textos de ajuda; valores, nunca)
    const envFile = readFileSync(resolve(import.meta.dirname, '../../.env'), 'utf8')
    const secrets = envFile
      .split('\n')
      .map((l) => /^([A-Z0-9_]+)=(.+)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m && /(KEY|SECRET|PASSWORD|DATABASE_URL|REDIS_URL)/.test(m[1]!) && m[2]!.length >= 8)
      .map((m) => m[2]!)
    expect(secrets.length).toBeGreaterThan(0)
    await login(page)
    await page.goto(projectUrl)
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean))
    expect(scripts.length).toBeGreaterThan(0)
    const html = await (await request.get(projectUrl)).text()
    for (const src of [...scripts, projectUrl]) {
      const body = src === projectUrl ? html : await (await request.get(src)).text()
      for (const value of secrets) expect(body.includes(value), `segredo do .env em ${src}`).toBe(false)
      expect(body).not.toMatch(/\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})\b/)
    }
    const providers = await (await request.get('/api/providers')).text()
    for (const value of secrets) expect(providers.includes(value)).toBe(false)
  })
})
