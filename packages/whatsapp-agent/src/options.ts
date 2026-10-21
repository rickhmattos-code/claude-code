import { loadSettings, normalizeSettings, saveSettings } from './settings.js'

const FIELDS = [
  'apiKey',
  'model',
  'effort',
  'persona',
  'language',
  'historyLimit',
] as const

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function field(name: (typeof FIELDS)[number]): Field {
  return document.getElementById(name) as Field
}

async function init(): Promise<void> {
  const settings = await loadSettings()
  for (const name of FIELDS) field(name).value = String(settings[name])

  document.getElementById('form')!.addEventListener('submit', async event => {
    event.preventDefault()
    const raw: Record<string, unknown> = {}
    for (const name of FIELDS) raw[name] = field(name).value
    await saveSettings(normalizeSettings(raw))
    document.getElementById('saved')!.textContent = 'Salvo.'
  })
}

void init()
