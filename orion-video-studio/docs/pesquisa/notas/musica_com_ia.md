# Ferramentas de IA para músicas infantis cantadas em pt-BR (licença comercial + API), situação em nov/2026

> Nota de método (3 nov 2026): a busca na web funcionou, mas a leitura direta de páginas foi bloqueada pela rede desta sessão (ai.google.dev, elevenlabs.io e propakistani.pk deram ENOTFOUND). Por isso, quase tudo abaixo vem de trechos de resultados de busca e não da leitura completa dos termos oficiais. Fontes primárias (páginas do próprio fornecedor, comunicados à imprensa) estão marcadas **[oficial]**. Blogs, agregadores e revendedores estão marcados **[terceiros]**. Antes de integrar qualquer ferramenta, confira os termos e as páginas de preço atuais de cada uma.

## 1. Quais ferramentas geram vocais cantados com letra personalizada, em pt-BR, com API oficial e direitos comerciais?

### Takeaway
Em nov/2026, só duas opções juntam API oficial e self-serve, vocais cantados com letra própria e direitos comerciais declarados: **ElevenLabs Eleven Music** (o próprio fornecedor diz que o português tem qualidade "quase nativa", e o modelo foi treinado com licenças da Merlin e da Kobalt) e **Google Lyria 3 / 3.5 pela Gemini API** (cobrança por música, cerca de US$ 0,04 a 0,08; português na lista de idiomas do Lyria 3; marca d'água SynthID). O Suno tem a melhor reputação de qualidade, mas **não tem API pública** (só um programa de parceiros por convite, desde jul/2026), e seus termos e regras de download mudaram em 2026. O Udio está num "jardim murado", sem downloads. Stable Audio, Mubert, Soundraw, AIVA e Beatoven servem para trilhas instrumentais e não para canções com letra.

### Cited Findings

**ElevenLabs – Eleven Music**
- Segundo a página oficial da API, o Eleven Music canta em 59 idiomas, com "qualidade quase nativa em 11 idiomas, incluindo inglês, **português**, italiano, finlandês e grego" — [ElevenLabs, página Eleven Music API (pt) [oficial]](https://elevenlabs.io/pt/eleven-music-api)
- A API aceita um `composition_plan` com seções. Cada seção tem nome, estilos, duração (de 3 s a 2 min) e **letra própria**. O endpoint é `POST https://api.elevenlabs.io/v1/music` e há SDKs para Python e JS/TS (`elevenlabs.music.compose`) — [ElevenLabs, Music API [oficial]](https://elevenlabs.io/pl/music-api); [Eleven Music API (es) [oficial]](https://elevenlabs.io/es/eleven-music-api)
- Pelos Music Terms, alguns inputs são proibidos: nomes de artistas, títulos de músicas e letras de terceiros — [Eleven Music API [oficial]](https://elevenlabs.io/pt/eleven-music-api)
- Uso comercial: "Songs are available for broad commercial use on all paid plans". Direitos para cinema, TV e grandes estúdios de games exigem o plano Enterprise — [Eleven Music API (hi) [oficial]](https://elevenlabs.io/hi/eleven-music-api)
- No lançamento (ago/2025), a ElevenLabs anunciou licenças com a Merlin e a Kobalt e apresentou o produto como "liberado para uso comercial" — [Ground News / agregação de cobertura](https://ground.news/article/elevenlabs-launches-an-ai-music-generator-which-it-claims-is-cleared-for-commercial-use); [Implicator.ai [terceiros]](https://www.implicator.ai/elevenlabs-sidesteps-lawsuits-with-rare-licensing-deal-in-ai-music-launch/)
- Preço: a página oficial cita um nível para desenvolvedores, com API pay-as-you-go e limites mensais de 11 a 4.800 minutos. Fontes de terceiros dizem que o plano Free não inclui uso comercial de música e que os direitos comerciais começam no Starter (~US$ 6/mês), mas esse valor não foi verificado. Também houve relato de corte de até 50% no preço do Music no ElevenAPI — [Eleven Music API [oficial]](https://elevenlabs.io/hi/eleven-music-api); [aimusicpreneur – Music v2 [terceiros]](https://www.aimusicpreneur.com/ai-tools-news/elevenlabs-music-v2/); [Unite.ai review [terceiros]](https://www.unite.ai/eleven-music-review/)

**Google Lyria 3 / Lyria 3.5 (Gemini API / Vertex)**
- O Lyria 3 chegou ao app Gemini em fev/2026, para maiores de 18 anos, em inglês, alemão, espanhol, francês, hindi, japonês, coreano e **português**. Gera letra cantada e as faixas levam SynthID embutido — [EFTM, fev/2026](https://eftm.com/2026/02/google-announce-a-new-generative-ai-audio-tool-available-now-in-the-gemini-app-271934); [Pillitteri [terceiros]](https://pasqualepillitteri.it/en/news/311/google-lyria-3-ai-music-gemini-guide)
- Preço na Gemini API, segundo terceiros: Lyria 3 Clip Preview (clipe de 30 s) a US$ 0,04 por música; Lyria 3 Pro Preview e Lyria 3.5 (música completa) a US$ 0,08 por música; cobrança por música e não por token — [invideo, ago/2026 [terceiros]](https://invideo.io/blog/lyria-ai-music-generator/); [OpenRouter – lyria-3-pro-preview](https://openrouter.ai/google/lyria-3-pro-preview); [aicybr – Lyria 3.5 [terceiros]](https://aicybr.com/blog/google-lyria-3-5-gemini-api-guide); [LiteLLM docs](https://docs.litellm.ai/docs/providers/gemini/music.md)
- As fontes divergem sobre o status. Uma diz que o Lyria 3.5 é GA na Gemini API desde 3 set 2026, sem nível gratuito. Outra diz que os modelos Lyria 3 seguiam em Preview em ago/2026 — [aicybr [terceiros]](https://aicybr.com/blog/google-lyria-3-5-gemini-api-guide) vs. [invideo [terceiros]](https://invideo.io/blog/lyria-ai-music-generator/)
- Os vocais seguem "o idioma do seu prompt", com letras sincronizadas — [aicybr [terceiros]](https://aicybr.com/blog/google-lyria-3-5-gemini-api-guide)

**Suno**
- Em 25 nov 2025, a Warner Music Group fez acordo com a Suno e encerrou o processo. A Suno se comprometeu a substituir seus modelos por **modelos licenciados em 2026**. Depois disso, músicas do plano gratuito podem ser tocadas e compartilhadas, mas não baixadas. Só assinantes pagos baixam, e com limites que podem exigir pagamento extra. O Suno Studio mantém download ilimitado — [Music Business Worldwide](https://www.musicbusinessworldwide.com/warner-music-group-settles-with-suno-strikes-first-of-its-kind-deal-with-ai-song-generator/); [SiliconANGLE](https://siliconangle.com/2025/11/25/warner-music-inks-suno-deal-amid-cooling-tensions-ai-generated-music/)
- Segundo uma reportagem de 10 set 2026, a Suno lançou os modelos licenciados (v6) mas não revelou quais catálogos foram usados no treino. A Sony ainda não tinha feito acordo em mar/2026 — [ProPakistani, 10 set 2026](https://propakistani.pk/2026/09/10/suno-launches-licensed-ai-music-models-after-warner-copyright-settlement/amp/) (página não lida por completo)
- Pela página de preços, o plano Free não tem direito comercial. Pro e Premier têm "Commercial use rights", com a ressalva "See the terms of service for limitations on commercial use". Os termos cedem ao assinante pago os direitos sobre o output — [terms.law [terceiros]](https://terms.law/ai-output-rights/suno/); [Dynamoi [terceiros]](https://dynamoi.com/learn/ai-music-distribution/suno-commercial-rights-explained)
- A Suno publicou no blog uma atualização da política de downloads e dos ToS. Guias de terceiros falam em novos termos a partir de **3 set (2026)**, em que um "permitted download" aprovado passa a ser condição para uso comercial. Os detalhes não foram confirmados na fonte oficial — [Suno blog [oficial]](https://about.suno.com/blog/suno-updates-tos); [Jack Righteous [terceiros]](https://jackrighteous.com/de-gb/blogs/guides-using-suno-ai-music-creation/suno-ai-terms-musicians-guide)
- **API:** a Suno não tem API pública. Em 1 jul 2026, o CPO Jack Brody anunciou que a empresa estava "explorando" uma API com um grupo curado de parceiros, com inscrição por formulário — [Digital Music News, 3 jul 2026](https://www.digitalmusicnews.com/2026/07/03/suno-is-opening-an-api-partner-program/); [MBW](https://musicbusinessworldwide.com/suno-explores-developer-api-seeking-apps-that-unlock-experiences-generative-music-makes-possible-for-the-first-time)
- Existem wrappers "Suno API" não oficiais (sunoapi, revendedores) que fazem engenharia reversa do site. Eles trazem risco de violar os ToS e de instabilidade, e as assinaturas Pro/Premier cobrem o site e o app, não chamadas de API — [AIML API blog [terceiros]](https://aimlapi.com/blog/the-suno-api-reality); [sonilo [terceiros]](https://sonilo.com/blog/comparisons/suno-api-alternative)

**Udio**
- A UMG fez acordo com a Udio no fim de out/2025 para lançar uma plataforma licenciada em 2026. Logo em seguida a Udio desativou os downloads e abriu uma janela de 48 h para os usuários baixarem o que já tinham — [Digital Music News](https://www.digitalmusicnews.com/2025/10/31/udio-downloads-disabled-umg-deal/); [Billboard](https://billboard.com/pro/udio-deal-backlash-ai-users-download-ai-songs-48-hours); [MBW](https://www.musicbusinessworldwide.com/universal-music-settles-udio-lawsuit-strikes-deal-for-licensed-ai-music-platform)
- A Warner fez acordo com a Udio em 19 nov 2025 para um serviço licenciado em 2026 — [Warner, comunicado [oficial]](https://s206.q4cdn.com/940328283/files/doc_news/WARNER-MUSIC-GROUP-AND-UDIO-COLLABORATE-TO-BUILD-A-NEW-LICENSED-MUSIC-CREATION-SERVICE-2025.pdf)
- O modelo "walled garden" impede baixar ou distribuir a música fora da plataforma — [MBW – walled gardens](https://www.musicbusinessworldwide.com/universal-and-suno-are-in-a-pr-battle-over-walled-gardens-in-ai-music/); [dig.watch](https://dig.watch/?p=232943)

**Stable Audio (Stability AI)**
- O Stable Audio 2.5 é voltado a instrumentais e, segundo terceiros, não gera vocais. O uso comercial é permitido nos planos pagos via Creator license, e é preciso Enterprise acima de US$ 1M de receita anual. Na API, os preços citados divergem: US$ 0,20 por geração, depois 8 créditos (US$ 0,08) após um corte de preço reportado em 23 out 2026 — [fast.io [terceiros]](https://fast.io/resources/stability-ai-review-2026/); [Dynamoi [terceiros]](https://dynamoi.com/learn/ai-music-distribution/can-i-distribute-stable-audio-commercially); [usagepricing [terceiros]](https://www.usagepricing.com/blueprint/activity/stability-ai-2026-10-23-stable-audio-api-price-cut)

**Mubert, Soundraw, AIVA, Beatoven**
- O Mubert tem API de desenvolvedor, com preço por cotação ou planos até ~US$ 199/mês segundo agregadores. A Soundraw publicou em jul/2026 um post sobre API para desenvolvedores indie (Starter a US$ 29,99/mês). Sobre a Beatoven, as fontes divergem quanto a ter API pública; uma afirma que há licença perpétua e que não há Content ID claims sobre os uploads. O AIVA Pro (~US$ 49/mês) daria posse total do copyright. Nenhuma fonte mostra essas ferramentas gerando canções com letra personalizada em pt-BR — [Soundraw blog [oficial]](https://soundraw.io/blog/post/ai-music-api-under-50-dollars-indie-developers); [costbench Mubert API [terceiros]](https://costbench.com/software/ai-music-apis/mubert-api/); [aitoolsatlas Beatoven [terceiros]](https://aitoolsatlas.ai/tools/beatoven); [costbench AIVA vs Mubert [terceiros]](https://costbench.com/compare/aiva-vs-mubert/)

### Inferences
- Para um pipeline automatizado de músicas de alfabetização em pt-BR, a **ElevenLabs** é a escolha mais segura. Tem API oficial e documentada, controle de letra por seção (útil para estrofes como "A de abelha..."), português entre os idiomas de qualidade "quase nativa" e uma base de licenças (Merlin/Kobalt) que reduz o risco de processo. O **Lyria 3.5** é a alternativa mais barata por música (~US$ 0,08) e a mais fácil de escalar, mas os termos de uso comercial da Gemini API para música não foram verificados nesta pesquisa.
- Integrar o Suno hoje significaria usar um wrapper não oficial, o que é arriscado num produto. Só faz sentido se o desenvolvedor entrar no programa de parceiros.
- As ferramentas instrumentais (Stable Audio, Mubert, Soundraw, Beatoven) podem gerar bases e loops, com o vocal vindo de outra fonte.

### Gaps
- Não foi possível ler os termos oficiais do Gemini API/Vertex para o Lyria (titularidade do output, uso comercial, restrições), porque ai.google.dev foi bloqueado.
- Não foram confirmados os preços atuais por minuto ou música do Eleven Music, nem os limites exatos de download do Suno pós-v6.
- Não há avaliação independente e comparativa da qualidade do vocal em pt-BR (dicção, sílabas, sotaque) para nenhuma ferramenta. As afirmações de "native-like" são do próprio fornecedor.
- A situação do relançamento do Udio em nov/2026 não foi confirmada.
- Boomy e outras ferramentas não foram pesquisadas por limite de tempo.

## 2. Content ID, monetização no YouTube e risco de reivindicações indevidas

### Takeaway
Usar música de IA com direitos comerciais não impede a monetização no YouTube por si só. Os riscos reais são três: (a) a política de "conteúdo inautêntico", de jul/2025, que mira conteúdo produzido em massa sem curadoria humana; (b) claims de Content ID por terceiros que registram faixas de IA iguais ou parecidas, já que o Content ID compara correspondências e não verifica autoria; (c) a elegibilidade de faixas de IA para o próprio Content ID, que é incerta e contraditória. Não há fonte oficial confirmando regras específicas sobre Content ID para música de IA.

### Cited Findings
- O YouTube renomeou "repetitious content" para "inauthentic content" em jul/2025, mirando áudio produzido em massa, incluindo saídas de IA sem curadoria. Os relatos são de terceiros, sem documentação oficial lida — [outlierkit [terceiros]](https://outlierkit.com/resources/ai-generated-music-youtube-monetization-2026/); [upgrowth [terceiros]](https://upgrowth.in/tools-youtube-monetization-compliance-2026/)
- Rótulo de conteúdo sintético: animação claramente irreal fica isenta. Ainda assim, um porta-voz do YouTube disse que "We require kids content creators to disclose content that is meaningfully altered or synthetic when it seems realistic". Segundo a documentação citada, o rótulo não limita o alcance nem a monetização — [Slashdot](https://tech.slashdot.org/story/24/03/19/2117213); [9to5Google, mar/2024](https://9to5google.com/2024/03/18/youtube-altered-content-disclosure/); [Android Central](https://www.androidcentral.com/apps-software/youtube-ai-synthetic-content-disclosure)
- Há relatos de abuso do Content ID: alguém baixa uma faixa de IA, registra via distribuidora e reivindica vídeos alheios. O Content ID "just looks for matches" e o YouTube deixa as disputas para as partes — [dtptips [terceiros]](https://dtptips.com/ai-music-copyright-nightmare-how-ai-tracks-are-abusing-content-id-and-threatening-creators)
- Sobre a elegibilidade de faixas de IA para o Content ID, os relatos se contradizem. Um usuário diz que a distribuidora e o YouTube negaram; outro diz que registra via DistroKid sem problema — [Reddit snapshot [terceiros]](https://reddit.sentinel-team.org/posts/1ra4sj1/snapshots/2026-02-27T16%3A10%3A11.976794Z)
- Uma música do Suno pode ser usável comercialmente no seu canal e ainda assim ser inadequada para Content ID — [Jack Righteous [terceiros]](https://jackrighteous.com/de/blogs/ai-music-distribution-guide/distribute-suno-music-after-september-3-spotify-distrokid-youtube)
- UMG e Sony processaram a DistroKid para obrigá-la a revelar o volume de faixas de IA (Suno) que distribui. Believe e TuneCore bloqueiam faixas de "estúdios piratas" — [Hypebot](https://www.hypebot.com/umg-sony-sue-distrokid-to-reveal-scale-of-suno-and-ai-music/); [pulse.bot](https://www.pulse.bot/entertainment/news/believe-and-tunecore-are-blocking-distribution-of-generative-ai-tracks-made-on-pirate-studios-like-s-adc87434-5c09-467c-bb50-cbfe33427488/)
- Segundo agregador, o Mubert oferece verificação de Content ID embutida — [costbench [terceiros]](https://www.costbench.com/software/ai-music-generators/mubert/alternatives/)

### Inferences
- Em canções de alfabetização, melodias muito batidas (por exemplo, a melodia de "Brilha, brilha estrelinha", de domínio público) aumentam a chance de colisão com versões registradas por terceiros. Uma melodia original e um arranjo característico reduzem o risco.
- Medidas práticas: guardar a prova de geração (ID e data da geração, prompt, recibo do plano pago), não registrar as próprias faixas de IA no Content ID se a distribuidora proibir, e contestar claims com essa documentação.
- Para não cair em "inautêntico", vale mostrar autoria humana: letra escrita e revisada por pessoas, pedagogia própria, animação original, variação entre episódios.

### Gaps
- A política oficial do YouTube sobre Content ID para áudio de IA e a página oficial da política de conteúdo inautêntico não foram lidas.
- Não foram encontrados dados quantitativos confiáveis sobre a taxa de claims falsos em música de IA. O número de "40%+ de desmonetização" que circula não tem fonte.

## 3. Alternativas, segurança infantil e critérios de recomendação para um canal pequeno brasileiro

### Takeaway
Para um canal brasileiro de alfabetização (alfabeto, vogais, sílabas) com pipeline automatizado, o caminho recomendado é: **letras escritas e revisadas por pessoas → Eleven Music API (principal) ou Lyria 3.5 pela Gemini API (custo menor e escala) → revisão humana da pronúncia de cada sílaba → disclosure quando aplicável → arquivo de provas de geração**. Músicas de domínio público regravadas e bibliotecas licenciadas servem como plano B. Contratar compositor faz sentido para a música-tema do canal.

### Cited Findings
- A ElevenLabs proíbe inputs com nomes de artistas, títulos e letras de terceiros, o que reduz o risco de "soar como artista real" — [Eleven Music API [oficial]](https://elevenlabs.io/pt/eleven-music-api)
- O app Gemini/Lyria 3 é restrito a maiores de 18 anos e as faixas trazem SynthID, o que permite identificar o conteúdo como gerado por IA do Google — [EFTM](https://eftm.com/2026/02/google-announce-a-new-generative-ai-audio-tool-available-now-in-the-gemini-app-271934)
- A disclosure de conteúdo sintético é obrigatória para conteúdo realista, inclusive infantil, e animação irreal fica isenta — [Slashdot](https://tech.slashdot.org/story/24/03/19/2117213)
- Os acordos de Suno e Udio com gravadoras exigem fingerprinting e filtragem, o que tende a bloquear gerações que imitam obras protegidas — [dig.watch](https://dig.watch/?p=232943); [MBW](https://www.musicbusinessworldwide.com/warner-music-group-settles-with-suno-strikes-first-of-its-kind-deal-with-ai-song-generator/)

### Inferences
- **Critérios de escolha (ordem sugerida):** (1) API oficial e estável; (2) direito comercial explícito no plano que será pago; (3) qualidade da dicção em pt-BR, crítica para ensinar sílabas, e por isso testar "ba-be-bi-bo-bu" e as vogais nasais (ã, õ); (4) controle de letra por seção e de duração; (5) custo por música; (6) base de treino licenciada, menor risco jurídico; (7) marca d'água ou rastreabilidade.
- **Comparativo prático:**
  - ElevenLabs: API oficial, letra por seção, pt-BR "native-like" (alegação do fornecedor), comercial nos planos pagos, treino licenciado. Preço/minuto a confirmar.
  - Lyria 3.5: cerca de US$ 0,08 por música, pt-BR suportado, SynthID. Termos comerciais da API a confirmar.
  - Suno: melhor qualidade percebida, mas sem API pública e com termos mudando em 2026.
  - Udio: inviável, sem downloads.
  - Stable Audio, Mubert, Soundraw, Beatoven, AIVA: só instrumental.
- **TTS cantado** (voz da ElevenLabs sobre melodia): não há fonte sobre a qualidade prática. É provável que fique inferior a um modelo musical nativo e exija alinhamento manual de pitch e tempo.
- **Segurança da letra:** como o público são crianças, a letra deve sempre passar por revisão humana e nunca ser gerada livremente pelo modelo de música. Use a letra exata no `composition_plan` e confira se o vocal canta o que foi escrito, já que alucinações de sílabas são um risco plausível que não foi verificado.

### Gaps
- Nenhuma fonte encontrada sobre bibliotecas brasileiras licenciadas de música infantil, custo de compositor no Brasil ou qualidade prática de TTS cantado.
- Não foram pesquisadas as regras específicas do YouTube Kids ou Made for Kids sobre IA de baixa qualidade, nem orientações brasileiras (ECA/ANPD) sobre conteúdo infantil gerado por IA.
