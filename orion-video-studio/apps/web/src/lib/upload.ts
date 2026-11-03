'use client'
import { ALLOWED_UPLOAD_MIME } from '@orion/shared'
import { ApiError, api } from './api'
import type { AssetDto } from './types'

interface CreateUploadRes {
  uploadId: string
  assetId: string
  mode: 'SINGLE' | 'MULTIPART'
  url: string | null
  parts: Array<{ partNumber: number; url: string }>
  partSize: number | null
}

const EXT_MIME: Record<string, string> = { mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', srt: 'application/x-subrip', vtt: 'text/vtt', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac' }

export function mimeOf(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const t = file.type || EXT_MIME[ext] || ''
  return (ALLOWED_UPLOAD_MIME as readonly string[]).includes(t) ? t : EXT_MIME[ext] ?? t
}

function put(url: string, body: Blob, contentType: string | null, onProgress: (loaded: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (contentType) xhr.setRequestHeader('content-type', contentType)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let etag = xhr.getResponseHeader('etag')
        if (!etag) {
          try {
            etag = (JSON.parse(xhr.responseText) as { etag?: string }).etag ?? null
          } catch {
            etag = null
          }
        }
        resolve(etag)
      } else reject(new ApiError(xhr.status, 'upload_failed', `Falha no envio (HTTP ${xhr.status}).`))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Conexão interrompida durante o envio.'))
    xhr.send(body)
  })
}

/** Upload direto ao armazenamento (URL assinada; multipart em blocos de 16 MB). */
export async function uploadFile(workspaceId: string, file: File, onProgress: (p: number) => void, source: 'UPLOAD' | 'RECORDING' = 'UPLOAD'): Promise<string> {
  const mimeType = mimeOf(file)
  if (!(ALLOWED_UPLOAD_MIME as readonly string[]).includes(mimeType)) {
    throw new ApiError(400, 'type', `Formato não suportado: ${file.name}. Use MP4, MOV, WEBM, MP3, WAV, M4A, PNG, JPG, WEBP, SRT ou VTT.`)
  }
  const up = await api<CreateUploadRes>(`/workspaces/${workspaceId}/uploads`, { body: { fileName: file.name, mimeType, sizeBytes: file.size, source } })
  try {
    if (up.mode === 'SINGLE') {
      await put(up.url!, file, mimeType, (l) => onProgress(l / file.size))
      await api(`/uploads/${up.uploadId}/complete`, { body: {} })
    } else {
      const size = up.partSize!
      const done: Array<{ partNumber: number; etag: string }> = []
      const loaded = new Map<number, number>()
      const queue = [...up.parts]
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift()!
          const blob = file.slice((p.partNumber - 1) * size, p.partNumber * size)
          const etag = await put(p.url, blob, null, (l) => {
            loaded.set(p.partNumber, l)
            onProgress([...loaded.values()].reduce((a, b) => a + b, 0) / file.size)
          })
          done.push({ partNumber: p.partNumber, etag: etag ?? '' })
        }
      }
      await Promise.all([worker(), worker(), worker()])
      await api(`/uploads/${up.uploadId}/complete`, { body: { parts: done } })
    }
  } catch (err) {
    await api(`/uploads/${up.uploadId}/abort`, { body: {} }).catch(() => undefined)
    throw err
  }
  onProgress(1)
  return up.assetId
}

export async function waitForAsset(id: string, timeoutMs = 10 * 60_000): Promise<AssetDto> {
  const start = Date.now()
  for (;;) {
    const a = await api<AssetDto>(`/assets/${id}`)
    if (a.status === 'READY') return a
    if (a.status === 'FAILED') throw new ApiError(422, 'asset_failed', a.error ?? 'Falha ao processar a mídia.')
    if (Date.now() - start > timeoutMs) throw new ApiError(408, 'timeout', 'Processamento demorando mais que o esperado.')
    await new Promise((r) => setTimeout(r, 1500))
  }
}
