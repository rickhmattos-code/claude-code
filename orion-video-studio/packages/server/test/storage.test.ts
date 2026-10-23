import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
// @ts-expect-error s3rver não publica tipos
import S3rver from 's3rver'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { LocalStorage, S3Storage, signToken, verifyToken } from '../src/storage.ts'

const dir = mkdtempSync(join(tmpdir(), 'orion-storage-'))

describe('driver local (URLs assinadas)', () => {
  const st = new LocalStorage(join(dir, 'local'), 'x'.repeat(40), '/api')
  test('tokens expiram e não aceitam adulteração', () => {
    const t = signToken('k'.repeat(40), { op: 'get', key: 'a/b.mp4', exp: Date.now() + 1000 })
    expect(verifyToken('k'.repeat(40), t)?.key).toBe('a/b.mp4')
    expect(verifyToken('k'.repeat(40), `${t}x`)).toBeNull()
    expect(verifyToken('k'.repeat(40), signToken('k'.repeat(40), { op: 'get', key: 'a', exp: Date.now() - 1 }))).toBeNull()
  })
  test('impede path traversal', () => {
    expect(() => st.pathFor('../etc/passwd')).toThrow()
    expect(() => st.pathFor('/abs')).toThrow()
  })
  test('upload multipart local monta as partes em ordem', async () => {
    const id = await st.createMultipart('ws/x/a.bin')
    await st.writePart('ws/x/a.bin', id, 2, Readable.from([Buffer.from('mundo')]), 100)
    await st.writePart('ws/x/a.bin', id, 1, Readable.from([Buffer.from('olá ')]), 100)
    await st.completeMultipart('ws/x/a.bin', id, [{ partNumber: 2, etag: '' }, { partNumber: 1, etag: '' }])
    expect(readFileSync(st.pathFor('ws/x/a.bin'), 'utf8')).toBe('olá mundo')
  })
  test('corpo maior que o declarado é recusado', async () => {
    await expect(st.writeStream('ws/x/b.bin', Readable.from([Buffer.alloc(50)]), 10)).rejects.toThrow()
  })
})

describe('driver S3 (contra s3rver local)', () => {
  let server: { run: () => Promise<{ port: number }>; close: () => Promise<void> }
  let st: S3Storage
  beforeAll(async () => {
    server = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: join(dir, 's3'), configureBuckets: [{ name: 'orion-media' }] })
    const { port } = await server.run()
    st = new S3Storage('orion-media', { endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true })
  })
  afterAll(async () => server?.close())
  test('PUT pré-assinado, HEAD, GET pré-assinado, download e remoção', async () => {
    const body = Buffer.from('conteúdo de teste')
    const url = await st.presignPut('ws/1/a.txt', 'text/plain', body.length, 60)
    const r = await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body })
    expect(r.ok).toBe(true)
    expect((await st.head('ws/1/a.txt'))?.size).toBe(body.length)
    const get = await fetch(await st.presignGet('ws/1/a.txt', 60))
    expect(await get.text()).toBe('conteúdo de teste')
    await st.download('ws/1/a.txt', join(dir, 'down.txt'))
    expect(readFileSync(join(dir, 'down.txt'), 'utf8')).toBe('conteúdo de teste')
    await st.remove('ws/1/a.txt')
    expect(await st.head('ws/1/a.txt')).toBeNull()
  })
  test('multipart com URLs pré-assinadas por parte', async () => {
    const part1 = Buffer.alloc(5 * 1024 * 1024, 1)
    const part2 = Buffer.from('fim')
    const id = await st.createMultipart('ws/1/big.bin', 'application/octet-stream')
    const etags = []
    for (const [n, b] of [[1, part1], [2, part2]] as const) {
      const r = await fetch(await st.presignPart('ws/1/big.bin', id, n, 60), { method: 'PUT', body: b })
      etags.push({ partNumber: n, etag: r.headers.get('etag') ?? '' })
    }
    await st.completeMultipart('ws/1/big.bin', id, etags)
    expect((await st.head('ws/1/big.bin'))?.size).toBe(part1.length + part2.length)
  })
  test('upload pelo servidor', async () => {
    writeFileSync(join(dir, 'up.txt'), 'via servidor')
    await st.upload('ws/1/up.txt', join(dir, 'up.txt'), 'text/plain')
    expect((await st.head('ws/1/up.txt'))?.size).toBe(12)
  })
})

describe('mensagens de erro para o usuário (pt-BR)', () => {
  test('erros de sistema, armazenamento e banco viram frases em português com o detalhe técnico', async () => {
    const { userFacingError } = await import('../src/index.ts')
    expect(userFacingError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).toBe('Sem espaço em disco no servidor de processamento. Detalhes técnicos: ENOSPC.')
    expect(userFacingError(Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }))).toMatch(/^O arquivo não existe mais no armazenamento\./)
    expect(userFacingError(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))).toBe('Erro no banco de dados. Detalhes técnicos: P2025.')
  })
  test('mensagens já em português passam intactas; o resto ganha frase em português', async () => {
    const { userFacingError } = await import('../src/index.ts')
    expect(userFacingError(new Error('Projeto inválido: trilha sem clipes'))).toBe('Projeto inválido: trilha sem clipes')
    expect(userFacingError(new Error('Cannot read properties of undefined'))).toBe('Erro inesperado no processamento. Detalhes técnicos: Cannot read properties of undefined')
  })
})
