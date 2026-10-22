import type { EffectType } from './doc.ts'

/**
 * Matriz de suporte de efeitos e transições.
 *
 * preview:  'exact'   — mesma fórmula da exportação (diferença visual mínima)
 *           'approx'  — aproximação documentada na prévia do navegador
 *           'none'    — não aparece na prévia (somente após exportar)
 * export:   'ready'   — validado por teste de renderização real
 *
 * Regra de produto: somente itens com export === 'ready' aparecem na
 * interface. Itens planejados ficam em PLANNED_EFFECTS com fase e custo.
 */
export interface EffectSupport {
  label: string
  preview: 'exact' | 'approx' | 'none'
  export: 'ready'
  ffmpeg: string
  notes: string
}

export const EFFECT_SUPPORT: Record<EffectType, EffectSupport> = {
  color: {
    label: 'Brilho, contraste e saturação',
    preview: 'approx',
    export: 'ready',
    ffmpeg: 'eq',
    notes:
      'Prévia usa filtros CSS (brightness/contrast/saturate); curvas diferem levemente do eq do FFmpeg.',
  },
  temperature: {
    label: 'Temperatura de cor',
    preview: 'approx',
    export: 'ready',
    ffmpeg: 'colortemperature',
    notes: 'Prévia aplica sobreposição tonal; exportação usa colortemperature.',
  },
  blur: {
    label: 'Desfoque',
    preview: 'exact',
    export: 'ready',
    ffmpeg: 'gblur',
    notes: 'Gaussiano nos dois lados (raio escalado pela resolução).',
  },
  vignette: {
    label: 'Vinheta',
    preview: 'approx',
    export: 'ready',
    ffmpeg: 'vignette',
    notes: 'Prévia usa gradiente radial.',
  },
  grain: {
    label: 'Granulação',
    preview: 'approx',
    export: 'ready',
    ffmpeg: 'noise',
    notes: 'Ruído temporal; padrão aleatório difere entre prévia e exportação.',
  },
  chromakey: {
    label: 'Chroma key',
    preview: 'approx',
    export: 'ready',
    ffmpeg: 'chromakey',
    notes:
      'Prévia recorta por distância de cor em resolução reduzida; exportação opera em YUV.',
  },
  denoise: {
    label: 'Redução de ruído (áudio)',
    preview: 'none',
    export: 'ready',
    ffmpeg: 'afftdn',
    notes: 'Audível apenas na exportação.',
  },
}

export const TRANSITION_SUPPORT = {
  cut: { label: 'Corte seco', preview: 'exact', export: 'ready' },
  fade: {
    label: 'Fade (entrada/saída)',
    preview: 'exact',
    export: 'ready',
  },
  dissolve: {
    label: 'Dissolve',
    preview: 'exact',
    export: 'ready',
  },
} as const

export const MOTION_SUPPORT = {
  zoomPan: {
    label: 'Zoom e pan (keyframes de escala e posição)',
    preview: 'exact',
    export: 'ready',
  },
  pip: {
    label: 'Picture-in-picture (trilha de sobreposição + transformação)',
    preview: 'exact',
    export: 'ready',
  },
  animatedText: {
    label: 'Texto animado (fade, slide-up, pop)',
    preview: 'exact',
    export: 'ready',
  },
  overlays: {
    label: 'Sobreposições (imagem/vídeo com opacidade)',
    preview: 'exact',
    export: 'ready',
  },
} as const

export const PLANNED_EFFECTS = [
  {
    label: 'Máscaras (retângulo/elipse com borda suave)',
    phase: 5,
    dependency: 'alphamerge com máscara gerada; editor de forma',
    cost: 'CPU apenas',
  },
  {
    label: 'Remoção de fundo por IA',
    phase: 5,
    dependency: 'modelo de segmentação (ex.: provedor externo ou modelo local com GPU)',
    cost: 'GPU ou cobrança por segundo de vídeo',
  },
  {
    label: 'Rastreamento de movimento',
    phase: 5,
    dependency: 'biblioteca de tracking (OpenCV) em worker dedicado',
    cost: 'CPU intensivo; processamento offline',
  },
] as const
