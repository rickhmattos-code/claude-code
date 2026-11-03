import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Armazenamento compatível com S3 com dois drivers:
 *  - 's3'    — AWS S3, MinIO, R2… (URLs pré-assinadas do SDK; upload direto
 *              do navegador ao bucket, multipart para arquivos grandes).
 *  - 'local' — disco do servidor; a API emite URLs temporárias assinadas por
 *              HMAC (mesma semântica: upload direto, multipart, expiração).
 * Chaves de objeto são geradas pelo servidor (nunca pelo cliente).
 */

export interface PartRef {
  partNumber: number
  etag: string
}

export interface Storage {
  driver: 'local' | 's3'
  presignPut(key: string, contentType: string, sizeBytes: number, expiresSec: number): Promise<string>
  createMultipart(key: string, contentType: string): Promise<string>
  presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string>
  completeMultipart(key: string, uploadId: string, parts: PartRef[]): Promise<void>
  abortMultipart(key: string, uploadId: string): Promise<void>
  presignGet(key: string, expiresSec: number, downloadName?: string): Promise<string>
  download(key: string, path: string): Promise<void>
  upload(key: string, path: string, contentType: string): Promise<void>
  remove(key: string): Promise<void>
  head(key: string): Promise<{ size: number } | null>
}

// ---------------------------------------------------------------------------
// Tokens assinados (driver local)
// ---------------------------------------------------------------------------

export interface SignedToken {
  op: 'put' | 'part' | 'get'
  key: string
  exp: number
  ct?: string
  max?: number
  uploadId?: string
  part?: number
  name?: string
}

const b64 = (b: Buffer) => b.toString('base64url')

export function signToken(secret: string, payload: SignedToken): string {
  const body = b64(Buffer.from(JSON.stringify(payload)))
  const mac = b64(createHmac('sha256', secret).update(body).digest())
  return `${body}.${mac}`
}

export function verifyToken(secret: string, token: string, now = Date.now()): SignedToken | null {
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as SignedToken
    if (typeof p.exp !== 'number' || p.exp < now) return null
    return p
  } catch {
    return null
  }
}

export class LocalStorage implements Storage {
  driver = 'local' as const
  readonly root: string
  constructor(
    root: string,
    private readonly secret: string,
    /** prefixo público das rotas /storage (ex.: "/api" atrás do proxy do Next) */
    private readonly publicBase: string,
  ) {
    this.root = resolve(root)
    if (secret.length < 32) throw new Error('URL_SIGNING_SECRET deve ter pelo menos 32 caracteres')
  }
  /** resolve a chave dentro da raiz (impede path traversal) */
  pathFor(key: string): string {
    if (!/^[\w./-]+$/.test(key) || key.includes('..')) throw new Error('chave de objeto inválida')
    const p = resolve(this.root, key)
    if (!p.startsWith(this.root + sep)) throw new Error('chave fora da raiz')
    return p
  }
  private url(t: SignedToken) {
    return `${this.publicBase}/storage/${signToken(this.secret, t)}`
  }
  verify(token: string) {
    return verifyToken(this.secret, token)
  }
  async presignPut(key: string, contentType: string, sizeBytes: number, expiresSec: number) {
    return this.url({ op: 'put', key, exp: Date.now() + expiresSec * 1000, ct: contentType, max: sizeBytes })
  }
  async createMultipart(key: string) {
    const uploadId = crypto.randomUUID()
    await mkdir(this.partsDir(key, uploadId), { recursive: true })
    return uploadId
  }
  partsDir(key: string, uploadId: string) {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('uploadId inválido')
    return `${this.pathFor(key)}.parts-${uploadId}`
  }
  async presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number) {
    return this.url({ op: 'part', key, uploadId, part: partNumber, exp: Date.now() + expiresSec * 1000 })
  }
  async completeMultipart(key: string, uploadId: string, parts: PartRef[]) {
    const dir = this.partsDir(key, uploadId)
    const out = this.pathFor(key)
    await mkdir(dirname(out), { recursive: true })
    const ws = createWriteStream(out)
    for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const partPath = join(dir, String(p.partNumber))
      await new Promise<void>((res, rej) => {
        const rs = createReadStream(partPath)
        rs.on('error', rej)
        rs.on('end', () => res())
        rs.pipe(ws, { end: false })
      })
    }
    await new Promise<void>((res) => ws.end(() => res()))
    await rm(dir, { recursive: true, force: true })
  }
  async abortMultipart(key: string, uploadId: string) {
    await rm(this.partsDir(key, uploadId), { recursive: true, force: true })
  }
  async presignGet(key: string, expiresSec: number, downloadName?: string) {
    return this.url({ op: 'get', key, exp: Date.now() + expiresSec * 1000, ...(downloadName ? { name: downloadName } : {}) })
  }
  async download(key: string, path: string) {
    await mkdir(dirname(path), { recursive: true })
    await copyFile(this.pathFor(key), path)
  }
  async upload(key: string, path: string) {
    const out = this.pathFor(key)
    await mkdir(dirname(out), { recursive: true })
    await copyFile(path, out)
  }
  async writeStream(key: string, body: Readable, maxBytes: number): Promise<number> {
    const out = this.pathFor(key)
    await mkdir(dirname(out), { recursive: true })
    return this.streamTo(out, body, maxBytes)
  }
  async writePart(key: string, uploadId: string, part: number, body: Readable, maxBytes: number) {
    const dir = this.partsDir(key, uploadId)
    await mkdir(dir, { recursive: true })
    const size = await this.streamTo(join(dir, String(part)), body, maxBytes)
    return { etag: `"local-${part}-${size}"`, size }
  }
  private async streamTo(out: string, body: Readable, maxBytes: number): Promise<number> {
    let size = 0
    const tmp = `${out}.tmp-${process.pid}-${Date.now()}`
    body.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) body.destroy(new Error('arquivo maior que o declarado'))
    })
    try {
      await pipeline(body, createWriteStream(tmp))
      const { rename } = await import('node:fs/promises')
      await rename(tmp, out)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return size
  }
  async remove(key: string) {
    await rm(this.pathFor(key), { force: true })
  }
  async head(key: string) {
    try {
      const s = await stat(this.pathFor(key))
      return { size: s.size }
    } catch {
      return null
    }
  }
  /** limpeza de multipart abandonados */
  async listStaleParts(olderThanMs: number): Promise<string[]> {
    const out: string[] = []
    const walk = async (d: string) => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (e.name.includes('.parts-')) {
            const s = await stat(p)
            if (Date.now() - s.mtimeMs > olderThanMs) out.push(p)
          } else await walk(p)
        }
      }
    }
    await walk(this.root)
    return out
  }
}

export class S3Storage implements Storage {
  driver = 's3' as const
  private client: S3Client
  /** cliente só para assinar URLs com o endpoint visto pelo navegador */
  private signer: S3Client
  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string; publicEndpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
  ) {
    const base = {
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // compatibilidade com MinIO/R2/etc.: sem checksums "aws-chunked" automáticos
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    }
    this.client = new S3Client({ ...base, endpoint: opts.endpoint || undefined })
    this.signer = new S3Client({ ...base, endpoint: opts.publicEndpoint || opts.endpoint || undefined })
  }
  presignPut(key: string, contentType: string, sizeBytes: number, expiresSec: number) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }), { expiresIn: expiresSec })
  }
  async createMultipart(key: string, contentType: string) {
    const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }))
    if (!r.UploadId) throw new Error('S3 não retornou UploadId')
    return r.UploadId
  }
  presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number) {
    return getSignedUrl(this.signer, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: expiresSec })
  }
  async completeMultipart(key: string, uploadId: string, parts: PartRef[]) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    )
  }
  async abortMultipart(key: string, uploadId: string) {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
  }
  presignGet(key: string, expiresSec: number, downloadName?: string) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"` } : {}) }),
      { expiresIn: expiresSec },
    )
  }
  async download(key: string, path: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    await mkdir(dirname(path), { recursive: true })
    await pipeline(r.Body as Readable, createWriteStream(path))
  }
  async upload(key: string, path: string, contentType: string) {
    const s = await stat(path)
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentType: contentType, ContentLength: s.size }))
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: Number(r.ContentLength ?? 0) }
    } catch {
      return null
    }
  }
}

export function createStorage(env: Record<string, string | undefined>): Storage {
  if ((env.STORAGE_DRIVER ?? 'local') === 's3') {
    const need = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
    const miss = need.filter((k) => !env[k])
    if (miss.length) throw new Error(`STORAGE_DRIVER=s3 requer ${miss.join(', ')}`)
    return new S3Storage(env.S3_BUCKET!, {
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      region: env.S3_REGION ?? 'us-east-1',
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    })
  }
  return new LocalStorage(fromRepoRoot(env.STORAGE_LOCAL_DIR ?? './.data/storage'), env.URL_SIGNING_SECRET ?? '', env.STORAGE_PUBLIC_BASE ?? '/api')
}

/** Raiz do monorepo; caminhos relativos do .env são resolvidos a partir dela. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export function fromRepoRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p)
}
