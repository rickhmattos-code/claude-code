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

Com o fator medido (720p) e ×2 para 1080p, aplique o preço/hora de vCPU do seu provedor. Instâncias spot ou preemptíveis reduzem o custo, porque a renderização é retomável por blocos.

## Escala

- Workers horizontais (BullMQ). A concorrência de renderização por réplica é 1 para memória previsível.
- Retomada por blocos permite usar instâncias interrompíveis.
- Para mais de 15 minutos: aumentar `MAX_PROJECT_SECONDS`, o disco temporário (≈ 3× o tamanho final) e o timeout. Considere renderização de blocos em paralelo entre workers (próxima etapa: hoje os blocos de um job são sequenciais).
