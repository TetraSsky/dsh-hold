import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BEHAVIORS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  attachmentBytes,
  attachmentLabel,
  base64Bytes,
  base64Chars,
  busyReasons,
  evaluateHold,
  formatBytes,
  formatWhenField,
  instantFromParts,
  isComplete,
  monthGrid,
  parseAt,
  parseAttachment,
  parseAttachments,
  parseBehavior,
  parseHoldPatch,
  parseHoldRequest,
  shiftMonth,
} from '../src/hold.js'

const signals = (overrides = {}) => ({
  agent: 'idle',
  subagents: { running: 0, ids: [] },
  jobs: { running: 0, ids: [] },
  ...overrides,
})

const record = (overrides = {}) => ({ at: null, behavior: 'wait', ...overrides })

test('the behaviour vocabulary is the three the composer offers', () => {
  assert.deepEqual(BEHAVIORS, ['queue', 'wait', 'steer'])
})

test('an unknown or missing behaviour defaults to waiting', () => {
  assert.equal(parseBehavior('queue'), 'queue')
  assert.equal(parseBehavior('steer'), 'steer')
  assert.equal(parseBehavior('wait'), 'wait')
  for (const value of ['now', '', null, undefined, 7, {}]) assert.equal(parseBehavior(value), 'wait')
})

test('no time means no earliest instant', () => {
  assert.deepEqual(parseAt(null, 1000), { ok: true, at: null })
  assert.deepEqual(parseAt(undefined, 1000), { ok: true, at: null })
})

test('a time must be a whole future instant', () => {
  assert.deepEqual(parseAt(2000, 1000), { ok: true, at: 2000 })
  for (const at of [1000, 999, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2000', true, {}]) {
    const result = parseAt(at, 1000)
    assert.equal(result.ok, false, `at=${String(at)} must be refused`)
    assert.ok(result.code === 'invalid_at' || result.code === 'not_future')
  }
})

test('a hold request needs non-empty text and carries the two axes', () => {
  const ok = parseHoldRequest({ text: 'later', at: 5000, behavior: 'queue' }, 1000)
  assert.deepEqual(ok, {
    ok: true,
    request: { text: 'later', at: 5000, behavior: 'queue', attachments: [] },
  })

  // Both axes are optional and default independently.
  assert.deepEqual(parseHoldRequest({ text: 'later' }, 1000), {
    ok: true,
    request: { text: 'later', at: null, behavior: 'wait', attachments: [] },
  })
})

test('a blank or oversized message is refused with a stable code', () => {
  assert.equal(parseHoldRequest({ text: '   ' }, 1000).code, 'invalid_text')
  assert.equal(parseHoldRequest({}, 1000).code, 'invalid_text')
  assert.equal(parseHoldRequest({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, 1000).code, 'text_too_long')
  assert.equal(parseHoldRequest({ text: 'x'.repeat(MAX_TEXT_CHARS) }, 1000).ok, true)
})

test('text is only optional while something is attached', () => {
  const image = { kind: 'image', mediaType: 'image/png', data: 'AAAA' }

  const blankWithImage = parseHoldRequest({ text: '   ', attachments: [image] }, 1000)
  assert.equal(blankWithImage.ok, true, 'an image-only hold is a message')
  assert.deepEqual(blankWithImage.request.attachments, [image])

  assert.equal(parseHoldRequest({ text: '', attachments: [] }, 1000).code, 'invalid_text')
})

test('an attachment must be a shape the harness itself uses', () => {
  assert.deepEqual(parseAttachment({ kind: 'image', mediaType: 'image/png', data: 'AAAA' }), {
    ok: true,
    attachment: { kind: 'image', mediaType: 'image/png', data: 'AAAA' },
  })
  assert.deepEqual(parseAttachment({ kind: 'file', receiptId: 'r-1', name: 'notes.txt' }), {
    ok: true,
    attachment: { kind: 'file', receiptId: 'r-1', name: 'notes.txt' },
  })

  for (const bad of [
    null,
    'image',
    {},
    { kind: 'image' },
    { kind: 'image', mediaType: 'image/tiff', data: 'AAAA' },
    { kind: 'image', mediaType: 'image/png', data: '' },
    { kind: 'file' },
    { kind: 'file', receiptId: '' },
    { kind: 'video' },
  ]) {
    assert.equal(parseAttachment(bad).ok, false, `${JSON.stringify(bad)} must be refused`)
  }
})

test('an already-resolved file reference is accepted, so an edit can send one back', () => {
  const ref = { attachmentId: 'file-1', name: 'notes.txt', bytes: 12 }
  assert.deepEqual(parseAttachment({ kind: 'file', attachment: ref }), {
    ok: true,
    attachment: { kind: 'file', attachment: ref },
  })

  for (const bad of [{}, { attachmentId: 'f' }, { attachmentId: 'f', name: 'n' }, { attachmentId: 'f', name: 'n', bytes: -1 }]) {
    assert.equal(parseAttachment({ kind: 'file', attachment: bad }).ok, false)
  }
})

test('a hold has its own attachment budget, and says so', () => {
  // Canonical base64, the way the composer hands an image over.
  const big = (bytes) => {
    const padding = (3 - (bytes % 3)) % 3
    return {
      kind: 'image',
      mediaType: 'image/png',
      data: 'A'.repeat(base64Chars(bytes) - padding) + '='.repeat(padding),
    }
  }

  assert.equal(base64Bytes(big(MAX_IMAGE_BYTES).data), MAX_IMAGE_BYTES)
  assert.equal(parseAttachments([big(MAX_IMAGE_BYTES)]).ok, true)
  assert.equal(parseAttachments([big(MAX_IMAGE_BYTES + 3)]).code, 'attachment_too_large')

  // One image may fit and the batch still may not.
  const half = Math.floor(MAX_ATTACHMENT_BYTES / 2) + 3
  assert.equal(parseAttachments([big(half)]).ok, true)
  assert.equal(parseAttachments([big(half), big(half)]).code, 'attachment_too_large')

  assert.equal(
    parseAttachments(new Array(MAX_ATTACHMENTS + 1).fill({ kind: 'image', mediaType: 'image/png', data: 'AAAA' })).code,
    'too_many_attachments',
  )
  assert.equal(parseAttachments('nope').code, 'invalid_attachment')
})

test('a row describes an attachment by name, and falls back when it has none', () => {
  assert.equal(attachmentLabel({ kind: 'image', name: 'shot.png' }), 'shot.png')
  assert.equal(attachmentLabel({ kind: 'image' }), 'image')
  assert.equal(attachmentLabel({ kind: 'file', attachment: { name: 'notes.txt' } }), 'notes.txt')
  assert.equal(attachmentLabel({ kind: 'file', name: 'fallback.txt', attachment: {} }), 'fallback.txt')
  assert.equal(attachmentLabel({ kind: 'file', attachment: {} }), 'file')
})

test('a size reads the way a file card does', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB')
  assert.equal(formatBytes(1024 * 1024 * 40), '40 MB')
  assert.equal(formatBytes(-1), '')
  assert.equal(formatBytes(Number.NaN), '')

  // A held image's size comes from its base64, not from a byte count.
  assert.equal(base64Bytes('AAAA'), 3)
  assert.equal(base64Bytes('AAA='), 2)
  assert.equal(base64Bytes('AA=='), 1)
  assert.equal(base64Bytes(''), 0)
  assert.equal(attachmentBytes({ kind: 'image', data: 'AAAA' }), 3)
  assert.equal(attachmentBytes({ kind: 'file', attachment: { bytes: 42 } }), 42)
})

test('an edit patch only replaces what it carries', () => {
  assert.deepEqual(parseHoldPatch({ text: 'new' }, 1000), { ok: true, patch: { text: 'new' } })
  assert.deepEqual(parseHoldPatch({ behavior: 'steer' }, 1000), { ok: true, patch: { behavior: 'steer' } })
  assert.deepEqual(parseHoldPatch({ at: null }, 1000), { ok: true, patch: { at: null } })
  assert.deepEqual(parseHoldPatch({}, 1000), { ok: true, patch: {} })

  // An explicit null clears the time rather than being ignored.
  assert.deepEqual(parseHoldPatch({ at: 9000 }, 1000), { ok: true, patch: { at: 9000 } })
})

test('an edit may empty the text only while something is still attached', () => {
  const image = { kind: 'image', mediaType: 'image/png', data: 'AAAA' }
  assert.equal(parseHoldPatch({ text: '' }, 1000).code, 'invalid_text')
  assert.equal(parseHoldPatch({ text: '', attachments: [image] }, 1000).ok, true)
  assert.equal(parseHoldPatch({ text: '', attachments: [] }, 1000).code, 'invalid_text')
  assert.equal(parseHoldPatch({ text: '  ', attachments: [] }, 1000).code, 'invalid_text')
})

test('an edit patch validates what it does carry', () => {
  assert.equal(parseHoldPatch({ text: '  ' }, 1000).code, 'invalid_text')
  assert.equal(parseHoldPatch({ at: 500 }, 1000).code, 'not_future')
  assert.equal(parseHoldPatch({ attachments: 'nope' }, 1000).code, 'invalid_attachment')
})

test('the tree is complete only when nothing is running', () => {
  assert.equal(isComplete(signals()), true)
  assert.equal(isComplete(signals({ agent: 'running' })), false)
  assert.equal(isComplete(signals({ subagents: { running: 1 } })), false)
  assert.equal(isComplete(signals({ jobs: { running: 2 } })), false)
})

test('an absent agent is never complete', () => {
  assert.deepEqual(busyReasons(signals({ agent: 'absent' })), ['agent-absent'])
  assert.equal(isComplete(signals({ agent: 'absent' })), false)
})

test('the reasons are reported in a stable order', () => {
  assert.deepEqual(
    busyReasons(signals({ agent: 'running', subagents: { running: 1 }, jobs: { running: 1 } })),
    ['agent', 'subagents', 'jobs'],
  )
})

test('queue releases at once, whatever is running', () => {
  const busy = signals({ agent: 'running', subagents: { running: 1 }, jobs: { running: 1 } })
  assert.deepEqual(evaluateHold(record({ behavior: 'queue' }), busy, 1000), {
    ready: true,
    waitingOn: [],
    remainingMs: null,
  })
})

test('steer releases at once too; the verb differs, not the timing', () => {
  const busy = signals({ agent: 'running' })
  assert.equal(evaluateHold(record({ behavior: 'steer' }), busy, 1000).ready, true)
})

test('wait holds while anything is running and names what', () => {
  const verdict = evaluateHold(record(), signals({ agent: 'running', jobs: { running: 1 } }), 1000)
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.waitingOn, ['agent', 'jobs'])
})

test('wait releases the moment the tree is complete', () => {
  assert.deepEqual(evaluateHold(record(), signals(), 1000), { ready: true, waitingOn: [], remainingMs: null })
})

test('wait never releases into a closed session', () => {
  const verdict = evaluateHold(record(), signals({ agent: 'absent' }), 1000)
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.waitingOn, ['agent-absent'])
})

test('a future time alone holds a queue-behaviour message', () => {
  const verdict = evaluateHold(record({ at: 5000, behavior: 'queue' }), signals(), 1000)
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.waitingOn, ['time'])
  assert.equal(verdict.remainingMs, 4000)
})

test('a future time and pending work are reported together', () => {
  const verdict = evaluateHold(record({ at: 5000 }), signals({ agent: 'running' }), 1000)
  assert.deepEqual(verdict.waitingOn, ['time', 'agent'])
  assert.equal(verdict.remainingMs, 4000)
})

test('the time axis fires even while the tree is busy, for a non-waiting hold', () => {
  const verdict = evaluateHold(record({ at: 5000, behavior: 'steer' }), signals({ agent: 'running' }), 5000)
  assert.equal(verdict.ready, true)
  assert.equal(verdict.remainingMs, 0)
})

test('a waiting hold needs both axes satisfied', () => {
  // Time reached, work still running: still held, and the time axis reads zero
  // rather than "no time axis".
  const verdict = evaluateHold(record({ at: 5000 }), signals({ agent: 'running' }), 6000)
  assert.equal(verdict.ready, false)
  assert.deepEqual(verdict.waitingOn, ['agent'])
  assert.equal(verdict.remainingMs, 0)
})

test('a hold with no time axis reports no remaining time', () => {
  assert.equal(evaluateHold(record(), signals({ agent: 'running' }), 6000).remainingMs, null)
})

test('wall-clock parts become an instant', () => {
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 2, hour: 3, minute: 4 }), new Date(2099, 0, 2, 3, 4, 0, 0).getTime())
  // Hour and minute default to midnight.
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 2 }), new Date(2099, 0, 2, 0, 0, 0, 0).getTime())
})

test('a time that does not exist is refused rather than shifted', () => {
  // 31 February would silently roll into March, which is exactly the bug a typed date field invites.
  assert.equal(instantFromParts({ year: 2099, month: 2, day: 31 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 4, day: 31 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 13, day: 1 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 0, day: 1 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 0 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 1, hour: 24 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 1, minute: 60 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 1, day: 1, hour: 1.5 }), null)
  assert.equal(instantFromParts({ year: 2099, month: 1, day: '2' }), null)
})

test('a leap day is accepted in a leap year and refused otherwise', () => {
  assert.equal(instantFromParts({ year: 2028, month: 2, day: 29 }), new Date(2028, 1, 29, 0, 0, 0, 0).getTime())
  assert.equal(instantFromParts({ year: 2027, month: 2, day: 29 }), null)
})

test('the parts and their formatted form round-trip', () => {
  const at = instantFromParts({ year: 2099, month: 11, day: 5, hour: 23, minute: 45 })
  assert.equal(formatWhenField(at), '2099-11-05 23:45')
})

test('a month lays out as whole weeks, Monday first, with padding', () => {
  const cells = monthGrid(2099, 1)
  assert.equal(cells.length % 7, 0, 'the grid must be whole weeks')

  const days = cells.filter((cell) => cell !== null)
  assert.equal(days.length, 31, 'January has 31 days')
  assert.equal(days[0], 1)
  assert.equal(days[days.length - 1], 31)

  // The first day sits at the Monday-first index of the real weekday.
  const first = new Date(2099, 0, 1)
  assert.equal(cells.indexOf(1), (first.getDay() + 6) % 7)
})

test('a month grid handles February and padded lengths', () => {
  assert.equal(monthGrid(2027, 2).filter((cell) => cell !== null).length, 28)
  assert.equal(monthGrid(2028, 2).filter((cell) => cell !== null).length, 29, 'a leap February')
  assert.equal(monthGrid(2099, 4).filter((cell) => cell !== null).length, 30)

  for (const month of [1, 2, 3, 6, 9, 12]) {
    assert.equal(monthGrid(2099, month).length % 7, 0, `month ${month}`)
  }
})

test('a month grid refuses nonsense', () => {
  assert.deepEqual(monthGrid(2099, 0), [])
  assert.deepEqual(monthGrid(2099, 13), [])
  assert.deepEqual(monthGrid(2099.5, 1), [])
})

test('stepping a month crosses the year boundary', () => {
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 })
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 })
  assert.deepEqual(shiftMonth(2026, 5, 0), { year: 2026, month: 5 })
  assert.deepEqual(shiftMonth(2026, 5, 12), { year: 2027, month: 5 })
  assert.deepEqual(shiftMonth(2026, 5, -12), { year: 2025, month: 5 })
})
