import { parseHoldPatch, parseHoldRequest } from './src/hold.js'
import { createGate } from './src/gate.js'
import { createQueue } from './src/queue.js'
import { installRpcChannel } from './src/rpc.js'
import { createWorld } from './src/world.js'

export const name = 'dsh-hold'

const INJECT_CHECK_MS = 5000

// The transport's own failure shape, so a specific code survives to the browser.
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

export function apply(ctx) {
  const report = (tag, value) => {
    console.log(`[hold] ${tag}`, JSON.stringify(value))
  }

  const queue = createQueue({ report })
  queue.load()
  report('queue loaded', { records: queue.size, path: queue.path })

  const world = createWorld({ ctx, report })
  const gate = createGate({ ctx, world, queue, report })
  gate.restore()

  ctx.effect(() => () => gate.dispose())

  const sessionOf = (payload) =>
    typeof payload?.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined

  const idOf = (payload) => (typeof payload?.id === 'string' && payload.id !== '' ? payload.id : undefined)

  // A staged file travels as the receipt its upload minted, and that receipt does
  // not outlive the draft. Resolve it to the durable reference now, so the hold
  // stays deliverable long after the composer has moved on.
  const resolveAttachments = (sessionId, attachments) => {
    // An image carries its own bytes, and a file that already carries a durable
    // reference needs nothing resolved. Only a fresh receipt does.
    if (!attachments.some((attachment) => attachment.kind === 'file' && attachment.receiptId !== undefined)) {
      return { ok: true, attachments }
    }

    const agents = ctx.get('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    const uploads = ctx.get('fileUploads')

    if (agent === undefined) {
      return failure('attachments_unavailable', 'that session is not attached, so its uploads cannot be held')
    }
    if (typeof uploads?.resolve !== 'function') {
      return failure('attachments_unavailable', 'file uploads are unavailable in this host')
    }

    const resolved = []
    for (const attachment of attachments) {
      if (attachment.kind === 'image' || attachment.receiptId === undefined) {
        resolved.push(attachment)
        continue
      }

      const ref = uploads.resolve(agent, attachment.receiptId)
      if (ref === undefined) {
        return failure('attachment_not_staged', 'a staged file is no longer uploaded for this session')
      }
      resolved.push({
        kind: 'file',
        attachment: { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes },
      })
    }

    return { ok: true, attachments: resolved }
  }

  let rpcRegistered = false
  ctx.inject(['webServer'], (cctx) => {
    const disposer = installRpcChannel({
      ctx: cctx,
      report,
      handlers: {
        list: (payload) => {
          const sessionId = sessionOf(payload)
          return { ok: true, value: { now: Date.now(), items: gate.describe(sessionId) } }
        },

        create: async (payload) => {
          const sessionId = sessionOf(payload)
          if (sessionId === undefined) return failure('invalid_session', 'sessionId must be a non-empty string')

          const parsed = parseHoldRequest(payload, Date.now())
          if (!parsed.ok) return failure(parsed.code, parsed.message)

          const carried = resolveAttachments(sessionId, parsed.request.attachments)
          if (carried.ok !== true) return carried

          const record = await gate.admit(sessionId, { ...parsed.request, attachments: carried.attachments })
          if (record === undefined) return failure('internal', 'the message could not be stored')
          return { ok: true, value: record }
        },

        update: async (payload) => {
          const id = idOf(payload)
          if (id === undefined) return failure('invalid_id', 'id must be a non-empty string')

          const parsed = parseHoldPatch(payload, Date.now())
          if (!parsed.ok) return failure(parsed.code, parsed.message)

          const patch = { ...parsed.patch }
          if (patch.attachments !== undefined) {
            const current = gate.describe().find((item) => item.id === id)
            const sessionId = current?.sessionId ?? sessionOf(payload)
            if (sessionId === undefined) return failure('invalid_session', 'sessionId must be a non-empty string')

            const carried = resolveAttachments(sessionId, patch.attachments)
            if (carried.ok !== true) return carried
            patch.attachments = carried.attachments
          }

          const outcome = await gate.update(id, patch)
          if (outcome.ok !== true) return failure(outcome.code, 'that held message no longer exists')
          return { ok: true, value: outcome.record }
        },

        release: async (payload) => {
          const id = idOf(payload)
          if (id === undefined) return failure('invalid_id', 'id must be a non-empty string')

          const outcome = await gate.release(id)
          if (outcome.ok !== true) return failure(outcome.code, 'that held message no longer exists')
          return { ok: true, value: outcome }
        },

        cancel: (payload) => {
          const id = idOf(payload)
          if (id === undefined) return failure('invalid_id', 'id must be a non-empty string')

          const outcome = gate.cancel(id)
          if (outcome.ok !== true) return failure(outcome.code, 'that held message no longer exists')
          return { ok: true, value: { cancelled: true } }
        },
      },
    })
    rpcRegistered = disposer !== null
    return disposer
  })

  setTimeout(() => {
    if (!rpcRegistered) console.warn('[hold] the web server never appeared; the composer button is unavailable')
  }, INJECT_CHECK_MS)

  report('ready', { pending: gate.pending })
}
