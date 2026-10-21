import { loadSettings } from './settings.js'
import type {
  GenerateMode,
  GenerateRequest,
  GenerateResponse,
} from './types.js'
import { insertIntoComposer, readOpenChat } from './whatsappDom.js'

const STYLE = `
:host { all: initial; }
.fab {
  position: fixed; right: 20px; bottom: 90px; z-index: 2147483647;
  width: 48px; height: 48px; border-radius: 50%; border: none;
  background: #D77757; color: #fff; font: 600 20px system-ui, sans-serif;
  cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
.panel {
  position: fixed; right: 20px; bottom: 150px; z-index: 2147483647;
  width: 360px; max-width: calc(100vw - 40px); padding: 14px;
  border-radius: 12px; background: #fffaf7; color: #2b2622;
  font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.25);
  display: flex; flex-direction: column; gap: 8px;
}
.panel[hidden] { display: none; }
h2 { margin: 0; font-size: 15px; }
textarea {
  width: 100%; box-sizing: border-box; border: 1px solid #e3d6cd;
  border-radius: 8px; padding: 8px; font: inherit; resize: vertical;
  background: #fff; color: inherit;
}
.row { display: flex; gap: 6px; flex-wrap: wrap; }
button.act {
  flex: 1; padding: 7px 10px; border-radius: 8px; border: 1px solid #D77757;
  background: #fff; color: #b35a3c; font: 600 13px system-ui, sans-serif;
  cursor: pointer;
}
button.primary { background: #D77757; color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.status { font-size: 12px; color: #7a6d64; min-height: 16px; }
.status.error { color: #b3261e; }
@media (prefers-color-scheme: dark) {
  .panel { background: #2a2420; color: #f3ebe5; }
  textarea { background: #1f1a17; border-color: #4a3f38; }
  button.act { background: #1f1a17; color: #f0a184; }
  button.primary { background: #D77757; color: #fff; }
  .status { color: #b5a79d; }
}
`

function mount(): void {
  const host = document.createElement('div')
  host.id = 'claude-whatsapp-agent'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>${STYLE}</style>
    <button class="fab" title="Claude: agente do WhatsApp">✦</button>
    <div class="panel" hidden>
      <h2>Claude no WhatsApp</h2>
      <textarea class="instruction" rows="2"
        placeholder="Instrução opcional (ex.: recuse com educação, proponha sexta às 15h)"></textarea>
      <div class="row">
        <button class="act primary" data-mode="reply">Sugerir resposta</button>
        <button class="act" data-mode="summary">Resumir conversa</button>
      </div>
      <textarea class="draft" rows="6" placeholder="O rascunho aparece aqui. Edite à vontade."></textarea>
      <div class="row">
        <button class="act insert">Inserir no chat</button>
        <button class="act copy">Copiar</button>
        <button class="act options">Opções</button>
      </div>
      <div class="status"></div>
    </div>`
  document.body.appendChild(host)

  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!
  const panel = q<HTMLDivElement>('.panel')
  const instruction = q<HTMLTextAreaElement>('.instruction')
  const draft = q<HTMLTextAreaElement>('.draft')
  const status = q<HTMLDivElement>('.status')
  const modeButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-mode]'),
  )

  const setStatus = (text: string, isError = false) => {
    status.textContent = text
    status.classList.toggle('error', isError)
  }

  q<HTMLButtonElement>('.fab').addEventListener('click', () => {
    panel.hidden = !panel.hidden
  })

  for (const button of modeButtons) {
    button.addEventListener('click', async () => {
      const mode = button.dataset.mode as GenerateMode
      const { historyLimit } = await loadSettings()
      const chat = readOpenChat(document, historyLimit)
      if (!chat) {
        setStatus('Abra uma conversa primeiro.', true)
        return
      }
      modeButtons.forEach(b => (b.disabled = true))
      setStatus(`Lendo ${chat.messages.length} mensagens de ${chat.title}…`)
      try {
        const request: GenerateRequest = {
          type: 'claude:generate',
          mode,
          chat,
          instruction: instruction.value,
        }
        const res = await chrome.runtime.sendMessage<GenerateResponse>(request)
        if (res.ok) {
          draft.value = res.text
          setStatus(
            mode === 'reply'
              ? 'Revise o rascunho e clique em "Inserir no chat".'
              : 'Resumo pronto.',
          )
        } else {
          setStatus(res.error, true)
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true)
      } finally {
        modeButtons.forEach(b => (b.disabled = false))
      }
    })
  }

  q<HTMLButtonElement>('.insert').addEventListener('click', () => {
    if (!draft.value.trim()) return
    const inserted = insertIntoComposer(document, draft.value)
    setStatus(
      inserted
        ? 'Inserido. Confira e pressione Enter para enviar.'
        : 'Não encontrei a caixa de mensagem. Abra uma conversa.',
      !inserted,
    )
  })

  q<HTMLButtonElement>('.copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(draft.value)
    setStatus('Copiado.')
  })

  q<HTMLButtonElement>('.options').addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'claude:open-options' })
  })
}

if (!document.getElementById('claude-whatsapp-agent')) mount()
