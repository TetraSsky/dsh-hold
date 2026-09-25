import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dayButton,
  fakeConversation,
  findAll,
  find,
  mountWindow,
  monthStep,
  openCalendar,
  pickFromDropdown,
  render,
  sessionProps,
  setupClient,
  stagedFile,
  stagedImage,
  submitButton,
  texts,
} from './harness.mjs'

const { apply } = await import('../index.js')
const { CHANNEL } = await import('../src/rpc.js')

const HOMES = []
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hold-e2e-'))
  HOMES.push(dir)
  return dir
}

const idle = (overrides = {}) => ({
  agent: 'idle',
  subagents: { running: 0, ids: [] },
  jobs: { running: 0, ids: [] },
  ...overrides,
})

// The host half, composed the way the profile composes it.
const composeHost = ({ signals = idle, dir = home() } = {}) => {
  process.env.DSH_HOME = dir

  const routes = []
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

  // The two services a hold with attachments needs: the upload registry that
  // turns a receipt into a durable reference, and the attachment store that
  // admits an image at delivery.
  const staged = { 'r-2': { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } }
  const admitted = []

  const services = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
    connection: { requestRejection: () => undefined },
    fileUploads: { resolve: (target, receiptId) => staged[receiptId] },
    attachments: {
      async admitPromptContent(content) {
        admitted.push(content)
        return content.map((part) =>
          part.type === 'image' ? { type: 'image', attachment: { attachmentId: 'img-1' } } : part,
        )
      },
    },
    agents: { get: (id) => (id === 'session-1' && signals().agent !== 'absent' ? agent : undefined) },
    jobs: { list: () => (signals().jobs?.running > 0 ? [{ id: 'bash-1', status: 'running' }] : []) },
  }

  const ctx = {
    get: (name) => services[name],
    effect: (fn) => fn(),
    inject: (names, callback) => {
      const sub = { get: ctx.get, effect: ctx.effect }
      for (const name of names) sub[name] = services[name]
      return callback(sub)
    },
  }

  apply(ctx)

  return {
    agent,
    dir,
    admitted,
    route: routes.find((entry) => entry.path === CHANNEL),
    queueRecords: () => {
      const path = join(dir, 'hold-queue.json')
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).records : []
    },
  }
}

// A connection that speaks the real wire: the payload is JSON round-tripped and
// the response is unwrapped from its envelope, exactly as Connection does it.
const connectionFor = (route, log = []) => ({
  rpc: {
    async call(channel, method, payload) {
      assert.equal(channel, CHANNEL)
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method,
        payload: JSON.parse(JSON.stringify(payload ?? null)),
      })
      log.push({ method, payload: JSON.parse(body).payload })

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
      queueMicrotask(() => {
        listeners.get('data')?.(body)
        listeners.get('end')?.()
      })

      const state = {}
      const res = {
        writeHead: (status) => {
          state.status = status
        },
        end: (text) => {
          state.body = text
        },
      }
      await route.handler(req, res)
      return JSON.parse(state.body).result
    },
  },
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

// The gate delivers on its own one-second tick, so a test that depends on it
// has to wait rather than assume.
const waitFor = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

const textIncludes = (tree, needle) => texts(tree).some((text) => text.includes(needle))

const mountClient = (React, entry, props) => {
  const composer = find(
    render(React, entry('conversation.input.right').component, props),
    (node) => node.props?.['data-primitive'] === 'button',
  )
  composer.props.onClick()
  return entry('conversation.input.dock').component
}

test('an attachment travels the whole way: composer, host record, and delivery', async () => {
  let busy = true
  const host = composeHost({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  const conversation = fakeConversation({
    descriptors: [stagedImage(), stagedFile()],
    serialized: [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { type: 'file', receiptId: 'r-2' },
    ],
    uploads: { 'draft-1': { status: 'ready' }, 'draft-2': { status: 'ready', receiptId: 'r-2' } },
  })
  const client = setupClient({
    connection: connectionFor(host.route),
    conversation: conversation.service,
  })
  const props = sessionProps({
    draft: 'look at this',
    attachmentIds: ['draft-1', 'draft-2'],
    inputActions: { setDraft: () => {}, removeAttachment: () => {} },
  })

  submitButton(mountWindow(client.React, client.entry, props)()).props.onClick()
  await settle()

  // The record kept the image's own bytes and the file's durable reference, not
  // the receipt, which does not outlive the draft that minted it.
  const records = host.queueRecords()
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].attachments, [
    { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
  ])

  busy = false
  assert.equal(await waitFor(() => host.agent.followed.length === 1), true)
  assert.deepEqual(host.agent.followed[0].content, [
    { type: 'text', text: 'look at this' },
    { type: 'image', attachment: { attachmentId: 'img-1' } },
    { type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
  ])
  assert.deepEqual(host.admitted, [
    [
      { type: 'text', text: 'look at this' },
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
    ],
  ])
})

test('a file whose upload is gone is refused rather than held without it', async () => {
  const host = composeHost({ signals: () => idle({ agent: 'running' }) })
  const conversation = fakeConversation({
    descriptors: [stagedFile()],
    serialized: [{ type: 'file', receiptId: 'r-gone' }],
    uploads: { 'draft-2': { status: 'ready', receiptId: 'r-gone' } },
  })
  const client = setupClient({
    connection: connectionFor(host.route),
    conversation: conversation.service,
  })
  const props = sessionProps({
    draft: 'with a file',
    attachmentIds: ['draft-2'],
    inputActions: { setDraft: () => {}, removeAttachment: () => {} },
  })
  const draw = mountWindow(client.React, client.entry, props)

  submitButton(draw()).props.onClick()
  await settle()

  assert.equal(host.queueRecords().length, 0, 'nothing is held without its file')
  assert.ok(textIncludes(draw(), 'no longer uploaded'), 'and the window says why')
})

test('composing a hold from the browser reaches the host and comes back as a row', async () => {
  const host = composeHost()
  const log = []
  const client = setupClient({ connection: connectionFor(host.route, log) })
  const props = sessionProps({ draft: 'carry on when the build is done' })
  const draw = mountWindow(client.React, client.entry, props)

  // Turn the send-at switch on, then choose a day in the next month at 09:30, so
  // the instant is unambiguously in the future.
  openCalendar(draw)
  monthStep(draw(), 'Next month').props.onClick()
  dayButton(draw(), 15).props.onClick()
  pickFromDropdown(draw, 'Hour', '09')
  pickFromDropdown(draw, 'Minute', '30')

  submitButton(draw()).props.onClick()
  await settle()

  const records = host.queueRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].text, 'carry on when the build is done')
  assert.equal(records[0].behavior, 'wait')
  assert.equal(typeof records[0].at, 'number')

  const now = new Date()
  assert.equal(records[0].at, new Date(now.getFullYear(), now.getMonth() + 1, 15, 9, 30, 0, 0).getTime())

  await settle()
  const tree = draw()
  assert.ok(texts(tree).includes('carry on when the build is done'), 'the held row must render')
  for (const action of ['Edit', 'Send now', 'Delete']) {
    assert.ok(texts(tree).includes(action), `the row must offer ${action}`)
  }

  // The payload really crossed a JSON boundary.
  const created = log.find((entry) => entry.method === 'create')
  assert.equal(typeof created.payload.at, 'number')
  assert.equal(created.payload.text, 'carry on when the build is done')
})

test('a hold waiting for the tree is released only when the tree finishes', async () => {
  let busy = true
  const host = composeHost({ signals: () => idle(busy ? { agent: 'running' } : {}) })
  const client = setupClient({ connection: connectionFor(host.route) })
  const props = sessionProps({ draft: 'after the subagent is done' })

  const dock = mountClient(client.React, client.entry, props)
  client.React.rewind()
  client.React.rewind()
  const draw = () => {
    client.React.rewind()
    const element = dock(props)
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
  draw()

  const submit = findAll(draw(), (node) => node.props?.['data-primitive'] === 'button').find((node) =>
    texts(node).includes('Hold'),
  )
  submit.props.onClick()
  await settle()

  assert.equal(host.queueRecords().length, 1, 'the hold is stored')
  assert.equal(host.agent.followed.length, 0, 'and nothing is delivered while the agent runs')

  busy = false
  assert.equal(await waitFor(() => host.agent.followed.length === 1), true, 'the hold must be released on completion')
  assert.equal(host.agent.followed[0].content[0].text, 'after the subagent is done')
  assert.deepEqual(host.agent.followed[0].source, { kind: 'user' })
})

test('a background job keeps a waiting hold held across both halves', async () => {
  let jobs = 1
  const host = composeHost({
    signals: () => idle(jobs > 0 ? { jobs: { running: jobs, ids: ['bash-1'] } } : {}),
  })
  const client = setupClient({ connection: connectionFor(host.route) })
  const props = sessionProps({ draft: 'when the job is done' })

  const dock = mountClient(client.React, client.entry, props)
  const draw = () => {
    client.React.rewind()
    const element = dock(props)
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
  draw()

  findAll(draw(), (node) => node.props?.['data-primitive'] === 'button')
    .find((node) => texts(node).includes('Hold'))
    .props.onClick()
  await settle()

  assert.equal(host.agent.followed.length, 0)
  await settle()
  assert.ok(textIncludes(draw(), 'a background job'), 'the row must name what it waits on')

  jobs = 0
  assert.equal(await waitFor(() => host.agent.followed.length === 1), true)
})

test('Send now on a row delivers immediately and empties the list', async () => {
  const host = composeHost({ signals: () => idle({ agent: 'running' }) })
  const client = setupClient({ connection: connectionFor(host.route) })
  const props = sessionProps({ draft: 'send me now' })

  const dock = mountClient(client.React, client.entry, props)
  const draw = () => {
    client.React.rewind()
    const element = dock(props)
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
  draw()

  findAll(draw(), (node) => node.props?.['data-primitive'] === 'button')
    .find((node) => texts(node).includes('Hold'))
    .props.onClick()
  await settle()
  assert.equal(host.queueRecords().length, 1)

  findAll(draw(), (node) => node.props?.['data-primitive'] === 'button')
    .find((node) => texts(node).includes('Send now'))
    .props.onClick()
  await settle()

  assert.equal(host.agent.followed.length, 1)
  assert.equal(host.queueRecords().length, 0)
})

test('Delete on a row removes it without sending', async () => {
  const host = composeHost({ signals: () => idle({ agent: 'running' }) })
  const client = setupClient({ connection: connectionFor(host.route) })
  const props = sessionProps({ draft: 'never mind' })

  const dock = mountClient(client.React, client.entry, props)
  const draw = () => {
    client.React.rewind()
    const element = dock(props)
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
  draw()

  findAll(draw(), (node) => node.props?.['data-primitive'] === 'button')
    .find((node) => texts(node).includes('Hold'))
    .props.onClick()
  await settle()

  findAll(draw(), (node) => node.props?.['data-primitive'] === 'button')
    .find((node) => texts(node).includes('Delete'))
    .props.onClick()
  await settle()

  assert.equal(host.agent.followed.length, 0)
  assert.equal(host.queueRecords().length, 0)
})

test('a past instant is refused by the browser before it reaches the host', async () => {
  const host = composeHost()
  const log = []
  const client = setupClient({ connection: connectionFor(host.route, log) })
  const props = sessionProps({ draft: 'too late' })
  const draw = mountWindow(client.React, client.entry, props)

  // Today at the current hour and minute: always at or behind the clock.
  const today = new Date()
  openCalendar(draw)
  dayButton(draw(), today.getDate()).props.onClick()
  pickFromDropdown(draw, 'Hour', String(today.getHours()).padStart(2, '0'))
  pickFromDropdown(draw, 'Minute', String(today.getMinutes()).padStart(2, '0'))

  submitButton(draw()).props.onClick()
  await settle()

  assert.equal(log.some((entry) => entry.method === 'create'), false, 'the request must never be sent')
  assert.ok(textIncludes(draw(), 'That time has already passed.'))
  assert.equal(host.agent.followed.length, 0)
})

test.after(() => {
  for (const dir of HOMES) rmSync(dir, { recursive: true, force: true })
})
