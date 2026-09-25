// Pure hold model, shared by both halves. No clock, no services, no I/O.

// How a released message is delivered.
//
//   queue - an ordinary follow-up turn, the harness' own queue behaviour
//   wait  - the same, but only once the session is actually finished
//   steer - taken at the nearest step boundary while the agent is running
export const BEHAVIORS = ['queue', 'wait', 'steer']

export const MAX_TEXT_CHARS = 20000

// The harness' own per-message image limit, so nothing that can be staged is
// refused for its count alone.
export const MAX_ATTACHMENTS = 20

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// A hold is a JSON file the host rewrites on every change, so it takes a smaller
// image budget than the 200 MB the harness allows per message. One image at the
// harness' own per-image default, and 32 MB across the hold.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

// Canonical base64 is four characters per three bytes, padded to a multiple of
// four, which is what `Buffer.prototype.toString('base64')` produces.
export const base64Chars = (bytes) => 4 * Math.ceil(bytes / 3)

export const MAX_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

const fail = (code, message) => ({ ok: false, code, message })

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// Decoded byte length of canonical base64, without decoding it.
export const base64Bytes = (data) => {
  if (typeof data !== 'string' || data === '') return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

// The harness' durable file reference shape, which is what a hold keeps once the
// receipt that minted it has gone.
export const parseFileRef = (value) => {
  if (!isPlainObject(value)) return undefined
  if (typeof value.attachmentId !== 'string' || value.attachmentId === '') return undefined
  if (typeof value.name !== 'string' || value.name === '') return undefined
  if (!Number.isFinite(value.bytes) || value.bytes < 0) return undefined
  return { attachmentId: value.attachmentId, name: value.name, bytes: value.bytes }
}

// A file arrives either as the receipt its upload minted, which is the composer's
// staged shape, or as the durable reference an edit of a hold sends back.
export const parseAttachment = (raw) => {
  if (!isPlainObject(raw)) return fail('invalid_attachment', 'an attachment must be an object')

  if (raw.kind === 'image') {
    if (!IMAGE_TYPES.includes(raw.mediaType)) {
      return fail('invalid_attachment', `an image must be one of ${IMAGE_TYPES.join(', ')}`)
    }
    if (typeof raw.data !== 'string' || raw.data === '') {
      return fail('invalid_attachment', 'an image must carry its encoded bytes')
    }
    if (base64Bytes(raw.data) > MAX_IMAGE_BYTES) {
      return fail('attachment_too_large', 'that image is larger than the harness accepts')
    }
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined
    return {
      ok: true,
      attachment: {
        kind: 'image',
        mediaType: raw.mediaType,
        data: raw.data,
        ...(name === undefined ? {} : { name }),
      },
    }
  }

  if (raw.kind === 'file') {
    if (typeof raw.receiptId === 'string' && raw.receiptId !== '') {
      const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined
      return {
        ok: true,
        attachment: { kind: 'file', receiptId: raw.receiptId, ...(name === undefined ? {} : { name }) },
      }
    }

    const ref = parseFileRef(raw.attachment)
    if (ref === undefined) {
      return fail('invalid_attachment', 'a file must carry the receipt of its upload')
    }
    return { ok: true, attachment: { kind: 'file', attachment: ref } }
  }

  return fail('invalid_attachment', 'an attachment must be an image or a file')
}

export const parseAttachments = (raw) => {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] }
  if (!Array.isArray(raw)) return fail('invalid_attachment', 'attachments must be a list')
  if (raw.length > MAX_ATTACHMENTS) {
    return fail('too_many_attachments', `a message may hold at most ${MAX_ATTACHMENTS} attachments`)
  }

  const attachments = []
  let bytes = 0
  for (const item of raw) {
    const parsed = parseAttachment(item)
    if (!parsed.ok) return parsed
    if (parsed.attachment.kind === 'image') bytes += base64Bytes(parsed.attachment.data)
    attachments.push(parsed.attachment)
  }

  if (bytes > MAX_ATTACHMENT_BYTES) {
    return fail('attachment_too_large', 'those attachments are too large to hold')
  }
  return { ok: true, attachments }
}

export const parseBehavior = (value) => (BEHAVIORS.includes(value) ? value : 'wait')

// `at` is the independent second axis. Null means no earliest time.
export const parseAt = (value, now) => {
  if (value === null || value === undefined) return { ok: true, at: null }
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_INSTANT) {
    return fail('invalid_at', 'at must be a whole epoch-millisecond instant within a four-digit year')
  }
  if (value <= now) return fail('not_future', 'at must be strictly later than now')
  return { ok: true, at: value }
}

export const parseHoldRequest = (payload, now) => {
  const text = typeof payload?.text === 'string' ? payload.text : ''
  const carried = parseAttachments(payload?.attachments)
  if (!carried.ok) return carried
  // An image-only hold is a real message, exactly as an image-only send is.
  if (text.trim() === '' && carried.attachments.length === 0) {
    return fail('invalid_text', 'a non-empty message is required')
  }
  if (text.length > MAX_TEXT_CHARS) {
    return fail('text_too_long', `the message must be at most ${MAX_TEXT_CHARS} characters`)
  }

  const parsed = parseAt(payload?.at, now)
  if (!parsed.ok) return parsed

  return {
    ok: true,
    request: {
      text,
      at: parsed.at,
      behavior: parseBehavior(payload?.behavior),
      attachments: carried.attachments,
    },
  }
}

// Every field is optional, and only what is present is replaced.
export const parseHoldPatch = (payload, now) => {
  const patch = {}

  if (payload?.text !== undefined) {
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.length > MAX_TEXT_CHARS) {
      return fail('text_too_long', `the message must be at most ${MAX_TEXT_CHARS} characters`)
    }
    patch.text = text
  }

  if (payload?.attachments !== undefined) {
    const carried = parseAttachments(payload.attachments)
    if (!carried.ok) return carried
    patch.attachments = carried.attachments
  }

  // An edit may empty the text only while something is still attached.
  const text = patch.text
  if (text !== undefined && text.trim() === '') {
    const attachments = patch.attachments
    if (attachments === undefined || attachments.length === 0) {
      return fail('invalid_text', 'a non-empty message is required')
    }
  }

  if (payload?.at !== undefined) {
    const parsed = parseAt(payload.at, now)
    if (!parsed.ok) return parsed
    patch.at = parsed.at
  }

  if (payload?.behavior !== undefined) patch.behavior = parseBehavior(payload.behavior)

  return { ok: true, patch }
}

// Everything still running in one session, in the order it is reported. An
// absent agent is never finished, because a closed session has to come back
// before anything can be delivered into it.
export const busyReasons = (signals) => {
  const reasons = []
  const agent = signals?.agent ?? 'absent'

  if (agent === 'absent') return ['agent-absent']
  if (agent === 'running') reasons.push('agent')

  if ((signals?.subagents?.running ?? 0) > 0) reasons.push('subagents')
  if ((signals?.jobs?.running ?? 0) > 0) reasons.push('jobs')

  return reasons
}

export const isComplete = (signals) => busyReasons(signals).length === 0

// The browser picks a local wall clock. The wire carries the resulting instant,
// or null for no earliest time.

// A rolled-over date, such as 31 February, is refused rather than shifted.
export const instantFromParts = ({ year, month, day, hour = 0, minute = 0 }) => {
  if (![year, month, day, hour, minute].every((value) => Number.isSafeInteger(value))) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  const at = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null
  return at.getTime()
}

export const formatWhenField = (ms) => {
  const at = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// Monday first, with null for the padding cells.
export const monthGrid = (year, month) => {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) return []

  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const length = new Date(year, month, 0).getDate()

  const cells = new Array(lead).fill(null)
  for (let day = 1; day <= length; day += 1) cells.push(day)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export const shiftMonth = (year, month, delta) => {
  const index = year * 12 + (month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

// One attachment as a row describes it: the name it was staged with, or a
// stand-in when it had none.
export const attachmentLabel = (attachment) => {
  const named = typeof attachment?.name === 'string' && attachment.name !== ''
  if (attachment?.kind === 'image') return named ? attachment.name : 'image'
  if (attachment?.kind === 'file') {
    const file = attachment.attachment
    return typeof file?.name === 'string' && file.name !== '' ? file.name : named ? attachment.name : 'file'
  }
  return 'attachment'
}

// The way the composer's own file cards read a size.
export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export const attachmentBytes = (attachment) =>
  attachment?.kind === 'image' ? base64Bytes(attachment.data) : (attachment?.attachment?.bytes ?? 0)

export const toHeldAttachment = (part) => {
  if (part?.type === 'image') {
    const name = typeof part.name === 'string' && part.name !== '' ? part.name : undefined
    return {
      kind: 'image',
      mediaType: part.mediaType,
      data: part.data,
      ...(name === undefined ? {} : { name }),
    }
  }
  if (part?.type === 'file' && typeof part.receiptId === 'string' && part.receiptId !== '') {
    return { kind: 'file', receiptId: part.receiptId }
  }
  return undefined
}

// One attachment as the window and the rows draw it. Two sources feed this, the
// composer's staged descriptors and the held record.
export const heldAttachmentDisplay = (attachment, key) => ({
  key,
  kind: attachment.kind,
  name: attachmentLabel(attachment),
  sizeText: formatBytes(attachmentBytes(attachment)),
  previewUrl:
    attachment.kind === 'image' ? `data:${attachment.mediaType};base64,${attachment.data}` : undefined,
})

export const stagedAttachmentDisplay = (descriptor, key) => ({
  key,
  kind: descriptor.kind,
  name: typeof descriptor.file?.name === 'string' ? descriptor.file.name : '',
  sizeText: formatBytes(descriptor.file?.size ?? 0),
  previewUrl: descriptor.kind === 'image' ? descriptor.previewUrl : undefined,
})

// A hold is ready when its earliest time has passed and, when it waits for
// completion, nothing is running any more.
export const evaluateHold = (record, signals, now) => {
  const waitingOn = []
  let remainingMs = null

  // The remaining time is reported even once the instant has passed, so a caller
  // can tell "no time axis" from "the time has come".
  if (record.at !== null) {
    remainingMs = Math.max(0, record.at - now)
    if (remainingMs > 0) waitingOn.push('time')
  }

  if (record.behavior === 'wait') {
    for (const reason of busyReasons(signals)) waitingOn.push(reason)
  }

  return { ready: waitingOn.length === 0, waitingOn, remainingMs }
}
