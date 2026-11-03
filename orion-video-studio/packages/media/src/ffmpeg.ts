import { spawn } from 'node:child_process'

/**
 * Execução de FFmpeg/ffprobe com argumentos separados (spawn sem shell).
 * Nenhum conteúdo do usuário é concatenado em linha de comando; textos vão
 * para arquivos (textfile=, .ass) criados no diretório temporário do job.
 */

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** recebe out_time em microssegundos (a partir de -progress pipe:1) */
  onProgress?: (outTimeUs: number) => void
  cwd?: string
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(message)
  }
}

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

function runProcess(
  bin: string,
  args: string[],
  opts: RunOptions & { collectStdout?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new FfmpegError('cancelado', null, ''))
      return
    }
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let progressBuf = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : null
    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString()
      if (opts.collectStdout) stdout += s
      if (opts.onProgress) {
        progressBuf += s
        let nl: number
        while ((nl = progressBuf.indexOf('\n')) >= 0) {
          const line = progressBuf.slice(0, nl)
          progressBuf = progressBuf.slice(nl + 1)
          const m = /^out_time_us=(\d+)/.exec(line)
          if (m) opts.onProgress(Number(m[1]))
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(new FfmpegError(`falha ao iniciar ${bin}: ${err.message}`, null, ''))
    })
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const reason = opts.signal?.aborted ? 'cancelado' : sig ? `interrompido (${sig})` : `código ${code}`
        reject(new FfmpegError(`${bin} falhou: ${reason}`, code, stderr.slice(-4000)))
      }
    })
  })
}

export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const full = ['-hide_banner', '-nostdin', '-y', ...(opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args]
  const { stderr } = await runProcess(FFMPEG, full, opts)
  return stderr
}

export async function runFfprobe(args: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout } = await runProcess(FFPROBE, ['-v', 'error', ...args], { ...opts, collectStdout: true })
  return stdout
}
