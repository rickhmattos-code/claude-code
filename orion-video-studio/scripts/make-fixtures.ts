/**
 * Gera fixtures de mídia e a biblioteca musical demonstrativa.
 * Todo o material é sintetizado pelo FFmpeg (testsrc2, aevalsrc, etc.),
 * portanto é obra original do projeto, licenciada CC0-1.0.
 *
 *   npx tsx scripts/make-fixtures.ts           # fixtures de teste + música
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fx = join(root, 'tests/fixtures/media')
const music = join(root, 'assets/music')
mkdirSync(fx, { recursive: true })
mkdirSync(music, { recursive: true })

function ff(args: string[], out: string) {
  if (existsSync(out)) return
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args, out], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg falhou para ${out}`)
  console.log('gerado', out)
}

// ---------------------------------------------------------------- vídeo
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=20', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-movflags', '+faststart'], join(fx, 'video_30fps_1080p_20s.mp4'))
if (!existsSync(join(fx, 'video_25fps_rotated_12s.mp4'))) {
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=22050:duration=12', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], join(fx, 'tmp_unrotated.mp4'))
  // rotação via display matrix (−90 = 90° horário), aplicada sem recodificar
  ff(['-display_rotation', '-90', '-i', join(fx, 'tmp_unrotated.mp4'), '-c', 'copy'], join(fx, 'video_25fps_rotated_12s.mp4'))
  rmSync(join(fx, 'tmp_unrotated.mp4'), { force: true })
}
// VFR real: trechos a 30, 12 e 24 fps concatenados mantendo timestamps
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12:duration=3', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-video_track_timescale', '90000'], join(fx, 'video_vfr_10s.mp4'))
// sincronia: flashes brancos e bipes exatamente em 2 s, 5 s e 9 s (duração 1 frame / 50 ms)
ff(
  [
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=12',
    '-f', 'lavfi', '-i', "aevalsrc=if(between(t\\,2\\,2.05)+between(t\\,5\\,5.05)+between(t\\,9\\,9.05)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=12",
    '-vf', "geq=lum='16+219*(between(T,2,2.0333)+between(T,5,5.0333)+between(T,9,9.0333))':cb=128:cr=128",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
  ],
  join(fx, 'sync_flash_beep_12s.mp4'),
)
// "narração" de teste: rajadas tonais (não é fala; testes reais de voz usam provedor)
ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*3*t))*lt(mod(t,4),3)':s=44100:d=30", '-c:a', 'pcm_s16le'], join(fx, 'tone_narration_30s.wav'))
ff(['-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x1d3557:c1=0xe63946:duration=1:speed=0.00001', '-frames:v', '1'], join(fx, 'image_portrait.png'))
ff(['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x0f1220:c1=0xf2a93b:duration=1:speed=0.00001', '-frames:v', '1'], join(fx, 'image_landscape.png'))
ff(['-f', 'lavfi', '-i', 'color=c=white@0.0:s=400x200,format=rgba,drawbox=x=0:y=0:w=400:h=200:color=0xF2A93B@0.9:t=12', '-frames:v', '1'], join(fx, 'logo_alpha.png'))
writeFileSync(join(fx, 'legendas_exemplo.srt'), '1\n00:00:01,000 --> 00:00:03,200\nPrimeira legenda de exemplo\n\n2\n00:00:03,400 --> 00:00:06,000\nSegunda linha, com vírgula\n')

// ---------------------------------------------------------------- música
interface Track {
  file: string
  title: string
  genre: string
  mood: string
  bpm: number
  bars: number
  chords: number[][]
  bassOct: number
  pulse: boolean
  bright: number
}
const N = (semi: number) => 220 * 2 ** (semi / 12) // A3 = 0
const tracks: Track[] = [
  { file: 'aurora-calma.m4a', title: 'Aurora Calma', genre: 'ambiente', mood: 'contemplativo', bpm: 70, bars: 24, chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], bassOct: -12, pulse: false, bright: 1800 },
  { file: 'passo-firme.m4a', title: 'Passo Firme', genre: 'eletrônico', mood: 'energético', bpm: 124, bars: 40, chords: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [5, 9, 12]], bassOct: -12, pulse: true, bright: 4200 },
  { file: 'horizonte-aberto.m4a', title: 'Horizonte Aberto', genre: 'corporativo', mood: 'inspirador', bpm: 100, bars: 32, chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], bassOct: -12, pulse: true, bright: 3000 },
  { file: 'lume-antigo.m4a', title: 'Lume Antigo', genre: 'trilha', mood: 'cinematográfico', bpm: 60, bars: 20, chords: [[0, 3, 7], [-5, -2, 3], [-4, 0, 3], [-2, 2, 5]], bassOct: -24, pulse: false, bright: 1500 },
  { file: 'quadro-leve.m4a', title: 'Quadro Leve', genre: 'acústico', mood: 'leve', bpm: 92, bars: 28, chords: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]], bassOct: -12, pulse: true, bright: 2600 },
  { file: 'risada-curta.m4a', title: 'Risada Curta', genre: 'cômico', mood: 'divertido', bpm: 132, bars: 24, chords: [[0, 4, 7], [2, 5, 9], [4, 7, 11], [5, 9, 12]], bassOct: -12, pulse: true, bright: 5000 },
]
const catalog: unknown[] = []
for (const t of tracks) {
  const barSec = (60 / t.bpm) * 4
  const total = barSec * t.bars
  const segs: string[] = []
  const labels: string[] = []
  for (let b = 0; b < t.bars; b++) {
    const ch = t.chords[b % t.chords.length]!
    const pad = ch.map((s) => `sin(2*PI*${N(s).toFixed(3)}*t)`).join('+')
    const bass = `0.6*sin(2*PI*${N(ch[0]! + t.bassOct).toFixed(3)}*t)`
    const beat = 60 / t.bpm
    const env = t.pulse ? `(0.55+0.45*exp(-6*mod(t,${beat.toFixed(4)})))` : `(0.8+0.2*sin(2*PI*t/${barSec.toFixed(3)}))`
    segs.push(`aevalsrc='0.11*(${pad})*${env}+0.12*${bass}*${env}':s=48000:d=${barSec.toFixed(4)}[b${b}]`)
    labels.push(`[b${b}]`)
  }
  const graph = `${segs.join(';')};${labels.join('')}concat=n=${t.bars}:v=0:a=1,lowpass=f=${t.bright},aecho=0.8:0.7:${Math.round((60 / t.bpm) * 750)}:0.25,afade=t=in:d=1.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,pan=stereo|c0=c0|c1=c0,alimiter=limit=0.9[out]`
  ff(['-filter_complex', graph, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k'], join(music, t.file))
  catalog.push({ file: `music/${t.file}`, title: t.title, artist: 'Orion Studio (síntese procedural)', genre: t.genre, mood: t.mood, bpm: t.bpm, isSfx: false, seconds: Math.round(total * 10) / 10 })
}

// ---------------------------------------------------------------- efeitos
const sfx: Array<{ file: string; title: string; mood: string; graph: string; seconds: number }> = [
  { file: 'whoosh.m4a', title: 'Whoosh', mood: 'transição', seconds: 0.8, graph: "anoisesrc=d=0.8:c=pink:a=0.6,bandpass=f=1200:w=900,afade=t=in:d=0.3,afade=t=out:st=0.35:d=0.45" },
  { file: 'pop.m4a', title: 'Pop', mood: 'destaque', seconds: 0.25, graph: "aevalsrc='0.8*sin(2*PI*(600+900*exp(-30*t))*t)*exp(-18*t)':s=48000:d=0.25" },
  { file: 'click.m4a', title: 'Clique', mood: 'interface', seconds: 0.08, graph: "aevalsrc='0.9*sin(2*PI*2400*t)*exp(-120*t)':s=48000:d=0.08" },
  { file: 'riser.m4a', title: 'Subida', mood: 'tensão', seconds: 3, graph: "aevalsrc='0.4*sin(2*PI*(200+600*t*t/9)*t)*t/3':s=48000:d=3,afade=t=out:st=2.8:d=0.2" },
  { file: 'impacto.m4a', title: 'Impacto', mood: 'drama', seconds: 1.5, graph: "aevalsrc='0.9*sin(2*PI*55*t)*exp(-3*t)':s=48000:d=1.5" },
  { file: 'ding.m4a', title: 'Ding', mood: 'notificação', seconds: 1.2, graph: "aevalsrc='0.5*(sin(2*PI*1318*t)+0.5*sin(2*PI*2637*t))*exp(-4*t)':s=48000:d=1.2" },
]
mkdirSync(join(root, 'assets/sfx'), { recursive: true })
for (const s of sfx) {
  ff(['-filter_complex', `${s.graph},pan=stereo|c0=c0|c1=c0[out]`, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k'], join(root, 'assets/sfx', s.file))
  catalog.push({ file: `sfx/${s.file}`, title: s.title, artist: 'Orion Studio (síntese procedural)', genre: 'efeito', mood: s.mood, bpm: null, isSfx: true, seconds: s.seconds })
}

writeFileSync(
  join(root, 'assets/catalog.json'),
  `${JSON.stringify({ license: { source: 'Orion Studio — gerado por scripts/make-fixtures.ts', author: 'Orion Studio', licenseName: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', commercialUse: true, attributionRequired: false, platformRestrictions: null }, tracks: catalog }, null, 2)}\n`,
)
console.log('ok')
