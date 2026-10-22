# 06 · Segurança e controle de custos

| Requisito | Implementação |
|---|---|
| Autenticação | E-mail + senha (scrypt N=16384, r=8, p=1), sessão em cookie httpOnly `SameSite=Lax` (`COOKIE_SECURE=1` em produção), token guardado como sha256 |
| Autorização por workspace | `requireMember(user, workspace, papel)` em toda rota; sem acesso → 404 |
| Proteção entre usuários | Recursos carregados pelo ID e conferidos pela membership; documentos não podem citar ativos de outro workspace |
| CSRF | Mutações com cabeçalho `Origin` diferente de `WEB_ORIGIN`/`API_PUBLIC_URL` → 403; cookie `SameSite=Lax` |
| Rate limiting | Global de 600/min por IP (Redis); login e registro 10/min; uploads 120/min; exportações 20/min; gerações 60/min |
| Segredos | Somente no servidor; `GET /api/providers` informa “configurado ou pendente” sem valores; teste garante que a chave não aparece em respostas |
| Validação de uploads | Tipo MIME na lista permitida, tamanho máximo (`MAX_UPLOAD_BYTES`), cota do workspace, tamanho conferido na conclusão, ffprobe com protocolos restritos, formato permitido, tipo real igual ao declarado |
| Validação de URLs | Download do Veo só aceita o host oficial; chaves de objeto geradas pelo servidor; driver local impede path traversal |
| Webhooks | HMAC-SHA256 (`x-orion-signature`, segredo `WEBHOOK_SECRET_<PROVEDOR>`) com comparação em tempo constante; o payload só agenda reconciliação (o estado é sempre lido do provedor) |
| Logs | Pino com redação de cookie, authorization e chaves; o worker registra IDs e mensagens curtas (sem prompts completos) |
| Isolamento do processamento | Worker em processo e contêiner separados, `cap_drop: ALL`, `no-new-privileges`, limites de CPU e memória no Compose, timeouts no FFmpeg, usuário sem privilégios |
| Limites de geração | Orçamento mensal por workspace; rate limit; duração e resolução validadas contra o modelo antes de chamar |
| Registro de consumo | `UsageLedger` ESTIMATED → CONFIRMED ou VOID; página **Integrações** mostra estimado × confirmado |
| Estimativa antes de operações pagas | Obrigatória: a criação exige `acceptEstimatedCents` igual à estimativa atual |
| Cobrança duplicada | Chave de idempotência por pedido; ID remoto gravado antes do poll; chamadas síncronas interrompidas não são repetidas automaticamente; reuso de resultado aprovado pelo hash do input |
| Integração sem credenciais | 409 `provider_not_configured`; interface mostra “Configuração pendente” |
| Auditoria | `AuditEvent` para registro, login, upload, exclusões, exportações, gerações, consentimento de voz e membros |

## Pendências de segurança conhecidas

- Sem recuperação de senha por e-mail e sem 2FA.
- Sem convite por e-mail (adicionar membro exige que a conta já exista).
- Sem antivírus em uploads; a mitigação é restringir formatos e protocolos e processar em contêiner sem privilégios.
- As URLs assinadas do driver local são portadoras (quem tem a URL acessa até expirar, em 1 h), o mesmo modelo das URLs pré-assinadas do S3.
- A assinatura do webhook é calculada sobre o JSON reserializado. Provedores que assinam o corpo bruto exigem um adapter específico.
