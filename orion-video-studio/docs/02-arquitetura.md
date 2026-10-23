# 02 · Arquitetura

## Visão geral

```
┌──────────────┐  same-origin /api/*   ┌──────────────┐   jobs (BullMQ)   ┌──────────────────┐
│ apps/web     │ ───────────────────▶  │ apps/api     │ ────────────────▶ │ apps/worker      │
│ Next.js 16   │  (proxy em runtime)   │ Fastify 5    │                   │ FFmpeg/ffprobe   │
│ editor, UI   │ ◀── URLs assinadas ── │ auth, regras │ ◀── estado (DB) ─ │ mídia, render,   │
└──────┬───────┘                       └──────┬───────┘                   │ gerações, GC     │
       │ upload/download direto               │                           └───────┬──────────┘
       ▼                                      ▼                                   ▼
┌─────────────────────────┐   ┌────────────────┐   ┌───────────┐   ┌──────────────────────────┐
│ Armazenamento S3/local  │   │ PostgreSQL 16  │   │ Redis 7   │   │ Provedores (opcionais)   │
│ originais, proxies,     │   │ Prisma 7       │   │ filas,    │   │ Veo, ElevenLabs, OpenAI, │
│ exportações             │   │                │   │ rate limit│   │ Anthropic — só no servidor│
└─────────────────────────┘   └────────────────┘   └───────────┘   └──────────────────────────┘
```

- **Processamentos longos nunca rodam no ciclo HTTP.** A API grava o registro (Asset, RenderJob, GenerationJob) e enfileira. O worker executa e atualiza o banco, e a interface acompanha por polling. A única exceção é o assistente com LLM, uma chamada síncrona com timeout de 180 s e fallback local.
- **O navegador nunca recebe chaves.** Ele só conhece `/api/*` (mesma origem). As chaves vivem no `.env` da API e do worker.
- **O navegador não processa vídeo.** Prévia com proxies 540p. Exportação, inversão, congelamento de quadro e detecção de silêncio rodam no worker.

## Repositório

```
orion-video-studio/
├── apps/
│   ├── web/        Next.js 16 + React 19 + Tailwind 4 (editor, páginas)
│   ├── api/        Fastify 5 (rotas, autorização, OpenAPI)
│   └── worker/     BullMQ workers (mídia, render, gerações, manutenção) + seed
├── packages/
│   ├── shared/     schemas zod (documento, templates, contratos HTTP), templates, i18n, matriz de efeitos
│   ├── timeline/   tempo em flicks, operações de edição, avaliação, expressões, legendas, templates, storyboard, comandos
│   ├── media/      ffprobe, derivados, grafo de renderização, ASS, pipeline e validação
│   ├── providers/  adapters (Veo, ElevenLabs, OpenAI, Anthropic, simulados), preços, assistente
│   ├── server/     armazenamento (S3/local), filas, projeção da timeline, auditoria, consumo  ← adicionado
│   ├── db/         schema Prisma, migrations, cliente                                       ← adicionado
│   └── ui/         design system acessível (Button, ToolButton, Dialog, Slider, Toast…)
├── assets/         fontes Inter (OFL), música e efeitos demonstrativos (CC0), catalog.json
├── infra/          Dockerfile multialvo + docker-compose
├── docs/           esta documentação + openapi.json
├── scripts/        make-fixtures.ts (gera fixtures e biblioteca musical)
└── tests/          integração (API+worker reais), E2E (Playwright), fixtures
```

As adições foram `packages/server` e `packages/db`. API e worker compartilham código que não pode ir para o navegador (SDK S3, BullMQ, Prisma). Colocá-lo em `packages/shared` quebraria o bundle web.

## Fluxos principais

### Upload
1. `POST /api/workspaces/:ws/uploads` valida tipo, tamanho e cota, cria Asset (PENDING) e Upload, e devolve uma URL assinada (≤ 32 MB) ou URLs por parte (multipart de 16 MB).
2. O navegador envia direto ao armazenamento, sem passar pela API quando o driver é S3.
3. `POST /api/uploads/:id/complete` confere o tamanho e enfileira `ingest`.
4. O worker roda ffprobe (`protocol_whitelist=file`), recusa formato fora da lista ou tipo divergente, gera miniatura, waveform (picos) e proxies, e marca READY.

### Edição e salvamento
- As operações são funções puras (`packages/timeline/src/ops.ts`) aplicadas pelo store Zustand, que guarda um histórico de documentos imutáveis.
- Salvamento automático 1,2 s após a última alteração: `PUT /api/projects/:id` com `baseVersion`. Versão divergente devolve 409 e um aviso de conflito. A cada alteração o rascunho também é gravado no `localStorage`, e é recuperado ao recarregar.
- O servidor valida o schema, garante que os ativos citados pertencem ao workspace, atualiza a projeção relacional e cria uma revisão automática a cada 10 min.

### Exportação
1. `POST /api/projects/:id/renders` valida o projeto (ativos prontos, limites), cria uma **revisão imutável** e um RenderJob, e enfileira.
2. O worker baixa os ativos, normaliza os vídeos (CFR, rotação, yuv420p), renderiza blocos de 30 s, mixa stems por trilha, faz o master (ducking, limitador, −14 LUFS), o mux e a **validação**, e armazena.
3. Estados: `queued → running → succeeded | failed | canceled`, com progresso por etapa, até 3 tentativas e cancelamento cooperativo.
4. Recuperação: um job travado volta à fila (stalled do BullMQ) e é retomado no mesmo diretório de trabalho, reaproveitando blocos, normalizações e stems pelo hash do comando. A reconciliação a cada 5 min reenfileira jobs “running” órfãos.

### Geração por IA
1. Estimativa (`/generations/estimate`): adapter, capacidades e preço configurado.
2. Criação com `idempotencyKey` e `acceptEstimatedCents` igual à estimativa atual. Verifica o orçamento mensal. Um resultado aprovado com o mesmo hash de input é reutilizado sem custo.
3. Vídeo é uma operação longa: o worker grava o **ID remoto** antes de consultar, e retentativas reconciliam pelo ID em vez de pedir de novo. Imagem, voz e transcrição são síncronas, com um marcador gravado antes da chamada: se o worker cair depois de chamar, não há repetição automática.
4. O resultado vira um Asset (GENERATED/TTS) que passa pela ingestão normal. O ledger passa de ESTIMATED a CONFIRMED (quantidade real × tabela) ou VOID.

## Base temporal e coerência prévia × exportação

- `packages/timeline/src/time.ts`: flicks, `framesToFlicks`, `flicksToSamples`, `quantize`, `formatSecondsArg` (decimal exato para o FFmpeg). Todos os clipes ficam alinhados ao grid de frames do projeto.
- `evaluate.ts`: keyframes, animações de texto (fade, slide-up, pop), transições (fade e dissolve com extensão do clipe anterior) e fades de áudio, todos reduzidos a funções por partes com easing expressável.
- `expr.ts`: as mesmas funções viram expressões FFmpeg (`if/lt/clip`). Um teste avalia as expressões com um avaliador do subconjunto e compara com o JS em centenas de instantes.
- Opacidade variável usa `sendcmd` por frame, com valores calculados pela mesma função da prévia.
- Texto: `wrapText` usa larguras de avanço reais da Inter (`font-metrics.ts`, gerado das fontes). Linhas idênticas no canvas e no `drawtext`. Altura de linha corrigida pela métrica 1,211 em.
- Legendas: `wrapCaptionTokens` define as linhas da prévia e do ASS (`WrapStyle: 2`, `\N` explícito). O tamanho no libass é convertido de em para altura de linha.

## Estado do editor (Zustand)

`components/editor/store.ts`: `history {past, present, future}` (limite de 200), `apply(fn, {coalesce})` (erros de edição viram aviso, sliders coalescem numa entrada), seleção, cursor, zoom, imã, cache de ativos e estado de salvamento. O Zustand foi escolhido por ser leve, permitir seletores sem re-renderização global e tornar o estado acessível fora do React (motor de reprodução, atalhos).

## Internacionalização

`packages/shared/src/i18n.ts` define o dicionário pt-BR de referência, idiomas parciais com fallback e `translate()`. A interface usa `useT()` para navegação, autenticação, projetos, estados e provedores. **Pendência:** extrair para o dicionário os textos dos painéis do editor, que ainda estão literais em pt-BR.
