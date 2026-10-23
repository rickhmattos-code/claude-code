# 08 · Pendências (lista honesta)

## Exigem credenciais ou validação contra o serviço real

| Item | O que existe | O que falta para concluir |
|---|---|---|
| Google Veo | Adapter completo (start, poll, download, validações de duração e resolução), fluxo de cenas e tomadas na interface, reconciliação por ID remoto | Chave `GEMINI_API_KEY`; confirmar durações e resoluções por modelo; preencher o preço em `pricing.json`; teste real opcional |
| ElevenLabs | TTS com alinhamento por caractere → legendas palavra a palavra; catálogo de vozes; regeneração por frase | Chave; preço; validar pt-BR com vozes reais |
| OpenAI Images / Whisper | Adapters; transcrição em blocos de 10 min com mapeamento para o clipe | Chave; preço |
| Anthropic | Plano criativo e comandos livres validados por schema, com fallback local | Chave; ajustar o modelo em `ANTHROPIC_MODEL` |
| Webhooks de provedores | Endpoint HMAC genérico com reconciliação | Os adapters atuais usam polling; integrar o formato de cada provedor que oferecer callback |

## Concluído em 23/10/2026

Edição pelo texto (palavras, frases, “ãh/hum”, pausas), cortes curtos sugeridos → novo projeto, máscaras retangulares/elípticas, tradução de legendas (com provedor configurado), exportação 4K medida e liberada, Docker Compose validado de ponta a ponta (com as correções do proxy da web, do `prisma generate` no build e da remoção do MinIO).

## Funcionalidades pendentes (backlog)

| Item | Fase | Observação |
|---|---|---|
| Remoção de fundo, rastreamento | 5 | Não aparecem na interface (ver matriz de efeitos) |
| Máscaras animadas e formas livres | 5 | Hoje: retângulo/elipse estáticos por clipe (acompanham a transformação) |
| Cortes curtos com reenquadramento inteligente | — | Hoje o reenquadramento para 9:16/1:1 é pelo centro; sem detecção de rosto |
| Tradução no orçamento de gerações | — | A tradução (como o assistente) chama o LLM direto, sem estimativa nem ledger, porque não há preço por token verificado |
| Edição pelo texto em legendas sem tempo por palavra | — | Sem alinhamento real, a unidade de corte é a frase inteira; não há alinhador forçado local |
| Geração musical | — | Só com API oficial e termos de sincronização comercial |
| Alterar o fps de um projeto com clipes | — | Bloqueado na interface; exigiria requantizar todos os tempos |
| Outros idiomas além do pt-BR | — | A interface está toda em pt-BR. Para lançar outro idioma, extrair os textos dos painéis do editor para o dicionário de `i18n.ts` (navegação, autenticação, projetos, estados e provedores já usam o dicionário) |
| Recuperação de senha, 2FA, convites por e-mail | — | Ver `06-seguranca-e-custos.md` |
| Colaboração simultânea em tempo real | — | Hoje há concorrência otimista (409 + recarregar) |
| Edição de keyframes por arraste na timeline | — | Os keyframes são criados e removidos no inspetor e mostrados como losangos no clipe |
| Máscara e velocidade variável por keyframe | — | A velocidade é constante por clipe |
| Otimizar zoom animado | 4 | Hoje `scale` com `eval=frame` reescala a camada inteira a cada quadro (1,27× tempo real no exemplo de 90 s); pré-reduzir imagens grandes ao tamanho máximo de exibição ou usar `zoompan` |
| Renderizar blocos em paralelo entre workers | 4 | Hoje os blocos de um job são sequenciais (3× tempo real em 4 vCPU) |

## Validações que não puderam ser executadas neste ambiente

| Item | Bloqueio | Como concluir |
|---|---|---|
| Imagem `postgres:16.10-alpine` | Docker Hub recusou downloads (429) neste ambiente; o Compose foi validado com PostgreSQL 16 do Ubuntu no lugar | Primeiro `docker compose up` com acesso normal ao Docker Hub |
| Upload direto a um S3 real pelo navegador | O Compose agora usa o driver local; o driver S3 foi testado contra `s3rver` | Configurar `STORAGE_DRIVER=s3` com o bucket real; conferir CORS e a exposição de `ETag` |
| `s3rver` (só nos testes) | Avisos de segurança na cadeia `busboy`/`dicer`/`fast-xml-parser`; a correção exige a versão major 2.x, com outra API | Trocar o servidor S3 de teste ou adaptar o teste; não roda em produção |
| Imagens Docker enxutas | ~3 GB por imagem (dependências de desenvolvimento incluídas) | Estágio de produção com `npm ci --omit=dev` por app |
| IP do cliente atrás da web | O Next mantém um `X-Forwarded-For` enviado pelo cliente | Proxy reverso que sobrescreva o cabeçalho (ver `09-infraestrutura.md`) |
| Reprodução de H.264/AAC no Chromium de teste | O Chromium do Playwright não tem codecs proprietários | Resolvido com proxies VP9/Opus; em Chrome/Safari/Firefox reais são usados os proxies H.264 |
| Documentação do Veo e da ElevenLabs | Hosts bloqueados pela política de rede | Endpoints confirmados por busca em páginas oficiais; revisar antes de produção |
| Gravação de microfone | Sem dispositivo de áudio no navegador headless | Testar manualmente em navegador real (MediaRecorder → upload `RECORDING`) |
