import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOMES = []
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hold-home-'))
  HOMES.push(dir)
  return dir
}

// Read at createQueue() time, so each composition gets its own queue.
process.env.DSH_HOME = home()

const { apply, name } = await import('../index.js')
const { CHANNEL } = await import('../src/rpc.js')

const idle = (overrides = {}) => ({
  agent: 'idle',
  subagents: { running: 0, ids: [] },
  jobs: { running: 0, ids: [] },
  ...overrides,
})

// A cordis-shaped host. The fake services are derived from the signals thunk
// rather than stubbing the sampler, so the real world reduction is exercised.
const compose = ({ signals = idle, dir = home(), services: extra = {} } = {}) => {
  process.env.DSH_HOME = dir

  const effects = []
  const routes = []
  const reports = []

  const agent = {
    id: 'session-1',
    get status() {
      return signals().agent === 'running' ? 'running' : 'idle'
    },
    steered: [],
    followed: [],
    steer(message) {
      this.steered.push(message)
    },
    followup(message) {
      this.followed.push(message)
    },
  }

  const children = () => (signals().subagents?.running > 0 ? [{ id: 'child-1', status: 'running' }] : [])

  const services = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
    connection: { requestRejection: () => undefined },
    agents: {
      get: (id) => {
        if (signals().agent === 'absent') return undefined
        if (id === 'session-1') return agent
        return children().find((child) => child.id === id)
      },
      list: () => (signals().agent === 'absent' ? [] : [agent, ...children()]),
      isOwnedBy: (id, owner) => owner.id === 'session-1' && children().some((child) => child.id === id),
    },
    jobs: { list: () => (signals().jobs?.running > 0 ? [{ id: 'bash-1', status: 'running' }] : []) },
    ...extra,
  }

  const ctx = {
    get: (serviceName) => services[serviceName],
    effect: (fn) => {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    inject: (names, callback) => {
      const sub = { get: ctx.get, effect: ctx.effect }
      for (const serviceName of names) sub[serviceName] = services[serviceName]
      return callback(sub)
    },
  }

  apply(ctx)
  return { services, effects, routes, reports, agent, dir }
}

const rpc = async (routes, method, payload) => {
  const route = routes.find((entry) => entry.path === CHANNEL)
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: `${CHANNEL}/${method}`,
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    destroy() {},
  }
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload })
  queueMicrotask(() => {
    listeners.get('data')?.(body)
    listeners.get('end')?.()
  })
  const state = {}
  const res = {
    writeHead: (status) => {
      state.status = status
    },
    end: (payloadText) => {
      state.body = payloadText
    },
  }
  await route.handler(req, res)
  return JSON.parse(state.body).result
}

const codeOf = (result) => (result.ok === false ? result.error?.code : undefined)

test('the plugin announces its name', () => {
  assert.equal(name, 'dsh-hold')
})

test('the host installs the RPC route and nothing else', () => {
  const c = compose()
  assert.equal(c.routes.length, 1)
  assert.equal(c.routes[0].kind, 'prefix')
  assert.equal(c.routes[0].path, CHANNEL)
})

test('a hold is admitted and lands in the durable queue', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const result = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'later', behavior: 'wait' })

  assert.equal(result.ok, true)
  assert.ok(result.value.id)
  assert.equal(result.value.behavior, 'wait')
  assert.deepEqual(result.value.waitingOn, ['agent'])

  const onDisk = JSON.parse(readFileSync(join(c.dir, 'hold-queue.json'), 'utf8'))
  assert.equal(onDisk.records.length, 1)
  assert.equal(onDisk.records[0].text, 'later')
})

test('a missing session id is refused', async () => {
  const c = compose()
  assert.equal(codeOf(await rpc(c.routes, 'create', { text: 'a' })), 'invalid_session')
})

test('a file receipt is resolved to a durable reference when the hold is made', async () => {
  const c = compose({
    signals: () => idle({ agent: 'running' }),
    services: {
      fileUploads: {
        resolve: (agent, receiptId) =>
          receiptId === 'r-1' ? { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } : undefined,
      },
    },
  })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'with a file',
    attachments: [{ kind: 'file', receiptId: 'r-1' }],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.attachments, [
    { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
  ])
})

test('an image is held as its own bytes, with no service needed to store it', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'look',
    attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.attachments, [
    { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
  ])
})

test('a receipt this host cannot resolve refuses the whole hold', async () => {
  const c = compose({
    signals: () => idle({ agent: 'running' }),
    services: { fileUploads: { resolve: () => undefined } },
  })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'with a file',
    attachments: [{ kind: 'file', receiptId: 'r-gone' }],
  })

  assert.equal(codeOf(result), 'attachment_not_staged')
})

test('without the upload registry, a file is refused rather than silently dropped', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'with a file',
    attachments: [{ kind: 'file', receiptId: 'r-1' }],
  })

  assert.equal(codeOf(result), 'attachments_unavailable')
  assert.equal(existsSync(join(c.dir, 'hold-queue.json')), false, 'nothing is stored')
})

test('a detached session cannot have its uploads held', async () => {
  const c = compose({
    signals: () => idle({ agent: 'absent' }),
    services: { fileUploads: { resolve: () => ({ attachmentId: 'file-1', name: 'notes.txt', bytes: 12 }) } },
  })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'with a file',
    attachments: [{ kind: 'file', receiptId: 'r-1' }],
  })

  assert.equal(codeOf(result), 'attachments_unavailable')
})

test('an oversized or unknown attachment is refused before anything is stored', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const tooMany = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'x',
    attachments: new Array(21).fill({ kind: 'image', mediaType: 'image/png', data: 'AAAA' }),
  })
  assert.equal(codeOf(tooMany), 'too_many_attachments')

  const unknown = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'x',
    attachments: [{ kind: 'video', data: 'AAAA' }],
  })
  assert.equal(codeOf(unknown), 'invalid_attachment')
  assert.equal(existsSync(join(c.dir, 'hold-queue.json')), false)
})

test('an edit can send an already-resolved reference back', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const created = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'look',
    attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }],
  })

  const updated = await rpc(c.routes, 'update', {
    id: created.value.id,
    text: 'look again',
    attachments: [{ kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } }],
  })

  assert.equal(updated.ok, true)
  assert.deepEqual(updated.value.attachments, [
    { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
  ])
})

test('a blank message is refused with a stable code', async () => {
  const c = compose()
  assert.equal(codeOf(await rpc(c.routes, 'create', { sessionId: 'session-1', text: '   ' })), 'invalid_text')
})

test('a time in the past is refused', async () => {
  const c = compose()
  const result = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'a', at: 1 })
  assert.equal(codeOf(result), 'not_future')
})

test('the two axes are accepted together', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const result = await rpc(c.routes, 'create', {
    sessionId: 'session-1',
    text: 'later',
    at: Date.now() + 60_000,
    behavior: 'steer',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.behavior, 'steer')
  assert.ok(result.value.at > Date.now())
})

test('list reports every hold with its verdict, and filters by session', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'a' })
  await rpc(c.routes, 'create', { sessionId: 'session-2', text: 'b' })

  const all = await rpc(c.routes, 'list', {})
  assert.equal(all.value.items.length, 2)
  assert.equal(typeof all.value.now, 'number')

  const one = await rpc(c.routes, 'list', { sessionId: 'session-1' })
  assert.equal(one.value.items.length, 1)
  assert.equal(one.value.items[0].text, 'a')
})

test('a queue hold is delivered on admission, without waiting for a tick', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const result = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'go', behavior: 'queue' })

  assert.equal(result.ok, true)
  assert.equal(c.agent.followed.length, 1)
  assert.equal(c.agent.followed[0].content[0].text, 'go')
  assert.deepEqual(c.agent.followed[0].source, { kind: 'user' })
})

test('a steer hold against a running agent steers', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'go', behavior: 'steer' })
  assert.equal(c.agent.steered.length, 1)
  assert.equal(c.agent.followed.length, 0)
})

test('update edits a hold and re-evaluates it', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const created = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'first' })

  const edited = await rpc(c.routes, 'update', { id: created.value.id, text: 'second' })
  assert.equal(edited.ok, true)
  assert.equal(edited.value.text, 'second')
  assert.equal(edited.value.behavior, 'wait')

  const released = await rpc(c.routes, 'update', { id: created.value.id, behavior: 'queue' })
  assert.equal(released.ok, true)
  assert.equal(c.agent.followed.length, 1)
})

test('release delivers now and reports a missing id', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const created = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'go' })

  const released = await rpc(c.routes, 'release', { id: created.value.id })
  assert.equal(released.ok, true)
  assert.equal(released.value.delivered, true)
  assert.equal(c.agent.followed.length, 1)

  assert.equal(codeOf(await rpc(c.routes, 'release', { id: 'nope' })), 'hold_not_found')
})

test('cancel removes a hold and reports a missing id', async () => {
  const c = compose({ signals: () => idle({ agent: 'running' }) })
  const created = await rpc(c.routes, 'create', { sessionId: 'session-1', text: 'go' })

  assert.deepEqual((await rpc(c.routes, 'cancel', { id: created.value.id })).value, { cancelled: true })
  assert.equal(codeOf(await rpc(c.routes, 'cancel', { id: created.value.id })), 'hold_not_found')
})

test('a bad id is refused on update, release and cancel', async () => {
  const c = compose()
  for (const method of ['update', 'release', 'cancel']) {
    assert.equal(codeOf(await rpc(c.routes, method, {})), 'invalid_id', method)
    assert.equal(codeOf(await rpc(c.routes, method, { id: 7 })), 'invalid_id', method)
  }
})

test('the queue survives a reload', async () => {
  const dir = home()
  const first = compose({ signals: () => idle({ agent: 'running' }), dir })
  await rpc(first.routes, 'create', { sessionId: 'session-1', text: 'persisted' })

  const second = compose({ signals: () => idle({ agent: 'running' }), dir })
  const listed = await rpc(second.routes, 'list', {})
  assert.equal(listed.value.items.length, 1)
  assert.equal(listed.value.items[0].text, 'persisted')
})

test('disposal tears the plugin down without throwing', () => {
  const c = compose()
  for (const disposer of c.effects) if (typeof disposer === 'function') disposer()
  assert.ok(true)
})

test.after(() => {
  for (const dir of HOMES) rmSync(dir, { recursive: true, force: true })
})
