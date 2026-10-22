# 01 · Produto: brainstorm, decisões e backlog

## 1. Dez diferenciais avaliados

Escala de 1 a 5. Utilidade: quanto maior, melhor. Complexidade e custo operacional: quanto maior, pior.

| # | Diferencial | Utilidade | Complexidade | Custo operacional | Dependências | Decisão |
|---|---|---|---|---|---|---|
| 1 | Roteiro longo → storyboard | 5 | 2 | 1 (local) / 2 (LLM) | Nenhuma (organizador local); LLM opcional | **Selecionado** |
| 2 | Editar vídeo pelo texto transcrito | 5 | 5 | 3 (transcrição) | Transcrição com tempo por palavra; mapeamento texto → clipes | Fase 5 |
| 3 | Regenerar só uma cena ou uma frase | 5 | 3 | Proporcional ao trecho | Adapters de TTS/vídeo; versões | **Selecionado** |
| 4 | Cortes curtos a partir de um vídeo longo | 4 | 4 | 2 | Transcrição + heurística de destaque | Fase 5 |
| 5 | Identidade visual em lote | 4 | 2 | 1 | Kits de marca | **Selecionado** |
| 6 | Detectar silêncio e sugerir cortes | 4 | 2 | 1 (CPU) | FFmpeg `silencedetect` | Implementado como bônus (painel Mídia) |
| 7 | Sincronizar narração, cenas e legendas | 5 | 3 | 1 | Tempo inteiro; alinhamento real do provedor | **Selecionado** |
| 8 | Fichas de referência de personagens | 4 | 2 | 1 | Prompts e referências | Implementado (sem promessa de identidade) |
| 9 | Variações de abertura | 3 | 1 | 1 | Assistente | Implementado (3 opções no assistente) |
| 10 | Estimativa de custo antes da geração | 5 | 2 | 0 | Tabela de preços com fonte | **Selecionado** |

### Os cinco que sustentam a primeira versão

1. **Roteiro longo → storyboard (1).** É a porta de entrada para vídeos acima de 60 s. Funciona sem IA, porque o roteiro é dividido em cenas com duração estimada a 2,5 palavras/s em pt-BR. Com chave da Anthropic, o roteiro também pode ser gerado por IA.
2. **Sincronizar narração, cenas e legendas (7).** Sem isso, vídeo longo vira trabalho manual. Tudo usa tempo inteiro (flicks), e as legendas ficam vinculadas aos clipes.
3. **Regenerar só uma cena ou uma frase (3).** Reduz custo e retrabalho. Cada cena e cada frase é um trabalho independente, com histórico de versões e aprovação.
4. **Estimativa de custo antes da geração (10).** Torna o custo de IA previsível. Quando não há preço confiável, a geração fica bloqueada.
5. **Identidade visual em lote (5).** Dá consistência a séries e perfis, por exemplo “Luís Henrique de Matos / @ovendedordeaco08”.

O critério (Pareto) foi escolher os cinco que destravam o fluxo **ideia → vídeo longo editável → exportação** com o menor custo variável. Editar pelo texto (2) e gerar cortes curtos (4) dependem de transcrição paga com tempo por palavra e de heurísticas que precisam de dados reais, por isso ficaram para a Fase 5.

## 2. Decisões técnicas e motivos

| Decisão | Motivo |
|---|---|
| **Tempo em flicks (1/705.600.000 s), inteiro** | Divide exatamente todos os fps suportados (incluindo 23,976 e 29,97) e todas as taxas de amostragem comuns. Elimina deriva por ponto flutuante. Conversões em BigInt. |
| **Documento JSON como fonte de verdade + projeção relacional** | Salvamento automático rápido (um UPDATE com concorrência otimista). A projeção (Timeline/Track/Clip/…) dá integridade referencial (Clip → Asset `RESTRICT`), coleta de lixo segura e consultas. |
| **Revisão imutável por exportação** | Editar durante a exportação não altera o resultado. O RenderJob referencia `ProjectRevision` com `onDelete: Restrict`. |
| **Renderização em blocos de 30 s + stems de áudio** | Memória limitada (cada bloco abre só os clipes que o intersectam), retomada após falha (blocos com nome por hash) e progresso real. Os blocos têm número exato de frames e são concatenados sem recodificar. |
| **Animações como funções por partes** | A prévia avalia em JS e a exportação gera expressões FFmpeg a partir dos mesmos segmentos. Coerência garantida por construção e testada. |
| **Quebra de linha decidida em JS com métricas reais da fonte** | Texto e legendas quebram nos mesmos pontos na prévia (canvas) e na exportação (drawtext/libass). |
| **Zustand + immer no editor** | Histórico de undo/redo por referência imutável (compartilhamento estrutural). Coalescência de alterações contínuas, como sliders. |
| **Fastify + zod (contratos compartilhados) → OpenAPI gerado** | Uma única fonte de schemas para validação e documentação (`docs/openapi.json`). |
| **Prisma 7 com driver adapter `pg`** | Versão estável atual, sem motor binário de consulta. |
| **BullMQ 5 (não 6)** | A versão 6 mudou dependências pares recentemente. A 5.81 é madura, e a API é conhecida e testada aqui. |
| **Armazenamento com dois drivers (S3 e local assinado)** | Mesma semântica (URL assinada, multipart, expiração). Desenvolvimento e testes rodam sem MinIO. |
| **Proxies H.264 e VP9/Opus** | A prévia funciona em Chrome/Safari/Firefox (H.264) e em navegadores sem codecs proprietários (Chromium puro), escolhendo por `canPlayType`. |
| **npm workspaces + vitest** | Projeto independente do monorepo pai (Bun). `--legacy-peer-deps` contorna um bug do npm 10.9 com o peer set do vitest. |
| **Ajustes na estrutura pedida** | Foram adicionados `packages/db` (Prisma e migrations, compartilhado por API, worker e seed) e `packages/server` (armazenamento, filas, projeção e auditoria, código só de servidor que não pode ir para o navegador). `packages/ui` é o design system. |

## 3. Riscos identificados (e mitigação implementada)

| Risco | Onde aparece | Mitigação |
|---|---|---|
| **Sincronização A/V** | VFR, velocidade, blocos, AAC | Normalização CFR, amostras exatas por clipe (`adelay` em amostras), fronteiras de bloco em frames inteiros, teste de flash + bipe com tolerância de 1 frame. |
| **Deriva de tempo** | Somas de frames em projetos longos | Flicks inteiros com BigInt. Teste de 15 min a 29,97 fps sem acúmulo. |
| **Memória na renderização** | Muitos clipes ou vídeo longo | Blocos de 30 s, inversão de vídeo em blocos de 2 s, nada processado no navegador. Pico medido em `07-testes.md`. |
| **Memória no navegador** | Prévia de projetos longos | Proxies 540p, pool de elementos de mídia só numa janela de ±8 s, waveform pré-calculada no worker. |
| **Divergência prévia × exportação** | Fontes, legendas, animações | Mesmas funções e métricas. Comparação por pixel no teste E2E. Matriz de efeitos aproximados. |
| **Custo de IA** | Regenerações, tomadas longas | Estimativa obrigatória, orçamento mensal, reutilização de resultado aprovado (hash do input), regenerar só o trecho, bloqueio sem preço. |
| **Cobrança duplicada** | Retentativas | Chave de idempotência por pedido. ID remoto gravado antes do poll. Chamadas síncronas interrompidas não são repetidas automaticamente. |
| **Mídia maliciosa** | Uploads | `protocol_whitelist=file`, formatos permitidos, tipo detectado igual ao declarado, timeouts, worker sem privilégios. |

## 4. Backlog por fase com critérios de aceitação

Status: ✅ implementado e testado · 🟡 implementado, depende de credencial ou não foi validado contra o serviço real · ⏳ pendente.

### Fase 1: base executável
| Item | Critério de aceitação | Status |
|---|---|---|
| Projeto local executável | `npm install`, migrations, seed e os 3 processos sobem com os comandos do README | ✅ |
| Autenticação | Registro, login, logout, sessão httpOnly, senha scrypt, rate limit no login | ✅ (teste de integração) |
| Upload | URL assinada; multipart > 32 MB; tipo e tamanho validados; ffprobe; miniatura, waveform e proxies | ✅ |
| Persistência | Salvar e reabrir idêntico; 409 em conflito; recuperação de rascunho local após recarregar | ✅ |
| Timeline básica | Múltiplas trilhas, cortar, dividir, duplicar, excluir, ripple, imã, zoom, mute/solo/lock/hide, undo/redo | ✅ (unitários + interface) |
| Exportar 90 s | MP4 H.264/AAC validado (duração ±1 frame, streams, dimensões, decodificação completa) | ✅ |

### Fase 2: templates, efeitos, legendas, música
| Item | Critério | Status |
|---|---|---|
| 10 templates originais versionados | Validados por schema, aplicáveis em todos os formatos declarados, sem erro de validação | ✅ |
| Salvar, duplicar e editar templates próprios | Nova versão a cada salvamento; duplicar do sistema | ✅ |
| Efeitos essenciais | Matriz prévia × exportação; só itens exportáveis aparecem | ✅ |
| Legendas manuais | Editar texto e tempos, dividir, unir, SRT/VTT de entrada e saída, estilos, gravadas ou separadas | ✅ |
| Biblioteca musical licenciada | Busca por nome, clima, duração e BPM; prévia; favoritos; licença completa por faixa; upload com declaração | ✅ (catálogo CC0 próprio) |

### Fase 3: transcrição, voz e cenas por IA
| Item | Critério | Status |
|---|---|---|
| Transcrição automática | Segmentos e palavras vinculados ao clipe; blocos de 10 min | 🟡 contrato testado com mock HTTP; sem chave real |
| Voz automática pt-BR | Frase a frase, tempo por caractere do provedor, regenerar uma frase (preservar/deslocar), versões | 🟡 fluxo completo testado com provedor simulado; ElevenLabs sem chave real |
| Cenas por IA (Veo) | Tomadas respeitando as durações do modelo; operação longa; download; substituir uma cena | 🟡 fluxo testado com provedor simulado; endpoint Veo pesquisado, não exercitado |
| Imagens de storyboard | Gerar por cena, comparar com referências, aprovar | 🟡 idem (OpenAI Images) |

### Fase 4: vídeos longos, proxies, recuperação e custos
| Item | Critério | Status |
|---|---|---|
| 5 e 15 minutos | Exportação validada; tempo e memória registrados | ✅ (ver `07-testes.md`) |
| Proxies | 540p H.264 + VP9/Opus | ✅ |
| Recuperação de jobs | Matar o worker no meio: o novo worker retoma e reaproveita blocos | ✅ (teste de integração) |
| Controles de custo | Estimado × confirmado, orçamento mensal, ledger | ✅ |
| 4K | Validar recursos, tempo e custo antes de liberar | ⏳ |

### Fase 5: edição por texto, automações e recursos avançados
| Item | Critério | Status |
|---|---|---|
| Detectar silêncio e sugerir cortes | Cortar trechos com ripple e desfazer | ✅ (antecipado) |
| Assistente por comandos | Comandos estruturados validados, prévia de diferenças, desfazer | ✅ (parser local; LLM opcional 🟡) |
| Editar vídeo pelo texto | Apagar palavras na transcrição corta o vídeo | ⏳ |
| Cortes curtos automáticos | Sugerir trechos de 30 a 60 s de um vídeo longo | ⏳ |
| Máscaras, remoção de fundo, rastreamento | Fases próprias com dependências e custos explícitos | ⏳ |
| Tradução de legendas | Só com serviço funcional e testado | ⏳ (não oferecida na interface) |
