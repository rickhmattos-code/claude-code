import type { Effect } from '@orion/shared'

export type MaskEffect = Extract<Effect, { type: 'mask' }>

/**
 * Geometria da máscara em pixels de uma camada w×h. Usada pela prévia (canvas)
 * e pela exportação (geq + gblur) para que as duas recortem igual.
 */
export interface MaskGeometry {
  cx: number
  cy: number
  rx: number
  ry: number
  /** desvio-padrão da borda suave (px) */
  sigma: number
}

export function maskGeometry(m: MaskEffect, w: number, h: number): MaskGeometry {
  return {
    cx: m.x * w,
    cy: m.y * h,
    rx: Math.max(0.5, (m.w * w) / 2),
    ry: Math.max(0.5, (m.h * h) / 2),
    sigma: (m.feather * Math.min(w, h)) / 2,
  }
}

/** Cobertura dura (0/1) do pixel de centro (px, py). */
export function maskInside(m: MaskEffect, g: MaskGeometry, px: number, py: number): boolean {
  if (m.shape === 'ellipse') return ((px - g.cx) / g.rx) ** 2 + ((py - g.cy) / g.ry) ** 2 <= 1
  return Math.abs(px - g.cx) <= g.rx && Math.abs(py - g.cy) <= g.ry
}

export const masksOf = (effects: Effect[]): MaskEffect[] => effects.filter((e): e is MaskEffect => e.type === 'mask')
