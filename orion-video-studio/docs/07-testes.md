# 07 · Testes, resultados executados e desempenho

## Suítes

| Suíte | Arquivo | O que comprova | Como rodar |
|---|---|---|---|
| Domínio da timeline | `packages/timeline/test/timeline.test.ts` | Base temporal sem deriva (15 min a 29,97 fps); dividir, mover, aparar, velocidade, duplicar, ripple, imã, undo/redo; legendas (SRT/VTT, dividir/unir, vínculo ao clipe); regenerar frase (preservar × deslocar); **expressões FFmpeg = avaliação JS**; 10 templates válidos em todos os formatos; storyboard e tomadas por duração do provedor; montagem > 60 s; comandos do assistente | `npx vitest run packages/timeline` |
| Provedores | `packages/providers/test/providers.test.ts` | Estados “pendente/teste”; contrato HTTP do Veo, ElevenLabs e Whisper (fetch simulado); classificação de quota; a chave nunca aparece em erros; assistente local × LLM validado por schema | `npx vitest run packages/providers` |
| Armazenamento | `packages/server/test/storage.test.ts` | Tokens assinados (expiração, adulteração), path traversal, multipart local; **driver S3 contra s3rver** (PUT/GET pré-assinados, multipart, upload pelo servidor) | `npx vitest run packages/server` |
| Mídia e renderização | `packages/media/test/render.test.ts` | Rotação, VFR, imagem; **exportação de 90 s** com vídeo, imagem, texto animado, keyframes, logotipo, música, narração e legendas gravadas; retomada com reaproveitamento; **sincronia A/V ≤ 1 frame**; posição de keyframe por pixel; transparência de texto (regressão) | `npx vitest run packages/media` |
| Integração (API + worker + Postgres + Redis + FFmpeg reais) | `tests/integration/api.test.ts` | Autenticação, CSRF, rate limit; upload simples e **multipart > 32 MB**; tipo falso recusado; tamanho divergente recusado; salvar e reabrir; 409 de concorrência; **isolamento entre usuários** (leitura, escrita, exportação, mídia, legendas, referência a mídia alheia); exclusão de mídia em uso; SRT/VTT; versões; **exportação de 95 s** com edição concorrente (revisão imutável) e idempotência; **ducking medido**; configuração pendente; preço ausente; duração não suportada; estimativa obrigatória; TTS; **regeneração de uma frase com versões**; reutilização de aprovado; ledger; cena em vídeo com operação longa; **chave não vaza**; **matar o worker no meio da exportação** | `npx vitest run tests/integration/api.test.ts` |
| Exportações longas | `tests/integration/long.test.ts` | **5 e 15 minutos** via API e worker, com tempo e pico de memória | `RUN_LONG=15 npx vitest run tests/integration/long.test.ts` |
| Interface (Playwright) | `tests/e2e/editor.spec.ts` | Cadastro → projeto → upload pelo seletor → adicionar à timeline → dividir (S) → desfazer/refazer → salvar → recarregar; recuperação de alterações sem rede; **exportar pela interface e comparar prévia × arquivo exportado por pixel**; template com campo; layout móvel; nenhum segredo do `.env` em HTML/JS/respostas | `npx playwright test` (com a stack rodando) |

Serviços pagos usam **mocks** nos testes automatizados (fetch simulado nos contratos, `PROVIDERS_MOCK=1` na integração). Testes reais são opcionais: configure as chaves e use o editor.

## Resultados executados (22/10/2026)

| Suíte | Resultado |
|---|---|
| Timeline | **30/30** ✅ |
| Provedores | **12/12** ✅ |
| Armazenamento | **7/7** ✅ |
| Mídia e renderização | **7/7** ✅ (≈ 100 s) |
| Integração | **24/24** ✅ (≈ 3 min) |
| Exportações longas | **2/2** ✅ (5 e 15 min) |
| E2E Playwright | **6/6** ✅ (≈ 40 s) |
| Typecheck (`npm run typecheck`, todos os workspaces) | **0 erros** ✅ |
| Build de produção da web (`next build`) | ✅ |

Medições relevantes desses testes:

- **Prévia × exportação:** diferença média de luminância de **0,33/255** (quadro do canvas vs. quadro do MP4 no mesmo instante, reduzidos a 32×56). O limite do teste é 12/255.
- **Sincronia A/V:** flashes e bipes alinhados dentro de **1 frame (33,3 ms)**, mesmo com `sourceIn` ≠ 0 e fronteiras de bloco no meio do material.
- **Ducking:** a música fica **> 3 dB** mais baixa durante a fala (energia acima de 1 kHz), e a diferença fora da fala é < 1 dB.
- **Recuperação:** com o worker morto (SIGKILL) a ~35% da exportação, o novo worker concluiu com `attempts ≥ 2` e `reusedIntermediates > 0`.

## Desempenho (ambiente declarado)

| Item | Valor |
|---|---|
| CPU | 4 vCPU — Intel Xeon @ 2,10 GHz |
| RAM | 16 GB |
| SO / FFmpeg | Linux 6.18 (contêiner) · FFmpeg 6.1.1 (Ubuntu) |
| Preset | 720p, H.264 `veryfast` CRF 23, legendas gravadas, `loudnorm`, blocos de 30 s, concorrência de render = 1 |
| Conteúdo | Vídeo 1080p30 em loop, narração a cada 40 s, música contínua, legenda a cada 6 s |

| Duração | Tempo de exportação | Fator tempo real | Pico de memória (worker + FFmpeg) | Arquivo |
|---|---|---|---|---|
| 90 s (projeto de exemplo: imagem 1080×1920 com zoom animado por 70 s, `veryfast` CRF 20) | 70,7 s | 1,27× | — | — |
| **5 min** | **104 s** | **2,89×** | **456 MB** | 43 MB |
| **15 min** | **295 s** | **3,05×** | **455 MB** | 130 MB |

O exemplo de 90 s é mais lento por segundo porque a escala animada (`scale` com `eval=frame`) redimensiona uma imagem grande a cada quadro (ver otimização em `08-pendencias.md`). A memória é **constante** em relação à duração, por causa da renderização em blocos. 1080p custa cerca de 2× mais CPU. Projetos maiores dependem de `MAX_PROJECT_SECONDS`, de disco temporário (≈ 3× o arquivo final) e do plano.

## Tolerâncias

Ver `04-midia-e-renderizacao.md › Tolerâncias de sincronização`.
