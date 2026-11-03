/**
 * Mensagens de falha exibidas ao usuário (exportações, mídias, gerações) em
 * pt-BR. Erros do sistema operacional, do armazenamento e do banco chegam em
 * inglês; aqui viram uma frase em português, mantendo o original como
 * "detalhes técnicos" para diagnóstico.
 */

const SYSTEM_CODES: Record<string, string> = {
  ENOSPC: 'Sem espaço em disco no servidor de processamento.',
  ENOMEM: 'Memória insuficiente no servidor de processamento.',
  ENOENT: 'Um arquivo necessário não foi encontrado durante o processamento.',
  EACCES: 'Sem permissão para acessar um arquivo no servidor.',
  EPERM: 'Sem permissão para acessar um arquivo no servidor.',
  EMFILE: 'O servidor atingiu o limite de arquivos abertos.',
  ETIMEDOUT: 'Tempo esgotado ao falar com um serviço interno.',
  ECONNRESET: 'A conexão com um serviço interno foi interrompida.',
  ECONNREFUSED: 'Um serviço interno recusou a conexão.',
  EAI_AGAIN: 'Falha temporária de DNS ao falar com um serviço interno.',
  ENOTFOUND: 'Endereço de um serviço interno não encontrado.',
}

const STORAGE_ERRORS: Record<string, string> = {
  NoSuchKey: 'O arquivo não existe mais no armazenamento.',
  NoSuchBucket: 'O bucket de armazenamento não existe.',
  AccessDenied: 'O armazenamento recusou o acesso (credenciais ou permissões).',
  InvalidAccessKeyId: 'Credencial de armazenamento inválida.',
  SignatureDoesNotMatch: 'Credencial de armazenamento inválida.',
  SlowDown: 'O armazenamento pediu para reduzir o ritmo de requisições.',
}

/** Texto já escrito em português pelo próprio sistema (não precisa de tradução). */
const looksPortuguese = (s: string) => /[áàâãéêíóôõúç]|\b(não|falh\w*|inválid\w*|erro|arquivo|projeto|mídia|cancelad\w*|provedor)\b/i.test(s)

export function userFacingError(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : String(err)
  const code = typeof e?.code === 'string' ? e.code : undefined
  const name = typeof e?.name === 'string' ? e.name : undefined
  if (code && SYSTEM_CODES[code]) return `${SYSTEM_CODES[code]} Detalhes técnicos: ${code}.`
  if (name && STORAGE_ERRORS[name]) return `${STORAGE_ERRORS[name]} Detalhes técnicos: ${name}.`
  if (code && /^P\d{4}$/.test(code)) return `Erro no banco de dados. Detalhes técnicos: ${code}.`
  if (looksPortuguese(message)) return message
  return `Erro inesperado no processamento. Detalhes técnicos: ${message}`
}
