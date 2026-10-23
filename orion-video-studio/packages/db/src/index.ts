import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client.ts'

export * from './generated/client.ts'

let singleton: PrismaClient | null = null

/** Cliente Prisma (driver adapter pg). Uma instância por processo. */
export function getPrisma(url = process.env.DATABASE_URL): PrismaClient {
  if (singleton) return singleton
  if (!url) throw new Error('DATABASE_URL não definida')
  singleton = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  return singleton
}

export async function disconnectPrisma() {
  if (singleton) await singleton.$disconnect()
  singleton = null
}

/** BigInt ↔ number seguro para tempos em flicks e tamanhos. */
export function toNum(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new RangeError('valor fora do intervalo seguro')
  return n
}
