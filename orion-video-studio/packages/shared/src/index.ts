import { z } from 'zod'

// mensagens de validação do Zod em português do Brasil (API, worker e web compartilham este pacote)
z.config(z.locales.ptBR())

export * from './doc.ts'
export * from './effects.ts'
export * from './template.ts'
export * from './templates-data.ts'
export * from './api.ts'
export * from './i18n.ts'
