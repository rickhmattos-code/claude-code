# Claude no WhatsApp (extensão do Chrome)

Extensão Manifest V3 que coloca o Claude dentro do **WhatsApp Web**: lê a
conversa aberta, sugere a próxima resposta no seu estilo, resume conversas
longas e insere o rascunho na caixa de mensagem. **Quem envia é sempre você**
(a extensão nunca pressiona Enter).

Não é um pacote do workspace e não é importado pelo CLI. É um projeto
independente, como `remote-control-server/`.

## Instalar

```bash
bun install                         # na raiz do repositório
bun packages/whatsapp-agent/build.ts
```

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha
   `packages/whatsapp-agent/dist`.
3. Nas **Opções** da extensão, cole uma chave da API da Anthropic
   (console.anthropic.com) e descreva quem você é e como escreve.
4. Abra https://web.whatsapp.com, entre numa conversa e clique no botão
   laranja ✦.

## Como funciona

| Arquivo | Papel |
|---|---|
| `src/content.ts` | Painel flutuante (Shadow DOM) no WhatsApp Web |
| `src/whatsappDom.ts` | Lê mensagens e escreve na caixa de texto; **todos os seletores do WhatsApp ficam aqui** |
| `src/background.ts` | Service worker que chama a API do Claude via `@anthropic-ai/sdk` |
| `src/prompt.ts` | Prompts de sistema e de usuário |
| `src/settings.ts` | Opções salvas em `chrome.storage.local` |

Fluxo: painel → lê as últimas N mensagens do DOM → service worker →
`api.anthropic.com` → rascunho no painel → você revisa → "Inserir no chat" →
você pressiona Enter.

## Segurança e limites

- **A chave fica só no seu navegador** (`chrome.storage.local`). Use uma chave
  dedicada com limite de gastos.
- **As mensagens da conversa são enviadas à API da Anthropic.** Não use em
  conversas cujo conteúdo você não pode compartilhar.
- **Mensagens de terceiros são tratadas como dados.** O prompt manda ignorar
  instruções embutidas nelas, e a extensão não tem nenhuma ação além de
  escrever texto.
- **Sem envio automático.** Automatizar o envio no WhatsApp viola os termos de
  uso e pode banir o número.
- **Seletores frágeis.** Se o WhatsApp mudar o HTML e a extensão parar de ler
  mensagens, ajuste `SELECTORS` em `src/whatsappDom.ts`.
- Só lê mensagens de texto; mídia e áudio são ignorados.
