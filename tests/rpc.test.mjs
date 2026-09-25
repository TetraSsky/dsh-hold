import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNEL, installRpcChannel } from '../src/rpc.js'

const makeRequest = ({ method = 'POST', url = `${CHANNEL}/list`, body = '' } = {}) => {
  const listeners = new Map()
  const req = {
    method,
    url,
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== '') listeners.get('data')?.(body)
    listeners.get('end')?.()
  })
  return req
}

const makeResponse = () => {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(payload) {
      state.body = payload
    },
  }
}

const envelope = (method, payload = null, rpcId = 'rpc-1') =>
  JSON.stringify({ type: 'client-request', rpcId, method, payload })

const install = ({ handlers = { list: () => ({ items: [] }) }, connection, webServer } = {}) => {
  const registered = []
  const server = webServer ?? {
    register(route) {
      registered.push(route)
      return () => registered.splice(registered.indexOf(route), 1)
    },
  }
  const reports = []
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return server
      if (name === 'connection') return connection
      return undefined
    },
    effect: (fn) => fn(),
  }

  const disposer = installRpcChannel({ ctx, handlers, report: (tag, value) => reports.push([tag, value]) })
  return { disposer, registered, reports, serve: registered[0]?.handler }
}

const invoke = async (serve, options) => {
  const res = makeResponse()
  await serve(makeRequest(options), res)
  return { status: res.state.status, body: res.state.body }
}

test('the route is registered as a prefix on the plugin channel', () => {
  const { registered, reports } = install()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, CHANNEL)
  assert.ok(reports.some(([tag]) => tag === 'rpc route registered'))
})

test('a valid request reaches its handler', async () => {
  const { serve } = install({ handlers: { list: (payload) => ({ echo: payload }) } })
  const result = await invoke(serve, { body: envelope('list', { sessionId: 's1' }) })
  assert.equal(result.status, 200)
  const parsed = JSON.parse(result.body)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.rpcId, 'rpc-1')
  assert.deepEqual(parsed.result, { ok: true, value: { echo: { sessionId: 's1' } } })
})

test('a complete envelope from a handler passes through unwrapped', async () => {
  // This is what lets a specific error code reach the browser instead of being
  // buried inside a successful value.
  const { serve } = install({
    handlers: { create: () => ({ ok: false, error: { code: 'invalid_text', message: 'nope' } }) },
  })
  const parsed = JSON.parse((await invoke(serve, { url: `${CHANNEL}/create`, body: envelope('create', {}) })).body)
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.error.code, 'invalid_text')
})

test('a throwing handler is contained into a stable failure', async () => {
  const { serve } = install({
    handlers: {
      list: () => {
        throw new Error('boom')
      },
    },
  })
  const parsed = JSON.parse((await invoke(serve, { body: envelope('list') })).body)
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.error.code, 'internal')
  assert.equal(parsed.result.error.message, 'boom')
})

test('a non-POST request, a foreign path, and a deep path are not routed', async () => {
  const { serve } = install()
  assert.equal((await invoke(serve, { method: 'GET' })).status, 404)
  assert.equal((await invoke(serve, { url: '/elsewhere/list' })).status, 404)
  assert.equal((await invoke(serve, { url: `${CHANNEL}/a/b` })).status, 404)
})

test('a body that is not JSON, or an invalid envelope, is refused', async () => {
  const { serve } = install()
  assert.equal((await invoke(serve, { body: '{ not json' })).body, 'body is not JSON')

  for (const body of ['{}', '{"type":"other","rpcId":"x","method":"list"}']) {
    assert.equal((await invoke(serve, { body })).body, 'invalid envelope')
  }
})

test('a method that disagrees with the endpoint is reported, not routed', async () => {
  const { serve } = install()
  const parsed = JSON.parse((await invoke(serve, { url: `${CHANNEL}/list`, body: envelope('cancel') })).body)
  assert.equal(parsed.result.error.code, 'bad-request')
})

test('an endpoint with no handler reports not-found', async () => {
  const { serve } = install({ handlers: {} })
  const parsed = JSON.parse((await invoke(serve, { url: `${CHANNEL}/list`, body: envelope('list') })).body)
  assert.equal(parsed.result.error.code, 'not-found')
})

test('Connection\'s fence is applied per request when it is present', async () => {
  assert.equal((await invoke(install({ connection: { requestRejection: () => 401 } }).serve, { body: envelope('list') })).status, 401)
  assert.equal((await invoke(install({ connection: { requestRejection: () => 403 } }).serve, { body: envelope('list') })).status, 403)
  assert.equal((await invoke(install({ connection: { requestRejection: () => undefined } }).serve, { body: envelope('list') })).status, 200)
})

test('a missing web server or a failing registration yields no route, not a throw', () => {
  const missing = []
  assert.equal(
    installRpcChannel({
      ctx: { get: () => undefined, effect: (fn) => fn() },
      handlers: {},
      report: (tag, value) => missing.push([tag, value]),
    }),
    null,
  )
  assert.ok(missing.some(([tag]) => tag === 'rpc route unavailable'))

  const failing = []
  assert.equal(
    installRpcChannel({
      ctx: {
        get: () => ({
          register: () => {
            throw new Error('duplicate route')
          },
        }),
        effect: (fn) => fn(),
      },
      handlers: {},
      report: (tag, value) => failing.push([tag, value]),
    }),
    null,
  )
  assert.ok(failing.some(([tag]) => tag === 'rpc route registration failed'))
})

test('the channel is routable and avoids the reserved prefix', () => {
  assert.equal(CHANNEL, '/dsh-hold')
  assert.equal(CHANNEL.startsWith('/api'), false)
})
