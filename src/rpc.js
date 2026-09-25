// Connection needs a leading slash here and rejects "/api" as reserved.
export const CHANNEL = '/dsh-hold'

// Wide enough for the hold's whole attachment budget plus its text. The harness'
// own transport allows 300 MB for the same reason.
const MAX_BODY_BYTES = 64 * 1024 * 1024
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

// A handler may answer with a complete envelope of its own, which is how a
// specific error code reaches the browser. Anything else is a plain payload.
const isEnvelope = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.ok === 'boolean' &&
  ('value' in value || 'error' in value)

const normalise = (value) => (isEnvelope(value) ? value : { ok: true, value })

const send = (res, status, body, contentType) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const sendJson = (res, status, body) => send(res, status, body, 'application/json')
const sendText = (res, status, text) => send(res, status, text, 'text/plain')

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        const error = new Error('request body too large')
        error.code = 'body_too_large'
        reject(error)
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

const endpointOf = (url) => {
  const path = String(url ?? '').split('?')[0]
  if (!path.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = path.slice(CHANNEL.length + 1)
  return ENDPOINT_SEGMENT.test(endpoint) ? endpoint : undefined
}

export const installRpcChannel = ({ ctx, report = () => {}, handlers }) => {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    report('rpc route unavailable', { hasWebServer: Boolean(webServer) })
    return null
  }

  const serve = async (req, res) => {
    // Resolved per request, because Connection may activate later.
    const connection = ctx.get('connection')
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    }

    const endpoint = endpointOf(req.url)
    if (req.method !== 'POST' || endpoint === undefined) {
      sendText(res, 404, 'not found')
      return
    }

    let envelope
    try {
      envelope = JSON.parse(await readBody(req))
    } catch (error) {
      const tooLarge = error?.code === 'body_too_large'
      sendText(res, tooLarge ? 413 : 400, tooLarge ? 'body too large' : 'body is not JSON')
      return
    }

    if (
      !envelope ||
      envelope.type !== 'client-request' ||
      typeof envelope.rpcId !== 'string' ||
      typeof envelope.method !== 'string'
    ) {
      sendText(res, 400, 'invalid envelope')
      return
    }

    if (envelope.method !== endpoint) {
      sendJson(res, 200, {
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: failure(
          'bad-request',
          `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        ),
      })
      return
    }

    const handler = handlers[endpoint]
    const result =
      handler === undefined
        ? failure('not-found', `unknown endpoint: ${endpoint}`)
        : await Promise.resolve()
            .then(() => handler(envelope.payload))
            .then(normalise, (error) => failure('internal', String((error && error.message) || error)))

    sendJson(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result })
  }

  try {
    const disposer = ctx.effect(() => webServer.register({ kind: 'prefix', path: CHANNEL, handler: serve }))
    report('rpc route registered', {
      channel: CHANNEL,
      endpoints: Object.keys(handlers),
      guarded: typeof ctx.get('connection')?.requestRejection === 'function',
    })
    return disposer
  } catch (error) {
    report('rpc route registration failed', { channel: CHANNEL, message: String((error && error.message) || error) })
    return null
  }
}
