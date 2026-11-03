# 09 · Estimativa de infraestrutura

> Estimativa de ordem de grandeza. Os preços de nuvem mudam: confirme na calculadora do provedor escolhido. As medições de tempo de renderização vêm de `07-testes.md`.

## Premissas

| Premissa | Valor |
|---|---|
| Usuários ativos por mês | 1.000 |
| Exportações por usuário/mês | 20 (média de 3 min, 1080p) |
| Minutos exportados/mês | 60.000 |
| Uploads por usuário/mês | 5 GB |
| Retenção de mídia | Originais enquanto houver projeto; exportações por 30 dias |
| Fator de renderização medido (720p, 4 vCPU, `veryfast`) | Ver `07-testes.md`; 1080p custa ~2× mais CPU que 720p |
| Gerações por IA | Custo variável, repassado ou limitado por orçamento do workspace |

## Dimensionamento

| Componente | Recomendação inicial | Observação |
|---|---|---|
| Web (Next.js) | 2 × 1 vCPU / 1 GB | Sem processamento de mídia |
| API (Fastify) | 2 × 1 vCPU / 1 GB | Uploads vão direto ao S3 |
| Worker de renderização | 4–8 × 4 vCPU / 8 GB (autoescala pela fila) | 1 renderização por worker; pico de memória medido em `07-testes.md` |
| Worker de mídia (ingestão e proxies) | 2 × 2 vCPU / 4 GB | Proxies VP9 em modo realtime |
| PostgreSQL | Gerenciado, 2 vCPU / 4 GB, 50 GB | Documentos JSON de projeto + projeção |
| Redis | Gerenciado, 1 GB | Filas e rate limit |
| Armazenamento S3 | ~5 TB/mês de entrada no cenário acima | Ciclo de vida: exportações 30 d, proxies recriáveis |
| Saída (egress) | Downloads e prévias | Considere CDN para proxies |

## Custo de renderização (fórmula)

```
horas_de_CPU = minutos_exportados × (fator_cpu_1080p / 60)
custo = horas_de_CPU × preço_vCPU_hora
```

Com o fator medido (720p), ×2 para 1080p e ×5 para 4K (0,59× tempo real medido em 4 vCPU, pico de 1,6 GB), aplique o preço/hora de vCPU do seu provedor. Instâncias spot ou preemptíveis reduzem o custo, porque a renderização é retomável por blocos.

## Escala

- Workers horizontais (BullMQ). A concorrência de renderização por réplica é 1 para memória previsível.
- Retomada por blocos permite usar instâncias interrompíveis.
- Para mais de 15 minutos: aumentar `MAX_PROJECT_SECONDS`, o disco temporário (≈ 3× o tamanho final) e o timeout. Considere renderização de blocos em paralelo entre workers (próxima etapa: hoje os blocos de um job são sequenciais).

## Docker Compose (um servidor)

`infra/docker-compose.yml` sobe PostgreSQL, Redis, API (aplica as migrations ao iniciar), worker e web. Validado em 23/10/2026: build das três imagens, `up`, seed e os 8 testes E2E contra os contêineres.

- **Armazenamento:** driver **local** num volume `media` compartilhado entre API e worker; a API serve as URLs assinadas (HMAC, Range). Não depende de servidor S3. Para várias máquinas, use `STORAGE_DRIVER=s3` com AWS S3, Cloudflare R2, Backblaze B2 ou outro serviço compatível (variáveis `S3_*`) e configure o CORS do bucket para a origem da web (PUT, GET e cabeçalho `ETag` exposto).
- **MinIO removido:** as imagens `minio/minio` e `minio/mc` deixaram de ser publicadas e foram retiradas dos registros públicos. Elas não podem mais ser baixadas, e o Compose anterior falhava por isso.
- **Proxy da web:** `/api/*` é encaminhado pela rota `apps/web/src/app/api/[...path]/route.ts`, que lê `API_INTERNAL_URL` em tempo de execução. Antes, um rewrite do `next.config` fixava `localhost:4000` no build e a web em contêiner não alcançava a API.
- **Imagens:** `sh infra/build-images.sh`. Em rede com inspeção TLS: `EXTRA_CA_CERT=/caminho/ca.crt sh infra/build-images.sh` e, para subir, acrescente `-f infra/docker-compose.ca.yml`. A CA entra como segredo de build e não fica gravada na imagem.
- **Proxy reverso:** em produção, ponha a web atrás de um proxy (Nginx, Caddy, Traefik) que **sobrescreva** `X-Forwarded-For` e termine TLS. A API só aceita esse cabeçalho de proxies em `TRUST_PROXY` (padrão: loopback e redes privadas).
- **Tamanho das imagens:** ~3 GB cada, porque levam todas as dependências do monorepo (inclusive as de desenvolvimento). Otimização pendente: estágios de produção com `npm ci --omit=dev` por app.
