import type { ChatMessage, ChatSnapshot } from './types.js'

// WhatsApp Web changes its markup often. Every selector the extension relies
// on lives here so a breakage is fixed in one place.
export const SELECTORS = {
  main: '#main',
  chatTitle: 'header span[dir="auto"]',
  message: 'div.message-in, div.message-out',
  messageMeta: '[data-pre-plain-text]',
  messageText: 'span.selectable-text',
  composer: 'footer div[contenteditable="true"]',
} as const

// data-pre-plain-text looks like "[10:42, 21/10/2026] Maria: "
export function parseMessageMeta(meta: string): {
  time: string
  author: string
} {
  const match = /^\[([^\]]*)\]\s*(.*?):\s*$/.exec(meta.trim())
  if (!match) return { time: '', author: '' }
  return { time: match[1]!.trim(), author: match[2]!.trim() }
}

export function readOpenChat(
  doc: Document,
  limit: number,
): ChatSnapshot | null {
  const main = doc.querySelector(SELECTORS.main)
  if (!main) return null

  const title =
    main.querySelector(SELECTORS.chatTitle)?.textContent?.trim() || 'Contato'

  const messages: ChatMessage[] = []
  for (const el of Array.from(main.querySelectorAll(SELECTORS.message))) {
    const text = Array.from(el.querySelectorAll(SELECTORS.messageText))
      .map(span => span.textContent ?? '')
      .join('\n')
      .trim()
    if (!text) continue
    const meta = el
      .querySelector(SELECTORS.messageMeta)
      ?.getAttribute('data-pre-plain-text')
    messages.push({
      fromMe: el.classList.contains('message-out'),
      ...parseMessageMeta(meta ?? ''),
      text,
    })
  }

  return { title, messages: messages.slice(-limit) }
}

// Puts text in the compose box without sending it: the user always presses
// Enter. execCommand is deprecated but is still the only way to feed
// WhatsApp's editor so its internal state stays in sync.
export function insertIntoComposer(doc: Document, text: string): boolean {
  const box = doc.querySelector<HTMLElement>(
    `${SELECTORS.main} ${SELECTORS.composer}`,
  )
  if (!box) return false
  box.focus()
  return doc.execCommand('insertText', false, text)
}
