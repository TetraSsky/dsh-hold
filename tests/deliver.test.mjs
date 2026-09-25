import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHeldMessage, holdParts, deliverHeld } from '../src/deliver.js'

const fakeAgent = (overrides = {}) => {
  const calls = []
  return {
    calls,
    agent: {
      id: 'session-1',
      status: 'idle',
      steer: () => calls.push('steer'),
      followup: () => calls.push('followup'),
      // Present so a test would catch a maintenance claim creeping back in.
      runMaintenance: () => calls.push('maintenance'),
      ...overrides,
    },
  }
}

const held = (overrides = {}) => ({
  text: 'hello there',
  at: null,
  behavior: 'wait',
  attachments: [],
  ...overrides,
})

// The attachments service, stood in for by the one method delivery uses.
const fakeAttachments = () => {
  const admitted = []
  return {
    admitted,
    service: {
      async admitPromptContent(content) {
        admitted.push(content)
        return content.map((part) =>
          part.type === 'image' ? { type: 'image', attachment: { attachmentId: 'img-1' } } : part,
        )
      },
    },
  }
}

test('a held message is an ordinary user message', async () => {
  const message = await buildHeldMessage(held())
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello there' }])
  assert.equal(typeof message.id, 'string')
})

test('a held message with no attachments never touches the attachments service', async () => {
  const { service, admitted } = fakeAttachments()
  const message = await buildHeldMessage(held(), { attachments: service })
  assert.equal(admitted.length, 0, 'nothing to admit')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello there' }])
})

test('a held image is admitted into durable storage, not carried as bytes', async () => {
  const { service, admitted } = fakeAttachments()
  const message = await buildHeldMessage(
    held({ attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }),
    { attachments: service },
  )

  assert.equal(admitted.length, 1)
  assert.deepEqual(admitted[0], [
    { type: 'text', text: 'hello there' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ])
  assert.deepEqual(message.content, [
    { type: 'text', text: 'hello there' },
    { type: 'image', attachment: { attachmentId: 'img-1' } },
  ])
})

test('a held file is delivered as the durable reference it was resolved to', async () => {
  const { service } = fakeAttachments()
  const ref = { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 }
  const message = await buildHeldMessage(held({ attachments: [{ kind: 'file', attachment: ref }] }), {
    attachments: service,
  })
  assert.deepEqual(message.content, [
    { type: 'text', text: 'hello there' },
    { type: 'file', attachment: ref },
  ])
})

test('an image-only hold is a message with no text part', async () => {
  const { service } = fakeAttachments()
  const message = await buildHeldMessage(
    held({ text: '', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }),
    { attachments: service },
  )
  assert.equal(message.content.some((part) => part.type === 'text'), false)
})

test('an attachment without the attachments service is refused, not sent blind', async () => {
  await assert.rejects(
    () => buildHeldMessage(held({ attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] })),
    /attachments service is unavailable/,
  )
})

test('a refused admission surfaces as a rejection rather than a message', async () => {
  const attachments = { admitPromptContent: async () => { throw new Error('image refused') } }
  await assert.rejects(
    () => buildHeldMessage(held({ attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }), { attachments }),
    /image refused/,
  )
})

test('the parts of a hold are the wire shapes the harness itself uses', () => {
  const parts = holdParts(
    held({
      attachments: [
        { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
      ],
    }),
  )
  assert.deepEqual(parts, [
    { type: 'text', text: 'hello there' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    { type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
  ])
})

test('a steer hold against a running agent steers', async () => {
  const { agent, calls } = fakeAgent({ status: 'running' })
  const outcome = deliverHeld({ agent, message: await buildHeldMessage(held()), behavior: 'steer' })
  assert.deepEqual(calls, ['steer'])
  assert.deepEqual(outcome, { mode: 'steer' })
})

test('a steer hold against an idle agent queues instead', async () => {
  const { agent, calls } = fakeAgent({ status: 'idle' })
  const outcome = deliverHeld({ agent, message: await buildHeldMessage(held()), behavior: 'steer' })
  assert.deepEqual(calls, ['followup'])
  assert.deepEqual(outcome, { mode: 'queue' })
})

test('queue and wait both follow up, whatever the agent is doing', async () => {
  for (const behavior of ['queue', 'wait']) {
    for (const status of ['idle', 'running']) {
      const { agent, calls } = fakeAgent({ status })
      const outcome = deliverHeld({ agent, message: await buildHeldMessage(held()), behavior })
      assert.deepEqual(calls, ['followup'], `${behavior} against a ${status} agent`)
      assert.deepEqual(outcome, { mode: 'queue' })
    }
  }
})

test('delivery never claims a maintenance phase', async () => {
  // The harness' own prompt path calls steer/followup directly, so a released hold is
  // indistinguishable from a real send. A maintenance claim would deviate from that.
  for (const behavior of ['queue', 'wait', 'steer']) {
    const { agent, calls } = fakeAgent({ status: 'running' })
    deliverHeld({ agent, message: await buildHeldMessage(held()), behavior })
    assert.equal(calls.includes('maintenance'), false, `${behavior} must not claim maintenance`)
  }
})

test('the verb is chosen at delivery time, not before', async () => {
  const { agent, calls } = fakeAgent({ status: 'idle' })
  deliverHeld({ agent, message: await buildHeldMessage(held()), behavior: 'steer' })
  assert.deepEqual(calls, ['followup'], 'an idle agent must never be steered')
})
