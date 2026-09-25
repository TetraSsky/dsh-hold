import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld } from '../src/world.js'

const makeRegistry = ({ agents = [], owned = {} } = {}) => ({
  get: (id) => agents.find((agent) => agent.id === id),
  list: () => agents,
  isOwnedBy: (id, owner) => (owned[owner.id] ?? []).includes(id),
})

const makeWorld = (services) => {
  const reports = []
  const world = createWorld({
    ctx: { get: (name) => services[name] },
    report: (tag, value) => reports.push([tag, value]),
  })
  return { world, reports }
}

test('a session with no live agent samples as absent', () => {
  const { world } = makeWorld({ agents: makeRegistry() })
  const signals = world.sample('gone')
  assert.equal(signals.agent, 'absent')
  assert.equal(signals.subagents.running, 0)
  assert.equal(signals.jobs.running, 0)
})

test('the sample is synchronous, so the gate needs no await', () => {
  const { world } = makeWorld({ agents: makeRegistry({ agents: [{ id: 'root', status: 'idle' }] }) })
  const signals = world.sample('root')
  assert.equal(typeof signals.then, 'undefined')
})

test('an idle agent with nothing behind it samples clean', () => {
  const { world } = makeWorld({
    agents: makeRegistry({ agents: [{ id: 'root', status: 'idle' }] }),
    jobs: { list: () => [] },
  })
  assert.deepEqual(world.sample('root'), {
    agent: 'idle',
    subagents: { running: 0, ids: [] },
    jobs: { running: 0, ids: [] },
  })
})

test('a running agent is reported as running', () => {
  const { world } = makeWorld({ agents: makeRegistry({ agents: [{ id: 'root', status: 'running' }] }) })
  assert.equal(world.sample('root').agent, 'running')
})

test('only running subagents of this session are counted', () => {
  const { world } = makeWorld({
    agents: makeRegistry({
      agents: [
        { id: 'root', status: 'idle' },
        { id: 'busy', status: 'running' },
        { id: 'settled', status: 'idle' },
      ],
      owned: { root: ['busy', 'settled'] },
    }),
  })

  const signals = world.sample('root')
  assert.deepEqual(signals.subagents.ids, ['busy'])
  assert.equal(signals.subagents.running, 1)
})

test('another session\'s work is not this session\'s work', () => {
  const { world } = makeWorld({
    agents: makeRegistry({
      agents: [
        { id: 'root', status: 'idle' },
        { id: 'stranger', status: 'running' },
        { id: 'other', status: 'running' },
      ],
      owned: { other: ['stranger'] },
    }),
  })

  assert.equal(world.sample('root').subagents.running, 0)
})

test('a grandchild is reached through the ownership chain', () => {
  const { world } = makeWorld({
    agents: makeRegistry({
      agents: [
        { id: 'root', status: 'idle' },
        { id: 'child', status: 'idle' },
        { id: 'grandchild', status: 'running' },
      ],
      owned: { root: ['child'], child: ['grandchild'] },
    }),
  })

  assert.deepEqual(world.sample('root').subagents.ids, ['grandchild'])
})

test('live jobs are counted and terminal ones are not', () => {
  const { world } = makeWorld({
    agents: makeRegistry({ agents: [{ id: 'root', status: 'idle' }] }),
    jobs: {
      list: () => [
        { id: 'bash-1', status: 'running' },
        { id: 'bash-2', status: 'stopping' },
        { id: 'bash-3', status: 'completed' },
        { id: 'bash-4', status: 'killed' },
        { id: 'bash-5', status: 'failed' },
      ],
    },
  })

  assert.deepEqual(world.sample('root').jobs.ids, ['bash-1', 'bash-2'])
})

test('a throwing job listing is contained and reported', () => {
  const { world, reports } = makeWorld({
    agents: makeRegistry({ agents: [{ id: 'root', status: 'idle' }] }),
    jobs: {
      list: () => {
        throw new Error('registry disposed')
      },
    },
  })

  assert.equal(world.sample('root').jobs.running, 0)
  assert.ok(reports.some(([tag]) => tag === 'job sample failed'))
})

test('a missing ownership API degrades to no subagents rather than throwing', () => {
  const { world } = makeWorld({
    agents: { get: (id) => (id === 'root' ? { id: 'root', status: 'idle' } : undefined) },
  })
  assert.equal(world.sample('root').subagents.running, 0)
})

test('a throwing ownership test does not take the sample down', () => {
  const { world } = makeWorld({
    agents: {
      get: (id) => ({ id, status: 'running' }),
      list: () => [{ id: 'root', status: 'idle' }, { id: 'child', status: 'running' }],
      isOwnedBy: () => {
        throw new Error('not the live instance')
      },
    },
  })
  assert.equal(world.sample('root').subagents.running, 0)
})

test('a missing service is absence of capability, not an error', () => {
  const { world } = makeWorld({ agents: makeRegistry({ agents: [{ id: 'root', status: 'idle' }] }) })
  assert.equal(world.sample('root').jobs.running, 0)
})

test('a context whose get throws samples as absent', () => {
  const world = createWorld({
    ctx: {
      get: () => {
        throw new Error('service unavailable')
      },
    },
  })
  assert.equal(world.sample('root').agent, 'absent')
})
