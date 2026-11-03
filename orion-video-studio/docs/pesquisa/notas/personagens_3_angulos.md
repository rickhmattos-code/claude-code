# Personagens consistentes em 3 ângulos (turnaround) para vídeos infantis gerados por IA — APIs de imagem/vídeo com referência

> Research date: 2026-11-03. IMPORTANT method caveat: official doc domains (platform.openai.com, ai.google.dev, blog.google) were NOT reachable from this session (DNS blocked by sandbox network policy). Almost all figures below come from WebSearch snippets of third-party resellers/aggregators/blogs, a few Google Vertex/Ideogram/BFL pages surfaced in search. Every price and limit should be re-verified on the official pricing page before budgeting. Several aggregator banners mentioned model names not otherwise verified (e.g., "GPT Image 2.5", "FLUX 3", "Gemini 3.7 Flash", "Nano Banana 2.1", "Seedance 2.5", "Kling 4.0") — treat these as unconfirmed signals that the lineup moves monthly.

## 1. Standard practice: turnaround / model sheets in animation (which angles, layout, pose, background, palette, expressions)

### Takeaway
Industry turnarounds are typically 5 views (front, 3/4 front, profile, 3/4 back, back) drawn in one fixed neutral pose, same scale, aligned by horizontal guide lines; a 3-view minimum is usually front + side + back or front + 3/4 + profile. For an AI pipeline whose scenes mostly show characters from the front/3/4, the most useful 3 angles are front, 3/4 and profile; back is worth adding as a 4th when scenes show characters walking away.

### Cited Findings
- A turnaround shows one character from several angles; the usual full set is front, three-quarter front, side profile, three-quarter back and back (5 views over 360°) — [binus.ac.id DKV (Nov 2025)](https://binus.ac.id/bandung/dkv/2025/11/04/character-turnarounds-understanding-form-in-2d-space/); [Clip Studio – Model Sheets for Character Designers](https://www.clipstudio.net/how-to-draw/archives/164740)
- Some guides reduce it to front, side and back, "occasionally a three-quarter view" — [Simple Art Tips – Turnaround sheet](https://simplearttips.squarespace.com/simplearttips/turnaround-sheet); [elser.ai – front/side/back prompts](https://www.elser.ai/blog/ai-character-turnaround-prompts-front-side-back-views)
- Pose is fixed across views: neutral standing stance or T-pose (AI-oriented guides also use A-pose) — [binus.ac.id](https://binus.ac.id/bandung/dkv/2025/11/04/character-turnarounds-understanding-form-in-2d-space/); [dreampixelforge](https://www.dreampixelforge.com/blog/character-turnaround)
- Workflow: lock the front view first, draw horizontal guide lines (head top, eyes, chin, shoulders, waist, knees, feet) across all frames, block front and profile, then derive the 3/4 views; back views can be started by flipping front/3/4 horizontally — [Simple Art Tips](https://simplearttips.squarespace.com/simplearttips/turnaround-sheet); [binus.ac.id](https://binus.ac.id/bandung/dkv/2025/11/04/character-turnarounds-understanding-form-in-2d-space/)
- The sheet is the "single source of truth" that keeps a character on-model across production — [Clip Studio](https://www.clipstudio.net/how-to-draw/archives/164740)
- AI-tool vendors now publish turnaround-sheet templates/prompt recipes (e.g., GPT Image 2 turnaround sheets via Dreamina; 3D AI Studio template; Morphic prompt library) — [Dreamina/CapCut](https://dreamina.capcut.com/resource/gpt-image-2-for-character-turnaround-sheets); [3daistudio](https://www.3daistudio.com/templates/character-turnaround-sheet); [Morphic](https://morphic.com/resources/prompts/character-design-prompts)

### Inferences
- Recommended app spec: generate ONE sheet image (landscape ~16:9 or 3:1) with front | 3/4 | profile side by side, same height, neutral A-pose, plain flat white/light-gray background, no shadows/props, plus a palette strip (4–8 hex swatches) — then crop each view into separate files. Single sheet maximizes intra-sheet consistency (the model sees all views at once); separate crops are better as reference inputs because most APIs treat each input image as an "object/character" and small panels waste resolution.
- Add a separate expression sheet (happy/sad/surprised/angry/neutral heads) and optionally a back view, since kids' stories rely heavily on clear emotions.
- "3/4 back" and "back" are lower priority for talking-head style kids videos but matter for walk-away shots.

### Gaps
- No authoritative studio source (e.g., Disney/Pixar style guides) was fetched; standards above come from education/tutorial sites. Palette/expression-sheet conventions are inferred from common practice, not a cited industry document.

## 2. Image models with APIs and reference-image support (2026)

### Takeaway
Best options for API-driven reference-based character consistency in late 2026: Google Gemini image models (Nano Banana Pro = gemini-3-pro-image-preview; Nano Banana 2 = gemini-3.1-flash-image-preview; up to 14 input images), OpenAI gpt-image-2 / gpt-image-1.5 (multi-image edits, high input fidelity), BFL FLUX.2 (up to 8 refs; Kontext for iterative edits), Ideogram 3.0 Character Reference, Seedream 4 (~10 refs). Midjourney has no official public API (only unofficial wrappers) — avoid for a production app. No neutral benchmark compares identity preservation for cartoon characters; build your own eval.

### Cited Findings
**OpenAI**
- gpt-image-1.5 edit accepts multiple input images; with `input_fidelity: high` (default high per one source) the first 5 images are preserved with higher fidelity — [fal.ai GPT-Image 1.5 edit](https://fal.ai/models/fal-ai/gpt-image-1.5/edit/llms.txt); [WaveSpeed docs](https://wavespeed.ai/docs/docs-api/openai/openai-gpt-image-1.5-edit)
- Low vs high fidelity token example: 1024×1024 input ≈135 tokens low vs ≈3,050 tokens high, so high fidelity costs noticeably more — [apiyi gpt-image-1.5 launch](https://docs.apiyi.com/en/news/gpt-image-1-5-launch)
- gpt-image-1.5 pricing reported as image input $8/1M tokens, image output ~$25.6–32/1M (reseller-reported; not verified with OpenAI) — [aireiter](https://aireiter.com/blog/gpt-image-1-5-api-pricing); [evolink guide](https://evolink.ai/blog/gpt-image-1-5-api-guide)
- gpt-image-2 released ~Apr 21, 2026; reportedly no `input_fidelity` knob (always high), no transparent background (gpt-image-1.5 still needed for transparent PNG) — [empiriolabs catalog](https://catalog.empiriolabs.ai/models/gpt-image-2); [apiyi gpt-image-2 overview](https://docs.apiyi.com/en/api-capabilities/gpt-image-2/overview.md)
- gpt-image-2 token pricing reported: image input $8/1M, cached image input $2/1M, image output $30/1M; Batch halves rates. Per-image estimates conflict: ~$0.012 low / $0.106 medium / $0.422 high (1024²) vs $0.03–0.08 via resellers — [DEV guide](https://dev.to/tokenmixai/gpt-image-2-api-developer-guide-pricing-thinking-mode-and-production-integration-2026-28p5); [laozhang](https://blog.laozhang.ai/en/posts/gpt-image-2-api-pricing.md); [aireiter gpt-image-2](https://aireiter.com/blog/gpt-image-2-api-pricing)

**Google Gemini / Nano Banana**
- Nano Banana Pro (Gemini 3 Pro Image, `gemini-3-pro-image-preview`, launched Nov 2025) blends up to 14 images while keeping consistency of up to 5 people — [Neowin](https://www.neowin.net/amp/google-announces-gemini-3-pro-image-nano-banana-pro-image-generation-and-editing-model/); [AlternativeTo](https://alternativeto.net/news/2025/11/google-launches-the-gemini-3-powered-nano-banana-pro-image-model-for-all-users); an older guide said 8 refs — [yingtu](https://yingtu.ai/blog/nano-banana-pro-api-pricing-per-image) (conflict; 14 better supported)
- Nano Banana Pro price: Google bills tokens; resellers quote ~$0.105/image (1K–2K), ~$0.18 (4K); range $0.05–0.24 by provider — [PiAPI](https://piapi.ai/nano-banana-pro); [yingtu calculator](https://yingtu.ai/blog/gemini-3-pro-image-pricing-calculator)
- Nano Banana 2 (Gemini 3.1 Flash Image, `gemini-3.1-flash-image-preview`): max 14 images per prompt; 1120 input tokens per input image (Google Vertex docs) — [Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image?authuser=2)
- Nano Banana 2 price per output: $0.045 (0.5K), $0.067 (1K), $0.101 (2K), $0.151 (4K) per benchlm citing Google; others give $0.063/$0.094 — [benchlm](https://benchlm.ai/md/media-pricing/nano-banana.md); [apidog](https://apidog.com/blog/nano-banana-2-api-pricing). Original Nano Banana (gemini-2.5-flash-image) was $0.039/image — [myarchitectai](https://www.myarchitectai.com/blog/nano-banana-api-pricing)
- Google itself recommends creating Veo "ingredient" images with Nano Banana Pro — [Google blog (snippet)](https://blog.google/innovation-and-ai/technology/ai/veo-3-1-ingredients-to-video/)

**Black Forest Labs (FLUX)**
- FLUX.2 [pro/max/flex] accepts up to 8 reference images, FLUX.2 [klein] up to 4; params `input_image`, `input_image_2`…`input_image_8`, prompt refers to images by number; URLs preferred over base64; result URLs expire in 10 min; pricing per megapixel (input images also billed by MP) — [BFL official skill (skills.sh)](https://skills.sh/black-forest-labs/skills/bfl-api); [apiyi FLUX overview](https://docs.apiyi.com/en/api-capabilities/flux/overview)
- FLUX.1 Kontext (May 2025) designed for minimal drift across successive edits; BFL's KontextBench shows Kontext [pro] top in Character Preservation, but BFL also shows visible degradation after 6 iterative edits — [BFL blog](https://bfl.ai/blog/flux-1-kontext); [Kontext paper arXiv 2506.15742](https://arxiv.org/pdf/2506.15742)

**Ideogram**
- Ideogram 3.0 Character Reference via API: $0.10 Turbo / $0.15 Default / $0.20 Quality per image with a character reference vs $0.03/$0.06/$0.09 without; API billed separately from subscriptions; default 10 concurrent requests — [Ideogram API pricing](https://ideogram.ai/features/api-pricing); [eesel](https://eesel.ai/blog/ideogram-pricing)
- Ideogram character reference was described as oriented to a single reference image of a person/character (reseller listing) — [WaveSpeed Ideogram Character](https://wavespeed.ai/docs/docs-api/ideogram-ai/ideogram-ai-ideogram-character)

**Midjourney**
- No official public API; `--oref` (Omni Reference, launched May 3, 2025, V7) is only accessible via Discord/web or unofficial wrappers (PiAPI, Evolink, CometAPI) — [Evolink](https://evolink.ai/midjourney-v7); [PiAPI](https://piapi.ai/midjourney-api/oref); [CometAPI](https://www.cometapi.com/how-to-use-omni-reference-in-midjourney-v7)

**ByteDance Seedream 4**
- Supports ~10 reference images, batch outputs, up to 4K — [Krea blog](https://www.krea.ai/blog/seedream-4-0-vs-flux-which-image-generator-is-better-in-2026); vendor claims of beating Kontext are self-serving — [AIMLAPI](https://aimlapi.com/models/seedream-4-edit)

**Runway gen4_image (References)**
- `gen4_image` supports visual references with @mentions in prompt; 5 credits (720p) / 8 credits (1080p); `gen4_image_turbo` 2 credits and requires ≥1 reference; API credits $0.01 each; 3-reference cap only from a third-party wrapper (unconfirmed) — [unifically](https://unifically.com/blogs/runway-gen-4); [Picsart API](https://picsart.com/api-platform/models/runway-gen4-ref/advanced)

### Inferences
- Practical shortlist: (1) Nano Banana 2 for cheap high-volume scene stills (~$0.07/1K image, 14 refs → room for 3 angle crops × several characters + a style frame); (2) Nano Banana Pro or gpt-image-2 for the master turnaround sheet and hard scenes; (3) FLUX.2 as non-Google/non-OpenAI fallback with self-hostable open variants. Ideogram is reasonable but single-reference-oriented and pricier per image.
- With 3 angle crops per character, a 3-character scene needs 9 reference images — fits Gemini (14) and FLUX.2 pro (8 is tight; drop to front+3/4) but exceeds gpt-image high-fidelity priority (first 5).
- Commercial terms: OpenAI, Google and BFL API outputs are generally usable commercially by the customer under their terms, but I could not fetch the terms pages this session — verify. Gemini/Veo outputs carry SynthID watermarking (from general knowledge; not re-verified here).

### Gaps
- Official per-image pricing pages (OpenAI, Google, BFL, Stability) could not be fetched; all prices are reseller-reported and conflicting.
- No data collected on Imagen 4 subject reference or Stability AI (SD 3.5 / Stable Image) reference features in 2026.
- No neutral, quantitative benchmark of identity preservation for stylized/cartoon characters across these models was found.
- Commercial terms/IP indemnity per provider not verified.

## 3. Video models with reference images for character consistency

### Takeaway
Veo 3.1 (Gemini API/Vertex) "Ingredients to Video" with up to 3 reference images is the most direct fit; Kling's reference-to-video/elements (multi-view elements: frontal + 1–3 extra views — matches a turnaround sheet exactly) is strongest on multi-view references; Runway offers gen4 references for images plus Act-Two for performance; Sora 2 is no longer an option (API reportedly shut down Sept 24, 2026; cameos were never in the API).

### Cited Findings
- Veo 3.1 accepts up to 3 reference images (character/object/style) to keep consistency; reference images reportedly limited to preview model IDs and not supported on Veo 3.1 Lite — [DEV Veo 3.1 guide (June 2026)](https://dev.to/akaranjkar08/veo-31-developer-guide-timestamp-prompting-multi-shot-video-and-full-api-june-2026-3l5i); [aiapiplaybook Lite](https://aiapiplaybook.pages.dev/blog/google-veo-3-1-lite-image-to-video-api-complete-developer-guide/)
- Google's post: Ingredients to Video improvements in Gemini app, YouTube, Flow, Vids, Gemini API and Vertex AI; better identity consistency "as setting changes"; later expansion added native 9:16 and 1080p/4K — [Google blog](https://blog.google/innovation-and-ai/technology/ai/veo-3-1-ingredients-to-video/); [FoneArena](https://www.fonearena.com/blog/?p=473509); output 8-second clips — [ainauten](https://news.ainauten.com/en/story/google-veo-3-1-ingredients)
- Veo 3.1 price per second (conflicting third-party): Standard ~$0.40/s (720p/1080p), $0.60/s 4K; Fast $0.10–0.15/s (1080p ~$0.12), $0.30 4K; Lite $0.05–0.08/s; no free tier — [benchlm Veo](https://benchlm.ai/md/media-pricing/veo.md); [layer3labs (Sep 2026)](https://www.layer3labs.io/guides/veo-3-pricing)
- Kling reference-to-video (listed as "Kling 4.0", dated Oct 15, 2026 by aggregator): up to 10 reference images, up to 7 elements, each element = frontal image + 1–3 extra views; 3–30 s; @Image1/@Element1 in prompt; $0.157/s 720p, $0.235/s 1080p (aggregator) — [AIMLAPI Kling 4.0](https://aimlapi.com/models/klingai-video-v4-reference-to-video). Kling 3.0 Omni adds video-based element reference; "Bind Subject" locks face/clothing — [apiframe](https://apiframe.ai/blog/kling-3-0-api-providers); [AtlasCloud](https://www.atlascloud.ai/blog/tips/solving-character-inconsistency-a-guide-to-kling-3.0-image-to-video-mode). Older Kling 2.6 elements: up to 4 images (unverified) — [unifically](https://unifically.com/es/blogs/kling-2.6)
- Runway: Act-Two (driving performance + character reference image/video) 5 credits/s ≈ $0.05/s; video model availability in API (gen4_turbo vs gen4.5 at 12 credits/s; aleph 15–28 credits/s) conflicting across sources — [unifically Runway](https://unifically.com/blogs/runway-gen-4); [inference.sh](https://inference.sh/apps/runway)
- Sora 2: cameo not available via API; API blocked real people & copyrighted characters; prices were $0.10/s (sora-2 720p), $0.30–0.50/s (pro) — [CometAPI](https://www.cometapi.com/sora-api-access-in-2026-pricing-rate-limits-and-what-s-actually-available-through-aggregators/); [eesel](https://eesel.ai/blog/sora-2-in-the-api-pricing). Shutdown announced Mar 24, 2026; app closed Apr 26, 2026; API (sora-2, sora-2-pro) shut Sep 24, 2026, no named replacement (secondary sources only) — [invideo (Aug 2026)](https://invideo.io/blog/sora-ai-video-generator/); [zilliz FAQ](https://zilliz.com/ai-faq/what-is-the-sora-shutdown-timeline); [pasqualepillitteri](https://pasqualepillitteri.it/en/news/18764/openai-sora2-api-dismessa-en)

### Inferences
- Budget: an 8 s Veo 3.1 Fast clip at 1080p ≈ $1; Standard ≈ $3.2; a 3-minute kids' episode of all-generated video at Fast ≈ $20–30 before retries; Kling 1080p ≈ $0.24/s ≈ $42/3 min. Image-to-video from an on-model still (first frame generated with the sheet) is often a cheaper, more controllable alternative to pure reference-to-video.
- For Veo's 3-reference cap: pass front + 3/4 of the main character + 1 style/background frame, or one crop per character for 2–3 characters.
- Kling's element structure (frontal + extra views) maps 1:1 to a 3-angle turnaround — strongest structural fit.

### Gaps
- Pika API status/pricing and reference features not researched (no reliable results gathered).
- Official Kuaishou/Kling pricing not found; Kling version naming inconsistent across aggregators.
- Veo personGeneration / child-depiction restrictions not verified (official docs unreachable).

## 4. Prompting techniques and automated validation

### Takeaway
Combine (a) a fixed text "character bible" injected verbatim in every prompt, (b) the turnaround crops as reference images every call, (c) fixed style descriptors, and (d) an automatic off-model gate using DINOv2/CLIP embedding similarity against the sheet crops plus a VLM attribute checklist; seeds help only on diffusion models that expose them and do not transfer across prompts.

### Cited Findings
- Common identity metrics: crop the character, embed with CLIP (CLIP-I) or DINOv2 (DINO-I), cosine similarity vs reference averaged per frame — [AnyCrowd arXiv 2603.15415](https://arxiv.org/pdf/2603.15415); pairwise identity similarity + DINO score across many images of one identity — [Gen-AFFECT arXiv 2508.09461](https://arxiv.org/pdf/2508.09461)
- Global embeddings conflate semantic similarity with identity and miss fine-grained traits; CHARIS proposes VLM attribute-level checks; ID-Sim (2026) targets identity specifically; DiffSim IP Bench has 299 character classes — [CHARIS arXiv 2511.08061](https://arxiv.org/html/2511.08061v1); [ID-Sim 2604.05039](https://www.emergentmind.com/papers/2604.05039); [DiffSim ICCV 2025 supp.](https://openaccess.thecvf.com/content/ICCV2025/supplemental/Song_DiffSim_Taming_Diffusion_ICCV_2025_supplemental.pdf)
- Drift accumulates with iterative editing (Kontext degraded after 6 edits) — always re-reference the original sheet, never chain edits from the previous scene output — [BFL Kontext paper](https://arxiv.org/pdf/2506.15742)
- FLUX.2 prompts can reference inputs by index ("the character from image 1"); Kling uses @Element1; Runway @mentions — [BFL skill](https://skills.sh/black-forest-labs/skills/bfl-api); [AIMLAPI Kling](https://aimlapi.com/models/klingai-video-v4-reference-to-video); [unifically Runway](https://unifically.com/blogs/runway-gen-4)
- Turnaround workflow: lock front view first, then derive others — [Simple Art Tips](https://simplearttips.squarespace.com/simplearttips/turnaround-sheet)

### Inferences
- Recommended pipeline: (1) generate front view; (2) generate a 3-panel sheet using the front view as reference ("same character, front / three-quarter / right profile, neutral A-pose, flat #F5F5F5 background, even lighting, same scale, no shadows"); (3) crop panels with fixed coordinates (or ask for separate images using the sheet as ref); (4) human approves sheet → becomes immutable "canonical asset" with version ID; (5) every scene call = bible text + style block + canonical crops (+ scene layout); (6) gate: detect/crop character, DINOv2 cosine vs best-matching angle crop, threshold calibrated on ~50 human-labeled on/off-model samples per art style; plus VLM checklist (colors by hex, clothing items, number of fingers/ears, accessories); auto-retry up to N times, then flag.
- Character bible fields: name, age-feel, species, proportions (e.g., "head = 1/3 of height"), silhouette shapes, exact palette hex, outfit items, distinctive marks, forbidden changes.
- Keep palette in prompt as hex + name; models drift on color more than shape for flat-shaded cartoons.

### Gaps
- No validated cartoon-specific identity threshold was found; thresholds must be calibrated in-house.
- Whether one-shot 3-panel sheets or separate per-angle generations yield better downstream consistency has no published benchmark; recommendation is inference.

## 5. Pitfalls for kids content (uncanny designs, copyright resemblance, safety filters)

### Takeaway
Biggest legal risk is accidental resemblance to famous IP — generic prompts can yield near-copies (e.g., Minions); add a similarity screen against known characters and avoid generic archetype prompts. Safety filters around minors can block or alter child characters, and Sora's API blocked copyrighted characters; plan for refusals and retries.

### Cited Findings
- Disney & Universal sued Midjourney (C.D. Cal., June 2025) citing images of Yoda, Iron Man, Buzz Lightyear, Bart Simpson, Shrek, Toothless, Po; a generic prompt "yellow 3D cartoon character with goggles and overalls" allegedly produced Minion look-alikes; the studios said other AI services adopted measures to prevent copying — [NBC News](https://www.nbcnews.com/business/business-news/disney-universal-sue-ai-image-company-midjourney-unlicensed-star-wars-rcna212369); [Entrepreneur](https://www.entrepreneur.com/business-news/disney-universal-sue-ai-startup-midjourney-plagiarism/493100)
- No 2026 ruling/settlement found in search results — [CDO Magazine](https://www.cdomagazine.tech/aiml/disney-and-universal-sue-ai-firm-midjourney-over-copyrighted-character-use)
- Sora API blocked real people, copyrighted characters and copyrighted music — [CometAPI](https://www.cometapi.com/sora-api-access-in-2026-pricing-rate-limits-and-what-s-actually-available-through-aggregators/)

### Inferences
- Design guidance for kids: simple shapes, large readable silhouettes, stylized (non-photoreal) faces, big eyes but not hyper-real skin/teeth — avoids uncanny valley and also reduces safety-filter triggers that target realistic minors.
- Make characters distinctive (non-generic species/color combos, unique accessories); run a CLIP/DINO nearest-neighbor check against a gallery of top kids-IP characters and reject high-similarity designs.
- Expect safety filters to refuse prompts like "child in bath/pajamas/beach"; use animal or fantasy characters to reduce friction; log refusals.
- Copyright protection of AI-generated characters themselves is limited (human authorship needed) — keep human design edits documented (inference; not verified in this session).

### Gaps
- YouTube "made for kids" + altered/synthetic-content disclosure rules for 2026 and YouTube's "inauthentic/mass-produced content" monetization policy were not found in this session (likely covered by other researchers).
- Provider-specific minor-depiction policies (Google personGeneration settings, OpenAI image policy) not verified.
- A search result claimed a U.S. Copyright Office ruling on AI depictions of copyrighted characters "two months later" — unverified and vague; not relied on.
