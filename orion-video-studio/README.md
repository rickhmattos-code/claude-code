# ORION VIDEO STUDIO

Editor de vídeo em timeline com templates, narração, legendas, biblioteca musical licenciada e cenas por IA. Exporta vídeos **acima de 60 segundos** (validados com 90 s, 5 min e 15 min). Interface em português do Brasil, com arquitetura preparada para outros idiomas.

> Identidade: grafite quente com **Âmbar Betelgeuse** (`#F2A93B`) e **Azul Rigel** (`#7B93FF`), as duas estrelas mais brilhantes de Órion. Logo: o cinturão de três estrelas.

## O que funciona, o que depende de credencial e o que está pendente

| | Situação |
|---|---|
| ✅ **Implementado e testado** | Contas e workspaces · upload direto (URL assinada, multipart) · inspeção ffprobe, miniatura, waveform e proxies · timeline com várias trilhas (cortar, dividir, duplicar, excluir, ripple, imã, zoom, mute/solo/lock/hide, keyframes, velocidade, congelar quadro, inverter, marcadores, áreas seguras) · undo/redo · salvamento automático com concorrência otimista · recuperação após recarregar · histórico de versões · 10 templates versionados + templates próprios · efeitos e transições exportáveis · legendas (editar, dividir, unir, SRT/VTT, estilos, gravadas ou separadas) · biblioteca musical com licenças · ducking · kits de marca em lote · personagens com referências autorizadas · assistente (roteiro → storyboard, 3 aberturas, comandos estruturados com prévia e desfazer) · detecção de silêncio com cortes · exportação MP4 H.264/AAC 720p/1080p validada · recuperação de falha do worker · estimativa e controle de custos · isolamento entre usuários |
| 🟡 **Exige credenciais** (implementado; contrato testado com HTTP simulado; não exercitado contra a API real) | Google Veo (cenas em vídeo) · ElevenLabs (voz pt-BR com tempo por caractere) · OpenAI Images (storyboard) · OpenAI Whisper (transcrição) · Anthropic (roteiro e comandos livres). Sem chave, aparece “Configuração pendente”; com `PROVIDERS_MOCK=1`, provedores simulados geram mídia real marcada “MODO DE TESTE” |
| ⏳ **Pendente** | Editar vídeo pelo texto · cortes curtos automáticos · máscaras · remoção de fundo · rastreamento · 4K · tradução · geração musical · extração completa dos textos do editor para o dicionário i18n · Docker Compose não validado neste ambiente (sem daemon Docker) |

Detalhes em [`docs/08-pendencias.md`](docs/08-pendencias.md).

## Requisitos

- **Node.js 22** (testado com 22.22.0) e npm 10
- **PostgreSQL 16** e **Redis 7**
- **FFmpeg 6.1+** com `libx264`, `libass`, `libvpx`, `libopus`, `drawtext` (com `text_align`), `colortemperature`, `sidechaincompress` e `loudnorm`. O pacote do Ubuntu 24.04 atende.
- Opcional: Docker 24+ com Compose v2

## Executar localmente (sem Docker)

```bash
cd orion-video-studio
cp .env.example .env                      # ajuste DATABASE_URL/REDIS_URL se necessário
npm install                               # usa .npmrc (legacy-peer-deps)
npm run db:generate                       # cliente Prisma
npm run db:migrate                        # aplica migrations
npm run fixtures                          # (opcional) regenera fixtures e música demo — já versionadas
SEED_DEMO=1 npm run db:seed               # catálogo musical, 10 templates, usuário demo e projeto de 90 s
```

Em três terminais:

```bash
npm run dev:api        # http://localhost:4000  (OpenAPI em /api/openapi.json)
npm run dev:worker     # processamento de mídia, exportações e gerações
npm run dev:web        # http://localhost:3000
```

Entre com **demo@orion.local / orion-demo-2026** e abra **“Exemplo — 90 segundos”**, ou crie uma conta.

Banco e Redis rápidos para desenvolvimento (exemplo Debian/Ubuntu):

```bash
sudo -u postgres psql -c "CREATE USER orion WITH PASSWORD 'orion' CREATEDB;" -c "CREATE DATABASE orion OWNER orion;"
redis-server --daemonize yes
```

## Executar com Docker Compose

```bash
cd orion-video-studio
docker compose -f infra/docker-compose.yml up --build -d
docker compose -f infra/docker-compose.yml --profile seed run --rm seed
# web http://localhost:3000 · API http://localhost:4000 · console MinIO http://localhost:9001
```

A stack sobe Postgres, Redis, MinIO (bucket criado automaticamente), API, worker (sem privilégios, com limites de CPU e memória) e web. **Atenção:** os arquivos foram escritos, mas não executados neste ambiente, por falta de daemon Docker. Confira as tags das imagens no primeiro build.

## Provedores de IA

Coloque as chaves no `.env` (somente servidor): `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Configure os preços em `packages/providers/pricing.json`: sem preço confiável, a geração fica bloqueada. Guia completo em [`docs/05-provedores.md`](docs/05-provedores.md).

## Testes

```bash
npm test                                           # unitários + mídia + integração (Postgres/Redis/FFmpeg reais)
npx vitest run packages                            # só pacotes (rápido)
RUN_LONG=15 npx vitest run tests/integration/long.test.ts   # exportações de 5 e 15 minutos
npx playwright test                                # E2E — requer web, API e worker rodando
npm run typecheck
```

Os testes de integração usam o banco `orion_test` e o Redis db 1, e recriam ambos a cada execução. Resultados executados, tolerâncias e ambiente de desempenho estão em [`docs/07-testes.md`](docs/07-testes.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 · Produto e backlog](docs/01-produto-e-backlog.md) | 10 diferenciais avaliados, 5 escolhidos, decisões, riscos, backlog com critérios de aceitação |
| [02 · Arquitetura](docs/02-arquitetura.md) | Componentes, fluxos, base temporal, coerência prévia × exportação |
| [03 · Modelo de dados](docs/03-modelo-de-dados.md) | Entidades, índices, exclusão, isolamento, imutabilidade |
| [04 · Mídia e renderização](docs/04-midia-e-renderizacao.md) | Regras de mídia, pipeline, sincronização, matriz de efeitos, licenças |
| [05 · Provedores](docs/05-provedores.md) | Configuração, endpoints, preços, como adicionar |
| [06 · Segurança e custos](docs/06-seguranca-e-custos.md) | Controles implementados e pendências |
| [07 · Testes](docs/07-testes.md) | Suítes, resultados executados, desempenho |
| [08 · Pendências](docs/08-pendencias.md) | Lista honesta do que falta |
| [09 · Infraestrutura](docs/09-infraestrutura.md) | Estimativa com premissas |
| [`openapi.json`](docs/openapi.json) | Contrato HTTP gerado dos schemas zod (`npm run openapi`) |

## Licenças de conteúdo

Código: proprietário do projeto (defina antes de distribuir). Fontes Inter: SIL OFL 1.1 (`assets/fonts/OFL.txt`). Música, efeitos e fixtures: CC0, sintetizados por `scripts/make-fixtures.ts`. FFmpeg com libx264 é GPL ao ser distribuído (ver `docs/04`).
