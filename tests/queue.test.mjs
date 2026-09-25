import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUEUE_VERSION, createQueue } from '../src/queue.js'

const temporaryDir = () => mkdtempSync(join(tmpdir(), 'dsh-hold-queue-'))

const record = (overrides = {}) => ({
  sessionId: 'session-1',
  text: 'send this when the work is done',
  at: null,
  behavior: 'wait',
  createdAt: 1000,
  ...overrides,
})

test('a record round-trips through the file', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    const queue = createQueue({ filePath: path })
    const added = queue.add(record())
    assert.ok(added.id)
    assert.equal(queue.size, 1)

    const reopened = createQueue({ filePath: path })
    reopened.load()
    assert.equal(reopened.size, 1)
    assert.deepEqual(reopened.all()[0], added)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('both axes survive the round trip', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    const queue = createQueue({ filePath: path })
    queue.add(record({ at: 999999, behavior: 'steer' }))

    const reopened = createQueue({ filePath: path })
    reopened.load()
    assert.equal(reopened.all()[0].at, 999999)
    assert.equal(reopened.all()[0].behavior, 'steer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attachments survive the round trip in both shapes', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    const queue = createQueue({ filePath: path })
    const attachments = [
      { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
    ]
    const added = queue.add(record({ attachments }))

    const reopened = createQueue({ filePath: path })
    reopened.load()
    assert.deepEqual(reopened.all()[0].attachments, attachments)
    assert.deepEqual(added.attachments, attachments)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record with nothing but an attachment is still a message', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    const added = queue.add(
      record({ text: '', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }),
    )
    assert.ok(added, 'an image-only hold must store')
    assert.equal(added.text, '')

    assert.equal(queue.add(record({ text: '' })), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record carrying an attachment the shape cannot accept is dropped on load', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: QUEUE_VERSION,
        records: [
          { ...record(), id: 'a', attachments: [{ kind: 'image', mediaType: 'image/tiff', data: 'AAAA' }] },
          { ...record(), id: 'b', attachments: [{ kind: 'file', attachment: { attachmentId: 'f' } }] },
          { ...record(), id: 'c', attachments: 'nope' },
          { ...record(), id: 'd', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        ],
      }),
    )

    const queue = createQueue({ filePath: path })
    queue.load()
    assert.deepEqual(
      queue.all().map((item) => item.id),
      ['d'],
      'only the record the shape can accept survives',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a copy of a record cannot reach into the store through its attachments', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    queue.add(
      record({
        attachments: [
          { kind: 'image', mediaType: 'image/png', data: 'AAAA' },
          { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 } },
        ],
      }),
    )

    const handed = queue.all()[0]
    handed.attachments[0].data = 'tampered'
    handed.attachments[1].attachment.name = 'tampered'
    handed.attachments.push({ kind: 'image', mediaType: 'image/png', data: 'ZZZZ' })

    const stored = queue.all()[0]
    assert.equal(stored.attachments[0].data, 'AAAA')
    assert.equal(stored.attachments[1].attachment.name, 'notes.txt')
    assert.equal(stored.attachments.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record the shape cannot accept is refused instead of stored', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    assert.equal(queue.add(record({ text: '   ' })), undefined)
    assert.equal(queue.add(record({ sessionId: '' })), undefined)
    assert.equal(queue.add(record({ createdAt: Number.NaN })), undefined)
    assert.equal(queue.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown behaviour is normalized to waiting', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    assert.equal(queue.add(record({ behavior: 'sideways' })).behavior, 'wait')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('there is no cap: the queue keeps every record it is given', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    for (let index = 0; index < 60; index += 1) queue.add(record({ text: `message ${index}` }))
    assert.equal(queue.size, 60)
    assert.equal(queue.forSession('session-1').length, 60)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt record is dropped on load without losing its siblings', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: QUEUE_VERSION,
        records: [
          { id: 'good', sessionId: 's', text: 'keep me', at: null, behavior: 'wait', createdAt: 1 },
          { id: 'bad', sessionId: 's', text: '', createdAt: 1 },
          null,
        ],
      }),
    )

    const queue = createQueue({ filePath: path })
    queue.load()
    assert.equal(queue.size, 1)
    assert.equal(queue.all()[0].id, 'good')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a version from another shape is discarded, not guessed at', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    writeFileSync(path, JSON.stringify({ version: 99, records: [{ id: 'x' }] }))
    const queue = createQueue({ filePath: path })
    queue.load()
    assert.equal(queue.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is not an error', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'absent.json') })
    assert.deepEqual(queue.load(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed JSON is contained and reported', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    writeFileSync(path, '{ not json')
    const reports = []
    const queue = createQueue({ filePath: path, report: (tag, value) => reports.push([tag, value]) })
    queue.load()
    assert.equal(queue.size, 0)
    assert.ok(reports.some(([tag]) => tag === 'queue load failed'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace patches one record in place', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    const queue = createQueue({ filePath: path })
    const added = queue.add(record())

    const next = queue.replace(added.id, { text: 'edited', behavior: 'steer' })
    assert.equal(next.text, 'edited')
    assert.equal(next.behavior, 'steer')
    assert.equal(next.id, added.id)
    assert.equal(next.sessionId, added.sessionId, 'untouched fields survive')

    assert.equal(queue.replace('nope', { text: 'x' }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remove and selection behave, and hand back detached copies', () => {
  const dir = temporaryDir()
  try {
    const queue = createQueue({ filePath: join(dir, 'queue.json') })
    const first = queue.add(record({ sessionId: 'a' }))
    queue.add(record({ sessionId: 'b' }))
    queue.add(record({ sessionId: 'a', text: 'third' }))

    assert.equal(queue.forSession('a').length, 2)
    assert.equal(queue.all().length, 3)

    const copy = queue.all()[0]
    copy.text = 'tampered'
    assert.notEqual(queue.all()[0].text, 'tampered')

    assert.equal(queue.remove(first.id), true)
    assert.equal(queue.remove(first.id), false)
    assert.equal(queue.size, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the write is temp-and-rename with nothing left behind', () => {
  const dir = temporaryDir()
  try {
    const path = join(dir, 'queue.json')
    const queue = createQueue({ filePath: path })
    queue.add(record())

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.version, QUEUE_VERSION)
    assert.equal(parsed.records.length, 1)
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
