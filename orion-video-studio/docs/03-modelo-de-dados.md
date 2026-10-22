# 03 · Modelo de dados

Arquivo: `packages/db/prisma/schema.prisma` · Migration inicial: `packages/db/prisma/migrations/*_init`.

## Entidades e relacionamentos

```
User 1─* Membership *─1 Workspace
User 1─* Session
Workspace 1─* Project 1─* ProjectRevision (imutável) 1─* RenderJob
Project 1─1 Timeline 1─* Track 1─* Clip 1─* Effect / Keyframe
Timeline 1─* CaptionSegment
Workspace 1─* Asset 1─* Upload
Clip *─1 Asset            (onDelete: RESTRICT)
Workspace 1─* Template (workspaceId nulo = sistema)
Workspace 1─* BrandKit
Workspace 1─* VoiceProfile 1─* CharacterProfile 1─* CharacterReference *─1 Asset (RESTRICT)
LicenseRecord 1─* MusicTrack *─1 Asset (RESTRICT); MusicTrack *─* User via MusicFavorite
Workspace 1─* GenerationJob, RenderJob, UsageLedger, AuditEvent
```

| Entidade | Papel | Observações |
|---|---|---|
| User / Session | Conta e sessão | Senha `scrypt$N$r$p$salt$hash`; sessão guardada como sha256 do token do cookie httpOnly |
| Workspace / Membership | Isolamento e papéis | OWNER, EDITOR, VIEWER; cota de bytes e orçamento mensal de IA |
| Project | Documento atual (`document` JSON validado por `TimelineDoc`) | `docVersion` para concorrência otimista; exclusão lógica (`deletedAt`) |
| ProjectRevision | Snapshot imutável | Nenhum UPDATE no código; RenderJob → revisão com `RESTRICT` |
| Timeline / Track / Clip / Effect / Keyframe / CaptionSegment | Projeção relacional do documento | Recriada na mesma transação do salvamento; dá integridade Clip → Asset |
| Asset | Mídia (original + derivados) | Inspeção ffprobe completa, chaves de miniatura/onda/proxy, `source` (UPLOAD, RECORDING, GENERATED, TTS, RENDER, CATALOG, DERIVED) |
| Upload | Sessão de upload | SINGLE/MULTIPART, `s3UploadId`, expiração; expirados são limpos pelo worker |
| Template | Template versionado | `@@unique([workspaceId, slug, version])`; definição validada por `TemplateDefinition` |
| BrandKit | Identidade visual | Paleta, fontes, estilo de legenda, logo, marca-d’água, vinhetas, assinatura, nome e perfil |
| CharacterProfile / CharacterReference | Personagens recorrentes | Referências exigem declaração de autorização |
| VoiceProfile | Voz salva | `isClone` exige `consent` (titular, autorizado por, data, termo); dicionário de pronúncia em `settings` |
| LicenseRecord / MusicTrack / MusicFavorite | Biblioteca musical | Origem, autor, licença, uso comercial, atribuição, restrições, validade |
| GenerationJob | Pedido a provedor | `idempotencyKey` único, `inputHash` (reuso de aprovado), `remoteId` (reconciliação), custo estimado e confirmado |
| RenderJob | Exportação | Estado, progresso, etapa, preset, validação, tentativas, cancelamento |
| UsageLedger | Consumo | ESTIMATED → CONFIRMED ou VOID; `@@unique([jobId, kind])` |
| AuditEvent | Auditoria | Login, registro, upload, exclusões, exportações, gerações, consentimento de voz |

## Índices

- `Project(workspaceId, updatedAt)`: lista de projetos.
- `Asset(workspaceId, createdAt)` e `(workspaceId, kind)`: biblioteca. `storageKey` único.
- `Clip(trackId, startFlicks)` e `Clip(assetId)`: verificação de referências e GC.
- `Upload(status, expiresAt)`: limpeza.
- `GenerationJob(workspaceId, createdAt)`, `(workspaceId, inputHash)` para reuso e `(projectId, sceneKey)` para cenas.
- `RenderJob(workspaceId, createdAt)` e `(projectId)`; `UsageLedger(workspaceId, createdAt)`; `AuditEvent(workspaceId, createdAt)`.

## Regras de exclusão

| Ação | Comportamento |
|---|---|
| Excluir workspace | `CASCADE` para tudo do workspace |
| Excluir projeto | Exclusão lógica + remoção da projeção (libera ativos para o GC); revisões e exportações ficam como histórico |
| Excluir ativo | 409 se referenciado (clipe, personagem, música). Senão, exclusão lógica; o GC remove os arquivos (original, miniatura, onda, proxies) após `ASSET_RETENTION_DAYS` (padrão 7) |
| Exportações antigas | Arquivo expira após `RENDER_RETENTION_DAYS` (padrão 30); o registro do job permanece |
| Excluir usuário | `CASCADE` em sessões, memberships e favoritos |
| Revisões | Nunca alteradas. Revisões automáticas antigas (além das 50 mais recentes, sem exportação ligada) são podadas |

## Isolamento entre usuários

- Toda rota resolve o recurso e verifica `Membership` (`requireMember`). Sem acesso, responde **404** (não 403), para não revelar existência.
- Ao salvar, o servidor recusa documentos que citem ativos de outro workspace (`foreign_assets`). Isso impede “emprestar” mídia adivinhando IDs.
- Templates do sistema e itens de catálogo (`source = CATALOG`) são leitura pública para usuários autenticados.
- URLs de mídia são temporárias (1 h) e assinadas (HMAC no driver local, SigV4 no S3).
- Coberto por testes de integração (`tests/integration/api.test.ts`, bloco “projetos, isolamento e concorrência”).

## Imutabilidade da renderização

`RenderJob.revisionId → ProjectRevision` (RESTRICT). O worker lê `revision.document`, nunca `project.document`. O teste de integração remove todos os clipes do projeto durante a exportação e confirma que o arquivo final tem os 95 s originais.
