import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { IMAGE_TYPES, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, base64Bytes, parseBehavior, parseFileRef } from './hold.js'

export const QUEUE_VERSION = 2
export const QUEUE_FILE = 'hold-queue.json'

// An image keeps its own bytes, which is what lets a row show it before the
// message exists. A file keeps the durable reference its upload was resolved to,
// because the receipt does not outlive the draft that minted it.
const decodeAttachment = (value) => {
  if (value === null || typeof value !== 'object') return undefined

  if (value.kind === 'image') {
    if (!IMAGE_TYPES.includes(value.mediaType)) return undefined
    if (typeof value.data !== 'string' || value.data === '') return undefined
    if (base64Bytes(value.data) > MAX_IMAGE_BYTES) return undefined
    const name = typeof value.name === 'string' && value.name !== '' ? value.name : undefined
    return {
      kind: 'image',
      mediaType: value.mediaType,
      data: value.data,
      ...(name === undefined ? {} : { name }),
    }
  }

  if (value.kind === 'file') {
    const ref = parseFileRef(value.attachment)
    if (ref === undefined) return undefined
    return { kind: 'file', attachment: ref }
  }

  return undefined
}

const decodeAttachments = (value) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return undefined
  const attachments = []
  for (const item of value) {
    const decoded = decodeAttachment(item)
    if (decoded === undefined) return undefined
    attachments.push(decoded)
  }
  return attachments
}

// One persisted record, or undefined when the file cannot be trusted.
const decodeRecord = (value) => {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return undefined
  if (typeof value.text !== 'string') return undefined
  if (!Number.isFinite(value.createdAt)) return undefined

  const attachments = decodeAttachments(value.attachments)
  if (attachments === undefined) return undefined
  if (value.text.trim() === '' && attachments.length === 0) return undefined

  const at = Number.isFinite(value.at) ? value.at : null

  return {
    id: value.id,
    sessionId: value.sessionId,
    text: value.text,
    at,
    behavior: parseBehavior(value.behavior),
    createdAt: value.createdAt,
    attachments,
  }
}

// Written temp-and-rename so a crash never leaves a half-written file. There is
// deliberately no cap on the number of records.
export const createQueue = ({ report = () => {}, filePath = dshHomePath(QUEUE_FILE) } = {}) => {
  let records = []

  const persist = () => {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: QUEUE_VERSION, records }, null, 2))
      renameSync(temporary, filePath)
    } catch (error) {
      report('queue persist failed', { message: String((error && error.message) || error) })
    }
  }

  const load = () => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed?.version === QUEUE_VERSION && Array.isArray(parsed.records)) {
        records = parsed.records.map(decodeRecord).filter(Boolean)
      } else if (parsed?.version !== undefined) {
        report('queue discarded', { found: parsed.version, expected: QUEUE_VERSION })
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        report('queue load failed', { message: String((error && error.message) || error) })
      }
    }
    return records
  }

  // Attachments included, so a caller cannot reach into the store through an
  // array or a reference object it was handed.
  const copy = (record) => ({
    ...record,
    attachments: record.attachments.map((attachment) =>
      attachment.kind === 'file'
        ? { kind: 'file', attachment: { ...attachment.attachment } }
        : { ...attachment },
    ),
  })

  return {
    load,
    all: () => records.map(copy),
    forSession: (sessionId) => records.filter((record) => record.sessionId === sessionId).map(copy),
    get size() {
      return records.length
    },
    get path() {
      return filePath
    },
    add(record) {
      const decoded = decodeRecord({ ...record, id: record.id ?? randomUUID() })
      if (decoded === undefined) return undefined
      records.push(decoded)
      persist()
      return copy(decoded)
    },
    replace(id, patch) {
      const index = records.findIndex((record) => record.id === id)
      if (index === -1) return undefined
      const next = decodeRecord({ ...records[index], ...patch, id })
      if (next === undefined) return undefined
      records[index] = next
      persist()
      return copy(next)
    },
    remove(id) {
      const before = records.length
      records = records.filter((record) => record.id !== id)
      if (records.length === before) return false
      persist()
      return true
    },
  }
}
