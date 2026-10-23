# 04 · Mídia, renderização e exportação

## Regras de mídia (entradas não confiáveis)

| Situação | Regra implementada | Onde |
|---|---|---|
| Formato | Lista permitida de contêineres (mp4/mov, matroska/webm, mp3, wav, ogg, flac, aac, png, jpeg, webp, srt, vtt); playlists (HLS, concat) são recusadas | `packages/media/src/probe.ts` (`ALLOWED_FORMATS`) |
| Protocolos | ffprobe com `-protocol_whitelist file` em uploads | `probeFile(..., untrusted=true)` |
| Tipo declarado × real | O tipo detectado (VIDEO/AUDIO/IMAGE) precisa bater com o declarado; senão FAILED | `apps/worker/src/jobs/media.ts` |
| Resolução | Máximo de 8192 px na inspeção; projeto até 3840 px (par, H.264 4:2:0) | ingestão + `validateDoc` |
| Frame rate variável | Detectado (`r_frame_rate` ≠ `avg_frame_rate` > 0,5%); todo vídeo usado é **normalizado para CFR** no fps do projeto antes da composição | `normalizeVideo` |
| Duração divergente | Duração autoritativa = menor entre os streams de vídeo e áudio; a divergência fica registrada (`durationDivergenceMs`) | `interpretProbe` |
| Rotação | Lida da display matrix ou da tag `rotate`; largura e altura reportadas já giradas; o FFmpeg aplica autorrotação na normalização | `interpretProbe` |
| Sample rates diferentes | Tudo reamostrado para 48 kHz estéreo no stem (`aresample`, `aformat`); posicionamento por amostra exata (`adelay=…S`) | `buildStemCommand` |
| Clipe além do fim da mídia | Aviso de validação; o último frame é mantido (`tpad clone`) | `graph.ts` |
| Timeouts | Toda chamada FFmpeg tem timeout; os processos rodam sem shell (`spawn` com argumentos) | `ffmpeg.ts` |

Os textos do usuário nunca entram na linha de comando: vão para arquivos `textfile=` (drawtext) e `.ass` no diretório temporário do job.

## Pipeline de renderização (worker)

1. **Validação**: schema, alinhamento a frames, sobreposição, ativos prontos e limite de duração.
2. **Snapshot**: lê a `ProjectRevision` imutável.
3. **Resolução de ativos**: baixa os originais para `tmp/render/<id>/assets` (reaproveita se o tamanho bater).
4. **Normalização**: vídeos para CFR, yuv420p, GOP curto, no máximo o lado maior da saída.
5. **Composição em blocos de 30 s** (`RENDER_CHUNK_SECONDS`). Cada bloco abre só os clipes que o intersectam e monta o grafo `color → [camada → efeitos → escala base → opacidade → rotação → escala animada → setpts] → overlay(x(t), y(t))`. Número exato de frames (`-frames:v`) e timescale = fps.num. Os blocos são concatenados com `-c copy`.
6. **Mixagem**: um stem WAV por trilha audível, com volume com keyframes, fades, dissolve, `atempo` para velocidade, `afftdn` para redução de ruído e `adelay` em amostras. No master: volume da trilha, **ducking** (sidechain da música pela narração), limitador e `loudnorm` (−14 LUFS, TP −1,5) opcional.
7. **Legendas**: gravadas via libass (ASS por bloco) e/ou SRT/VTT separados.
8. **Codificação**: H.264 (libx264, preset `RENDER_X264_PRESET`, CRF `RENDER_CRF`) + AAC 192 kbps, `+faststart`.
9. **Validação do resultado**: codecs, dimensões, número de frames, duração do vídeo (±1 frame), duração do áudio (±1 frame + 1 quadro AAC de 1024 amostras) e decodificação completa sem erros. Se falhar, o job falha.
10. **Armazenamento**: Asset `RENDER` e URL temporária de download.

**Idempotência e retomada:** normalizações, blocos e stems têm nome derivado do hash do comando. Escritas são atômicas (`.part` + rename). Uma nova tentativa reaproveita o que já existe, e o teste de integração mata o worker no meio para comprovar.

## Tolerâncias de sincronização (medidas)

| Medida | Tolerância | Teste |
|---|---|---|
| Flash de vídeo × bipe de áudio após corte com `sourceIn` ≠ 0 e blocos de 4 s | ≤ 1 frame (33,3 ms a 30 fps) + 5 ms de medição | `packages/media/test/render.test.ts` |
| Duração do vídeo exportado | ±1 frame | validação em toda exportação |
| Duração do áudio exportado | ±(1 frame + 1024 amostras) | validação em toda exportação |
| Posição de keyframe (prévia × exportação) | Exata: pixel no centro esperado em t = 1 s e t = 2 s | `render.test.ts` |
| Expressão FFmpeg × JS | Erro < 1e-9 em centenas de amostras | `packages/timeline/test/timeline.test.ts` |

Referência: a recomendação ITU-R BT.1359 tolera de +45 ms a −125 ms de dessincronia perceptível. O limite usado aqui (1 frame) é mais estrito.

## Matriz de efeitos e transições

| Item | Prévia | Exportação | Observação |
|---|---|---|---|
| Corte seco, fade, dissolve | Exata | ✅ | Dissolve estende o clipe anterior (mantém o último frame se faltar material) |
| Zoom/pan (keyframes de escala e posição) | Exata | ✅ | Easing linear, segura e suave (smoothstep) |
| Picture-in-picture e sobreposições | Exata | ✅ | Trilha de sobreposição + transformação |
| Texto animado (fade, slide-up, pop) | Exata | ✅ | Mesmas funções por partes |
| Brilho, contraste, saturação | Aproximada | ✅ `eq` | Curvas CSS diferem levemente |
| Temperatura de cor | Aproximada | ✅ `colortemperature` | |
| Desfoque | Exata | ✅ `gblur` | |
| Vinheta | Aproximada | ✅ `vignette` | |
| Granulação | Aproximada | ✅ `noise` | Padrão aleatório |
| Chroma key | Aproximada (resolução reduzida) | ✅ `chromakey` | |
| Redução de ruído (áudio) | Não exibida | ✅ `afftdn` | |
| Máscara (retângulo/elipse, borda suave, inverter) | Exata (mesma geometria e sigma) | ✅ `geq` + `gblur` + `alphamerge` | Acompanha posição, escala e rotação do clipe; várias máscaras se multiplicam. Formas livres e máscara animada: ⏳ |
| Remoção de fundo por IA | — | ⏳ Fase 5 | Requer GPU ou serviço pago |
| Rastreamento | — | ⏳ Fase 5 | OpenCV em worker dedicado |

Fonte única: `packages/shared/src/effects.ts`, também exibida na página **Integrações**.

## Formatos de exportação

- MP4 (H.264 High, yuv420p) + AAC LC 48 kHz estéreo, `faststart`.
- 720p e 1080p (lado menor). Proporções 9:16, 16:9, 1:1, 4:5 e personalizada.
- Frame rates: 23,976 · 24 · 25 · 29,97 · 30 · 50 · 59,94 · 60.
- Legendas gravadas, separadas (SRT/VTT) ou ambas.
- **4K não foi liberado.** O validador aceita até 3840 px no projeto, mas a interface só oferece 720p e 1080p até haver medição de recursos, tempo e custo.

## Licenciamento das dependências de mídia

- **FFmpeg** é LGPL 2.1+. A build usada (Ubuntu 24.04) inclui **libx264 (GPL)**, o que torna o binário GPL. Executar o FFmpeg como processo separado num serviço não obriga a abrir o código da aplicação, mas **distribuir** o binário (por exemplo, numa imagem Docker publicada) exige cumprir a GPL (oferecer o código-fonte do FFmpeg e das bibliotecas). Para distribuição comercial sem GPL, use uma build LGPL com codificador de hardware ou um codificador licenciado, e verifique as patentes de H.264/AAC na jurisdição.
- **Inter** é SIL Open Font License 1.1 (`assets/fonts/OFL.txt`).
- **Música e efeitos demonstrativos** são CC0, sintetizados por `scripts/make-fixtures.ts`.
- **Fixtures de teste** são CC0, geradas pelo FFmpeg (testsrc2, aevalsrc).
