/**
 * Folha de personagem em 3 ângulos (regra do produto: toda arte de personagem
 * nasce como uma folha com frente, três quartos e perfil, gerada numa ÚNICA
 * imagem para que as três vistas sejam o mesmo personagem). O worker recorta a
 * folha em três referências; cenas com o personagem só são geradas depois que
 * as três vistas forem aprovadas.
 */

export const CHARACTER_ANGLES = ['FRONT', 'THREE_QUARTER', 'PROFILE'] as const
export type CharacterViewAngle = (typeof CHARACTER_ANGLES)[number]

export const CHARACTER_ANGLE_LABELS: Record<CharacterViewAngle | 'SHEET', string> = {
  SHEET: 'Folha completa',
  FRONT: 'Frente',
  THREE_QUARTER: 'Três quartos (3/4)',
  PROFILE: 'Perfil',
}

export interface CharacterBible {
  name: string
  description: string
  appearance: string
  wardrobe: string
  palette: string[]
  mustKeep: string[]
}

/**
 * Prompt da folha. As instruções de composição ficam em inglês porque os
 * modelos de imagem seguem layout com mais precisão nesse idioma; a descrição
 * do personagem é a do usuário, sem tradução.
 */
export function turnaroundPrompt(c: CharacterBible, style = "children's 2D cartoon, rounded friendly shapes, big expressive eyes, soft clean outlines, flat vibrant colors"): string {
  const keep = c.mustKeep.length ? `\nMust keep in every view: ${c.mustKeep.join('; ')}.` : ''
  const palette = c.palette.length ? `\nColor palette (exact): ${c.palette.join(', ')}.` : ''
  return [
    'Character turnaround model sheet of ONE original character, three views of the SAME character side by side in a single wide image.',
    'Layout: three equal columns, evenly spaced, same scale and same height, feet aligned on the same baseline.',
    'Left column: front view. Center column: three-quarter view (turned 45 degrees to the right). Right column: side profile view facing right.',
    'Full body, neutral standing pose, arms relaxed, neutral friendly expression, plain pure white background, flat even lighting, no cast shadows, no text, no labels, no borders, no extra characters or props.',
    `Style: ${style}. Original design for a children's educational channel; do not resemble any existing franchise character.`,
    `Character name: ${c.name}.`,
    c.description && `Personality: ${c.description}.`,
    `Appearance: ${c.appearance}.`,
    c.wardrobe && `Outfit: ${c.wardrobe}.`,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(keep, palette)
    .slice(0, 3900)
}

/** As três vistas aprovadas estão presentes? */
export function hasFullTurnaround(refs: Array<{ angle: string | null }>): boolean {
  return CHARACTER_ANGLES.every((a) => refs.some((r) => r.angle === a))
}
