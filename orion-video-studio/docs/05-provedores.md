# 05 · Guia de configuração dos provedores

Todas as chaves ficam **somente** no `.env` da API e do worker. O frontend nunca as recebe, e as respostas da API nunca as incluem (há teste de integração para isso). Sem chave, a integração aparece como **“Configuração pendente”** e nenhuma chamada é feita. Também não existe sucesso simulado fora do modo de teste.

| Provedor | Uso | Variáveis | Estado no repositório |
|---|---|---|---|
| Google Veo (Gemini API) | Texto→vídeo e imagem→vídeo por cena | `GEMINI_API_KEY` (opcional: `GEMINI_VEO_MODELS_JSON`) | 🟡 Implementado conforme a documentação pesquisada; testado com HTTP simulado; **não exercitado contra a API real** (o host da documentação estava bloqueado no ambiente de desenvolvimento) |
| ElevenLabs | Narração pt-BR com tempo por caractere | `ELEVENLABS_API_KEY` | 🟡 Contrato testado com HTTP simulado; sem chave real |
| OpenAI Images | Imagens de storyboard (`gpt-image-1`) | `OPENAI_API_KEY` | 🟡 Idem |
| OpenAI Whisper | Transcrição com tempo por palavra e segmento | `OPENAI_API_KEY` | 🟡 Idem; o worker divide o áudio em blocos de 10 min (limite de 25 MB) |
| Anthropic Claude | Roteiro, aberturas, interpretação de comandos livres e **tradução de legendas** | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | 🟡 Saída validada por schema; sem chave, o assistente usa o organizador local (rotulado “sem IA”) |
| Geração musical | — | — | ⏳ Interface reservada; só será ativada com API oficial, credenciais e termos que permitam sincronização comercial |
| Provedores simulados | Testes automatizados e demonstração offline | `PROVIDERS_MOCK=1` | ✅ Geram mídia real marcada “MODO DE TESTE”, custo 0, sem tempo por palavra inventado |

## Endpoints usados (conferir antes de produção)

**Veo** (`packages/providers/src/veo.ts`)
- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning`, cabeçalho `x-goog-api-key`. Corpo: `{ instances: [{ prompt, image? }], parameters: { aspectRatio, durationSeconds, resolution, negativePrompt?, seed? } }`.
- `GET https://generativelanguage.googleapis.com/v1beta/{operation.name}` até `done: true`.
- Vídeo em `response.generateVideoResponse.generatedSamples[0].video.uri`, baixado com o mesmo cabeçalho. Por segurança, só o host `generativelanguage.googleapis.com` é aceito.
- Modelos confirmados: `veo-3.1-generate-preview` e `veo-2.0-generate-001`. As durações aceitas (4/6/8 s para Veo 3.1; 5–8 s para Veo 2) vêm da referência do Vertex AI e **precisam ser conferidas**. Sobrescreva com `GEMINI_VEO_MODELS_JSON` se necessário.
- O adapter não envia imagens de referência de personagem como parâmetro (o formato não foi verificado). Os personagens entram no prompt textual, e a imagem inicial vai em imagem→vídeo.

**ElevenLabs** (`elevenlabs.ts`)
- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128`, cabeçalho `xi-api-key`. Resposta: `audio_base64` + `alignment.{characters, character_start_times_seconds, character_end_times_seconds}`.
- `GET https://api.elevenlabs.io/v1/voices`.
- Dicionário de pronúncia: substituição local (funciona com qualquer provedor) e `pronunciation_dictionary_locators` quando houver IDs.

**OpenAI** (`openai.ts`)
- `POST /v1/images/generations` `{ model: 'gpt-image-1', prompt, size, n: 1 }` → `data[0].b64_json`.
- `POST /v1/audio/transcriptions` (multipart) `model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities[]=word` e `segment`.

**Anthropic** (`anthropic.ts`)
- `POST https://api.anthropic.com/v1/messages`, cabeçalhos `x-api-key` e `anthropic-version: 2023-06-01`.
- **Tradução de legendas** (`translate.ts`, rota `POST /api/projects/:id/captions/translate`): lotes de 60 legendas em JSON `{items:[{i,text}]}`, resposta validada por schema; se faltar qualquer item, a tradução falha e nada muda. Os tempos são preservados e o tempo por palavra é descartado. Sem chave, a interface mostra “Configuração pendente”; com `PROVIDERS_MOCK=1`, o simulador apenas prefixa `[TESTE→idioma]` (não traduz). Como no assistente, a chamada é síncrona e **não passa pelo orçamento de gerações** (custo por token sem preço verificado; ver pendências).

## Preços e estimativa de custo

`packages/providers/pricing.json` traz os preços em **centavos de USD** por unidade (segundo de vídeo, imagem, mil caracteres, minuto), com `source` e `verifiedAt`. O padrão é `null` para todos os provedores reais, porque não havia tabela verificável no ambiente de desenvolvimento.

- Sem preço configurado, a geração é **bloqueada** (`pricing_missing`). Para liberar por sua conta: `ALLOW_UNPRICED_GENERATION=1`.
- **Estimado**: unidades pedidas × preço. **Confirmado**: unidades produzidas (por exemplo, duração real do vídeo) × preço. O valor confirmado não substitui a fatura do provedor.
- O orçamento mensal por workspace (`DEFAULT_GENERATION_BUDGET_CENTS`) soma o confirmado e o estimado em andamento.

## Como adicionar um provedor

1. Implemente a interface em `packages/providers/src/types.ts` (`VideoAdapter`, `ImageAdapter`, `TtsAdapter`, `TranscriptionAdapter` ou `ScriptAdapter`), declarando modelos, durações, resoluções, formatos, áudio, referências, seeds e limites.
2. Use `request()` de `http.ts`, que classifica 429, 401/403 e 5xx e nunca inclui a chave na mensagem.
3. Registre em `registry.ts` e adicione o preço em `pricing.json` com fonte e data.
4. Escreva um teste de contrato com `fetch` simulado (ver `packages/providers/test/providers.test.ts`).

## Clonagem de voz

O sistema não clona vozes. A clonagem é feita no console do provedor, segundo as regras dele. Uma voz marcada como clonada só pode ser salva com **autorização registrada** (titular, quem autorizou, data e termo), e isso gera um evento de auditoria.
