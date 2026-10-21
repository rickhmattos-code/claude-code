import Anthropic from '@anthropic-ai/sdk'
import { buildSystemPrompt, buildUserPrompt } from './prompt.js'
import { loadSettings } from './settings.js'
import {
  type GenerateRequest,
  type GenerateResponse,
  isGenerateRequest,
} from './types.js'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Content scripts cannot open the options page themselves.
  if ((message as { type?: unknown })?.type === 'claude:open-options') {
    void chrome.runtime.openOptionsPage()
    return false
  }
  if (!isGenerateRequest(message)) return false
  generate(message).then(sendResponse, error =>
    sendResponse({ ok: false, error: describeError(error) }),
  )
  // Keep the channel open for the async response.
  return true
})

async function generate(req: GenerateRequest): Promise<GenerateResponse> {
  const settings = await loadSettings()
  if (!settings.apiKey) {
    return {
      ok: false,
      error: 'Configure sua chave da API da Anthropic nas opções da extensão.',
    }
  }
  if (req.chat.messages.length === 0) {
    return { ok: false, error: 'Nenhuma mensagem de texto nesta conversa.' }
  }

  const client = new Anthropic({
    apiKey: settings.apiKey,
    // The key lives only in this browser's extension storage and requests
    // go straight from the service worker to api.anthropic.com.
    dangerouslyAllowBrowser: true,
  })

  const params = {
    model: settings.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' as const },
    output_config: { effort: settings.effort },
    system: buildSystemPrompt(settings),
    messages: [
      {
        role: 'user' as const,
        content: buildUserPrompt(req.mode, req.chat, req.instruction),
      },
    ],
    // On a safety decline the API retries on a fallback model in the same
    // call. Not in this SDK version's types yet, so it rides as an extra
    // body field.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  }
  const response = await client.beta.messages.create(params)

  if (response.stop_reason === 'refusal') {
    return { ok: false, error: 'O Claude recusou gerar este rascunho.' }
  }
  const text = response.content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()
  return text
    ? { ok: true, text }
    : { ok: false, error: 'O Claude não retornou texto.' }
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'Chave da API inválida. Confira nas opções da extensão.'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Limite de uso atingido. Tente de novo em instantes.'
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Requisição recusada pela API: ${error.message}`
  }
  if (error instanceof Anthropic.APIError) {
    return `Erro da API (${error.status ?? 'rede'}): ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
