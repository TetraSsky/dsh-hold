import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGate } from '../src/gate.js'
import { createQueue } from '../src/queue.js'

const idle = (overrides = {}) => ({
  agent: 'idle',
  subagents: { running: 0, ids: [] },
  jobs: { running: 0, ids: [] },
  ...overrides,
})

// The default tree is deliberately busy: a waiting hold against a complete tree
// is delivered on admission, which would empty the queue mid-test.
const harness = ({ signals = () => idle({ agent: 'running' }) } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hold-gate-'))
  const queue = createQueue({ filePath: join(dir, 'queue.json') })
  const clock = { value: 1_000_000 }
  const calls = []
  const reports = []

  const agent = {
    id: 'session-1',
    get status() {
      return signals().agent === 'running' ? 'running' : 'idle'
    },
    steer: () => calls.push('steer'),
    followup: (message) => calls.push({ kind: 'followup', message }),
  }

  const services = { agents: { get: (id) => (id === 'session-1' ? agent : undefined) } }

  const gate = createGate({
    ctx: { get: (name) => services[name] },
    world: { sample: () => signals() },
    queue,
    report: (tag, value) => reports.push([tag, value]),
    now: () => clock.value,
    tickMs: 60_000,
  })

  return {
    gate,
    queue,
    agent,
    calls,
    reports,
    clock,
    services,
    admit: (overrides = {}) =>
      gate.admit('session-1', { text: 'carry on', at: null, behavior: 'wait', ...overrides }),
    cleanup: () => {
      gate.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('admitting stores the message and arms the gate', async () => {
  const h = harness()
  try {
    const record = await h.admit()
    assert.ok(record.id)
    assert.equal(record.behavior, 'wait')
    assert.equal(record.at, null)
    assert.equal(h.gate.pending, 1)
    assert.equal(h.queue.size, 1)
    assert.ok(h.reports.some(([tag]) => tag === 'holding message'))
  } finally {
    h.cleanup()
  }
})

test('wait holds go out one at a time, oldest first', async () => {
  let busy = true
  const h = harness({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  try {
    await h.admit({ text: 'first' })
    await h.admit({ text: 'second' })
    assert.deepEqual(h.calls, [], 'both wait while the session runs')

    busy = false
    await h.gate.tick()
    assert.equal(h.calls.length, 1, 'one per completion, not a burst')
    assert.equal(h.calls[0].message.content[0].text, 'first', 'oldest first')
    assert.equal(h.gate.pending, 1)

    busy = true
    await h.gate.tick()
    assert.equal(h.calls.length, 1, 'the next one waits for the next completion')

    busy = false
    await h.gate.tick()
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].message.content[0].text, 'second')
    assert.equal(h.gate.pending, 0)
  } finally {
    h.cleanup()
  }
})

test('two holds for the same instant go out the same way', async () => {
  let busy = true
  const h = harness({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  try {
    await h.admit({ text: 'first', at: 2_000_000 })
    await h.admit({ text: 'second', at: 2_000_000 })

    busy = false
    h.clock.value = 2_000_001
    await h.gate.tick()
    assert.equal(h.calls.length, 1, 'the time axis does not batch them')
    assert.equal(h.calls[0].message.content[0].text, 'first')
    assert.equal(h.gate.pending, 1)
  } finally {
    h.cleanup()
  }
})

test('a queue hold is not held back by the wait hold that went out first', async () => {
  const h = harness({ signals: () => idle() })
  try {
    // Restored rather than admitted, so all three are pending inside one pass.
    h.queue.add({ sessionId: 'session-1', text: 'waiter', at: null, behavior: 'wait', createdAt: 1 })
    h.queue.add({ sessionId: 'session-1', text: 'second waiter', at: null, behavior: 'wait', createdAt: 2 })
    h.queue.add({ sessionId: 'session-1', text: 'queued', at: null, behavior: 'queue', createdAt: 3 })
    h.gate.restore()

    await h.gate.tick()
    assert.deepEqual(
      h.calls.map((call) => call.message.content[0].text),
      ['waiter', 'queued'],
      'the queue hold does not wait behind the second waiter',
    )
    assert.equal(h.gate.pending, 1)
  } finally {
    h.cleanup()
  }
})

test('a waiting hold is released once the tree is complete', async () => {
  let busy = true
  const h = harness({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  try {
    await h.admit()
    assert.deepEqual(h.calls, [], 'still running')
    assert.equal(h.gate.pending, 1)

    busy = false
    await h.gate.tick()
    assert.equal(h.gate.pending, 0)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].message.content[0].text, 'carry on')
  } finally {
    h.cleanup()
  }
})

test('a subagent or a job keeps a waiting hold held', async () => {
  for (const busy of [{ subagents: { running: 1, ids: ['child'] } }, { jobs: { running: 1, ids: ['bash-1'] } }]) {
    const h = harness({ signals: () => idle(busy) })
    try {
      await h.admit()
      assert.deepEqual(h.calls, [], `held by ${Object.keys(busy)[0]}`)
      assert.equal(h.gate.pending, 1)
    } finally {
      h.cleanup()
    }
  }
})

test('a queue hold is delivered on admission even while everything is running', async () => {
  const h = harness({ signals: () => idle({ agent: 'running', jobs: { running: 1, ids: ['b'] } }) })
  try {
    await h.admit({ behavior: 'queue' })
    assert.equal(h.gate.pending, 0, 'queue does not wait for completion')
    assert.equal(h.calls.length, 1)
  } finally {
    h.cleanup()
  }
})

test('a steer hold against a running agent steers on admission', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    await h.admit({ behavior: 'steer' })
    assert.deepEqual(h.calls, ['steer'])
  } finally {
    h.cleanup()
  }
})

test('a timed hold waits for its instant and then fires', async () => {
  const h = harness()
  try {
    await h.admit({ at: h.clock.value + 60_000, behavior: 'queue' })
    assert.deepEqual(h.calls, [], 'not yet due')
    assert.equal(h.gate.pending, 1)

    h.clock.value += 60_000
    await h.gate.tick()
    assert.equal(h.gate.pending, 0)
    assert.equal(h.calls.length, 1)
  } finally {
    h.cleanup()
  }
})

test('a timed hold with the waiting behaviour needs both axes', async () => {
  let busy = true
  const h = harness({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  try {
    await h.admit({ at: h.clock.value + 60_000, behavior: 'wait' })

    h.clock.value += 60_000
    await h.gate.tick()
    assert.deepEqual(h.calls, [], 'the time arrived but the work is still going')
    assert.equal(h.gate.pending, 1)

    busy = false
    await h.gate.tick()
    assert.equal(h.gate.pending, 0)
  } finally {
    h.cleanup()
  }
})

test('a closed session keeps a due hold instead of dropping it', async () => {
  const h = harness({ signals: () => idle() })
  try {
    // A queue hold whose time has come. The waiting behaviour would never reach
    // delivery here: an absent agent is itself a reason to keep waiting.
    await h.admit({ behavior: 'queue', at: h.clock.value + 1000 })

    h.services.agents.get = () => undefined
    h.clock.value += 1000
    await h.gate.tick()

    assert.deepEqual(h.calls, [])
    assert.equal(h.gate.pending, 1, 'the message must survive until the session returns')
    assert.ok(h.reports.some(([tag]) => tag === 'hold waiting for a live session'))

    h.services.agents.get = (id) => (id === 'session-1' ? h.agent : undefined)
    await h.gate.tick()
    assert.equal(h.gate.pending, 0)
    assert.equal(h.calls.length, 1)
  } finally {
    h.cleanup()
  }
})

test('a waiting hold against a closed session is kept by the verdict, not by delivery', async () => {
  // The gate harness stubs the sampler, so the closed session is expressed in
  // the signals rather than through the agent registry.
  let closed = false
  const h = harness({ signals: () => idle(closed ? { agent: 'absent' } : { agent: 'running' }) })
  try {
    await h.admit()
    assert.equal(h.gate.pending, 1)

    closed = true
    await h.gate.tick()

    assert.deepEqual(h.calls, [])
    assert.equal(h.gate.pending, 1)
    assert.deepEqual(h.gate.describe('session-1')[0].waitingOn, ['agent-absent'])
  } finally {
    h.cleanup()
  }
})

test('release-now ignores what the hold was waiting for', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    const record = await h.admit({ at: h.clock.value + 3_600_000 })
    const outcome = await h.gate.release(record.id)
    assert.deepEqual(outcome, { ok: true, delivered: true, reason: 'released-by-user', mode: 'queue' })
    assert.equal(h.gate.pending, 0)
  } finally {
    h.cleanup()
  }
})

test('cancel drops the message without delivering it', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    const record = await h.admit()
    assert.deepEqual(h.gate.cancel(record.id), { ok: true })
    assert.deepEqual(h.calls, [])
    assert.equal(h.queue.size, 0)
    assert.deepEqual(h.gate.cancel(record.id), { ok: false, code: 'hold_not_found' })
    assert.deepEqual(await h.gate.release(record.id), { ok: false, code: 'hold_not_found' })
  } finally {
    h.cleanup()
  }
})

test('an edit replaces only the fields it carries and re-evaluates', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    const record = await h.admit({ text: 'first' })
    assert.deepEqual(h.calls, [])

    const edited = await h.gate.update(record.id, { text: 'second' })
    assert.equal(edited.ok, true)
    assert.equal(edited.record.text, 'second')
    assert.equal(edited.record.behavior, 'wait', 'the behaviour is untouched')

    // Switching to steer makes it deliverable at once.
    const steered = await h.gate.update(record.id, { behavior: 'steer' })
    assert.equal(steered.ok, true)
    assert.deepEqual(h.calls, ['steer'])
    assert.equal(h.gate.pending, 0)
  } finally {
    h.cleanup()
  }
})

test('editing an unknown id reports not found', async () => {
  const h = harness()
  try {
    assert.deepEqual(await h.gate.update('nope', { text: 'x' }), { ok: false, code: 'hold_not_found' })
  } finally {
    h.cleanup()
  }
})

test('describe reports each hold with its verdict, filtered by session', async () => {
  const h = harness({ signals: () => idle({ agent: 'running', jobs: { running: 1, ids: ['b'] } }) })
  try {
    const record = await h.admit({ at: h.clock.value + 30_000 })
    const [described] = h.gate.describe('session-1')
    assert.equal(described.id, record.id)
    assert.deepEqual(described.waitingOn, ['time', 'agent', 'jobs'])
    assert.equal(described.remainingMs, 30_000)
    assert.equal(described.ready, false)

    assert.equal(h.gate.describe('other').length, 0)
    assert.equal(h.gate.describe().length, 1)
  } finally {
    h.cleanup()
  }
})

test('restore rebuilds the queue from the durable store after a restart', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    await h.admit({ text: 'persisted' })
    await h.admit({ text: 'second' })

    const revived = createGate({
      ctx: { get: (name) => h.services[name] },
      world: { sample: () => idle({ agent: 'running' }) },
      queue: h.queue,
      now: () => h.clock.value,
      tickMs: 60_000,
    })

    assert.equal(revived.pending, 0)
    assert.equal(revived.restore(), 2)
    assert.equal(revived.pending, 2)
    revived.dispose()
  } finally {
    h.cleanup()
  }
})

test('a disposed gate stops acting and leaves the durable records alone', async () => {
  const h = harness({ signals: () => idle({ agent: 'running' }) })
  try {
    await h.admit()
    h.gate.dispose()
    assert.equal(h.gate.pending, 0)
    assert.equal(h.gate.disposed, true)

    await h.gate.tick()
    assert.deepEqual(h.calls, [])
    assert.equal(h.queue.size, 1, 'disposal is not cancellation')
  } finally {
    h.cleanup()
  }
})

test('a sample that throws does not lose the hold', async () => {
  let explode = true
  const h = harness({
    signals: () => {
      if (explode) throw new Error('registry read failed')
      return idle()
    },
  })
  try {
    await h.admit()
    await h.gate.tick()
    assert.equal(h.gate.pending, 1)
    assert.ok(h.reports.some(([tag]) => tag === 'hold evaluation failed'))

    explode = false
    await h.gate.tick()
    assert.equal(h.gate.pending, 0)
  } finally {
    h.cleanup()
  }
})
