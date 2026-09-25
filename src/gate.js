import { buildHeldMessage, deliverHeld } from './deliver.js'
import { evaluateHold } from './hold.js'

// The resolution of the earliest-time axis, and the retry cadence for a session
// that is closed when its hold comes due.
export const TICK_MS = 1000

export const createGate = ({ ctx, world, queue, report = () => {}, now = Date.now, tickMs = TICK_MS } = {}) => {
  const entries = new Map()
  let timer = null
  let pass = null
  let disposed = false

  const service = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  const arm = () => {
    if (disposed || timer !== null || entries.size === 0) return
    timer = setInterval(() => {
      void tick()
    }, tickMs)
    // A hold must never be the reason the host process stays alive.
    timer.unref?.()
  }

  const disarm = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const drop = (id) => {
    entries.delete(id)
    queue.remove(id)
    if (entries.size === 0) disarm()
  }

  // A refused delivery is kept and carries its refusal, so the row can say what
  // happened and an edit or another release can retry it. The refusal is not
  // durable, so a restart simply tries again.
  const refuse = (record, code, message) => {
    const failure = { code, message }
    entries.set(record.id, { ...record, error: failure })
    report('hold delivery refused', { id: record.id, code, message })
    return { delivered: false, reason: 'refused', error: failure }
  }

  const deliver = async (record, reason) => {
    const registry = service('agents')
    const agent = typeof registry?.get === 'function' ? registry.get(record.sessionId) : undefined

    if (agent === undefined) {
      report('hold waiting for a live session', { id: record.id, sessionId: record.sessionId })
      return { delivered: false, reason: 'session-offline' }
    }

    let message
    try {
      message = await buildHeldMessage(record, { attachments: service('attachments') })
    } catch (error) {
      return refuse(record, 'delivery_failed', String((error && error.message) || error))
    }

    const outcome = deliverHeld({ agent, message, behavior: record.behavior })
    drop(record.id)
    report('released held message', {
      id: record.id,
      sessionId: record.sessionId,
      reason,
      mode: outcome.mode,
      behavior: record.behavior,
      attachments: record.attachments?.length ?? 0,
    })
    return { delivered: true, reason, mode: outcome.mode }
  }

  // An unreadable world reports as absent, which is never ready, so a hold is
  // kept rather than delivered blind.
  const sampleSafe = (sessionId) => {
    try {
      return world.sample(sessionId)
    } catch (error) {
      report('hold evaluation failed', {
        sessionId,
        message: String((error && error.message) || error),
      })
      return { agent: 'absent', subagents: { running: 0, ids: [] }, jobs: { running: 0, ids: [] } }
    }
  }

  // A waiting hold that has just been delivered puts its session back to work, so
  // the next one waits for the next completion rather than racing the delivery
  // that has not flipped the agent to running yet.
  const consider = async (record, deliveredWaiting) => {
    if (record.error !== undefined) return
    if (record.behavior === 'wait' && deliveredWaiting.has(record.sessionId)) return

    const verdict = evaluateHold(record, sampleSafe(record.sessionId), now())
    if (!verdict.ready) return

    const outcome = await deliver(record, 'condition-met')
    if (outcome.delivered === true && record.behavior === 'wait') deliveredWaiting.add(record.sessionId)
  }

  // Delivery admits attachments, so a pass is asynchronous. Holding the in-flight
  // pass means a second tick joins it instead of delivering the same record twice.
  const tick = () => {
    if (disposed) return Promise.resolve()
    if (pass !== null) return pass

    pass = (async () => {
      try {
        // In admission order, which is creation order, so holds go out oldest
        // first after a restart as well.
        const deliveredWaiting = new Set()
        for (const record of [...entries.values()]) {
          if (disposed) break
          await consider(record, deliveredWaiting)
        }
      } finally {
        pass = null
        if (entries.size === 0) disarm()
      }
    })()
    return pass
  }

  const describe = (sessionId) => {
    const at = now()
    return [...entries.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .map((record) => {
        const verdict = evaluateHold(record, sampleSafe(record.sessionId), at)
        return { ...record, waitingOn: verdict.waitingOn, remainingMs: verdict.remainingMs, ready: verdict.ready }
      })
  }

  return {
        restore() {
      for (const record of queue.all()) {
        if (!entries.has(record.id)) entries.set(record.id, record)
      }
      if (entries.size > 0) {
        arm()
        report('restored held messages', { count: entries.size })
      }
      return entries.size
    },

    admit(sessionId, request) {
      const record = queue.add({
        sessionId,
        text: request.text,
        at: request.at,
        behavior: request.behavior,
        attachments: request.attachments ?? [],
        createdAt: now(),
      })
      if (record === undefined) return undefined
      entries.set(record.id, record)
      arm()
      report('holding message', {
        id: record.id,
        sessionId,
        at: record.at,
        behavior: record.behavior,
        attachments: record.attachments.length,
      })
      // A hold that is already satisfied should not wait for the first tick.
      return tick().then(
        () =>
          describe(sessionId).find((item) => item.id === record.id) ?? {
            ...record,
            waitingOn: [],
            remainingMs: null,
            ready: true,
          },
      )
    },

    async update(id, patch) {
      const current = entries.get(id)
      if (current === undefined) return { ok: false, code: 'hold_not_found' }
      const next = queue.replace(id, patch)
      if (next === undefined) return { ok: false, code: 'hold_not_stored' }
      entries.set(id, next)
      report('updated held message', { id, fields: Object.keys(patch) })
      await tick()
      return { ok: true, record: describe(next.sessionId).find((item) => item.id === id) }
    },

    // Send now ignores what the hold was waiting for, and retries a refusal.
    async release(id) {
      const record = entries.get(id)
      if (record === undefined) return { ok: false, code: 'hold_not_found' }
      const retry = record.error === undefined ? record : { ...record, error: undefined }
      entries.set(id, retry)
      return { ok: true, ...(await deliver(retry, 'released-by-user')) }
    },

    cancel(id) {
      if (!entries.has(id)) return { ok: false, code: 'hold_not_found' }
      drop(id)
      report('cancelled held message', { id })
      return { ok: true }
    },

    describe,
    tick,
    get pending() {
      return entries.size
    },
    dispose() {
      disposed = true
      disarm()
      entries.clear()
    },
    get disposed() {
      return disposed
    },
  }
}
