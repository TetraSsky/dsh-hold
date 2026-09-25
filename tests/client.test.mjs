import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTACHMENT_BYTES, base64Chars } from '../src/hold.js'
import {
  buttons,
  composerButton,
  connectionWith,
  dayButton,
  dayButtons,
  fakeConversation,
  find,
  findAll,
  heldRow,
  inputs,
  loadBundle,
  menuRows,
  menuTrigger,
  monthStep,
  mountWindow,
  openCalendar,
  pickFromDropdown,
  render,
  sessionProps,
  setSwitch,
  setupClient as setup,
  stagedFile,
  stagedImage,
  submitButton,
  switches,
  texts,
  whenSwitch,
} from './harness.mjs'

// One microtask turn is enough for a stubbed RPC call to settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the bundle exports the plugin face the client runner loads', () => {
  const { module } = loadBundle()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'locale'])
})

test('applying the client half registers the composer button and the held list', () => {
  const { client } = setup()
  assert.deepEqual(
    client.registrations.map((registration) => registration.spec.name),
    ['conversation.input.right', 'conversation.input.dock'],
  )
  assert.deepEqual(
    client.registrations.map((registration) => registration.spec.id),
    ['hold-button', 'hold-dock'],
  )
  assert.deepEqual(client.injections, ['conversation.input.right', 'conversation.input.dock'])
})

test('there is no settings surface of any kind', () => {
  const { client, module } = setup()
  const names = client.registrations.map((registration) => registration.spec.name)
  assert.equal(names.includes('settings.section'), false)
  assert.equal(module.inject.includes('settingsScope'), false)
})

test('the button uses the shipped Button and the queue icon with the word Hold', () => {
  const { React, entry } = setup()
  const button = composerButton(React, entry, sessionProps())

  assert.ok(button, 'the control must render the shipped Button')
  assert.equal(button.props.disabled, false)
  assert.deepEqual(texts(button), ['Hold'])

  const icons = findAll(button, (node) => node.props?.['data-icon'] === 'queue')
  assert.equal(icons.length, 1, 'the button carries the queue glyph')
})

test('the button is disabled on an empty draft and says why', () => {
  const { React, entry } = setup()
  const button = composerButton(React, entry, sessionProps({ draft: '   ' }))
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.title, 'Type a message first.')
})

test('the button is absent without a session or a connection', () => {
  const withoutSession = setup()
  assert.equal(render(withoutSession.React, withoutSession.entry('conversation.input.right').component, sessionProps({ sessionId: undefined })), null)

  const withoutConnection = setup({ connection: undefined })
  assert.equal(render(withoutConnection.React, withoutConnection.entry('conversation.input.right').component, sessionProps()), null)
})

test('clicking the button opens the window, which disables its own session\'s button', () => {
  const { React, entry } = setup()
  const control = entry('conversation.input.right').component

  const before = render(React, control, sessionProps())
  assert.equal(find(before, (node) => node.props?.['data-primitive'] === 'button').props.disabled, false)

  find(before, (node) => node.props?.['data-primitive'] === 'button').props.onClick()

  const after = render(React, control, sessionProps())
  assert.equal(find(after, (node) => node.props?.['data-primitive'] === 'button').props.disabled, true)
})

test('a window opened in one session does not disable another session\'s button', () => {
  const { React, entry } = setup()
  const control = entry('conversation.input.right').component

  const first = render(React, control, sessionProps({ sessionId: 'session-1' }))
  find(first, (node) => node.props?.['data-primitive'] === 'button').props.onClick()

  const second = render(React, control, sessionProps({ sessionId: 'session-2' }))
  assert.equal(find(second, (node) => node.props?.['data-primitive'] === 'button').props.disabled, false)
})


test('applying the client half installs one stylesheet, and only one', () => {
  const { module, client, document } = setup()

  assert.equal(document.head.children.length, 1, 'exactly one style tag')
  const tag = document.head.children[0]
  assert.equal(tag.tagName, 'style')
  assert.equal(tag.dataset.plugin, 'dsh-hold')
  assert.equal(tag.dataset.pluginCss, 'dsh-hold/menu.css')

  // The shipped Menu caps itself at the viewport, and this is the cap that makes
  // a 24-hour or 60-minute list a picker instead of a full-page column.
  assert.match(tag.textContent, /body:has\(\[data-dsh-hold-window\]\) > div\[role="menu"\]/)
  assert.match(tag.textContent, /max-height: min\(320px, 100vh - 96px\)/)

  module.apply(client.ctx)
  assert.equal(document.head.children.length, 1, 'a second apply must not add a second tag')
})

test('the client half still applies where there is no document to style', () => {
  const { client, document } = setup({ document: undefined })
  assert.equal(document, undefined)
  assert.equal(client.registrations.length, 2, 'both entries are still registered')
})

test('the open window carries the marker the picker cap is keyed to', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)

  const open = draw()
  assert.equal(open.props['data-dsh-hold-window'], '')

  // Closed, with nothing held, there is no wrapper at all: nothing to cap.
  buttons(open)
    .find((node) => texts(node).includes('Close'))
    .props.onClick()
  assert.equal(draw(), null)
})

test('the dock takes the composer width instead of hiding the width handles', () => {
  const { React, entry } = setup()
  const open = mountWindow(React, entry)()

  // The goal bar's own recipe: the column less the composer's clearance and the
  // dock's insets, centred, with the card capped at the chat content width.
  for (const part of ['--dsh-composer-side-clearance', '--dsh-composer-dock-inset']) {
    assert.ok(open.props.style.width.includes(part), `the dock width must use ${part}`)
  }
  assert.equal(open.props.style.margin, '0 auto')
  assert.equal(open.props.style.flex, 'none')

  const card = find(open, (node) => node.props?.style?.maxWidth !== undefined)
  assert.ok(card, 'the card must carry the content-width cap')
  assert.ok(card.props.style.maxWidth.includes('--dsh-composer-card-max-width'))
  assert.equal(card.props.style.width, '100%')

  assert.equal('data-conversation-composer-overlay' in open.props, false)
})

test('the hour and minute lists are the capped, compact ones', () => {
  const { React, entry } = setup()
  const tree = openCalendar(mountWindow(React, entry))

  const menus = findAll(tree, (node) => node.props?.['data-primitive'] === 'menu')
  assert.equal(menus.length, 3, 'the behaviour axis and the two time lists')

  for (const title of ['Hour', 'Minute']) {
    const menu = menus.find((node) => menuTrigger(node, title) !== undefined)
    assert.ok(menu, `the ${title} list must render`)
    assert.equal(menu.props['data-compact'], 'true', `${title} rows must be compact`)
  }

  const behaviour = menus.find((node) => menuTrigger(node, 'Hour') === undefined && menuTrigger(node, 'Minute') === undefined)
  assert.ok(behaviour, 'the behaviour list must render')
  assert.equal(behaviour.props['data-compact'], 'false')
})

test('the window offers the time switch and the three behaviours', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)

  const tree = draw()
  const text = texts(tree)
  assert.ok(text.includes('Hold this message'), 'the window title must render')
  assert.ok(text.includes('Send at'))
  assert.ok(text.includes('If the AI is still working'))

  // Off by default: the default hold does not wait for a time as well.
  assert.equal(whenSwitch(tree).props.checked, false)
  assert.equal(whenSwitch(tree).props['data-label'], 'Send at')

  const menu = find(tree, (node) => node.props?.['data-primitive'] === 'menu')
  assert.equal(menu.props['data-selected'], 'wait')
  find(tree, (node) => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu').props.onClick()
  assert.deepEqual(
    menuRows(draw()).map((item) => item.props['data-item']),
    ['queue', 'wait', 'steer'],
  )
})

test('the calendar offers month navigation, weekdays, and hour and minute selectors', () => {
  const { React, entry } = setup()
  const tree = openCalendar(mountWindow(React, entry))

  assert.equal(findAll(tree, (node) => node.props?.['data-icon'] === 'chevron-left').length, 1)
  assert.equal(findAll(tree, (node) => node.props?.['data-icon'] === 'chevron-right').length, 1)

  for (const title of ['Hour', 'Minute']) {
    const trigger = menuTrigger(tree, title)
    assert.ok(trigger, `a ${title} selector must render`)
    assert.equal(/^\d{2}$/.test(texts(trigger)[0] ?? ''), true, `${title} shows a two-digit value`)
  }
  assert.equal(inputs(tree).length, 0, 'no typed clock fields')
})

test('the hour selector offers every hour, and the minute selector every minute', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)
  openCalendar(draw)

  menuTrigger(draw(), 'Hour').props.onClick()
  const hours = menuRows(draw())
  assert.equal(hours.length, 24)
  assert.equal(hours[0].props['data-item'], '00')
  assert.equal(hours[23].props['data-item'], '23')

  hours[0].props.onClick()
  menuTrigger(draw(), 'Minute').props.onClick()
  const minutes = menuRows(draw())
  assert.equal(minutes.length, 60)
  assert.equal(minutes[59].props['data-item'], '59')
})

test('the Send-at switch is what turns the calendar on and off', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)

  assert.equal(whenSwitch(draw()).props.checked, false)
  assert.equal(dayButton(draw(), 15), undefined, 'no calendar while the switch is off')

  setSwitch(whenSwitch(draw()), true)
  assert.equal(whenSwitch(draw()).props.checked, true)
  assert.ok(dayButton(draw(), 15) !== undefined || monthStep(draw(), 'Next month') !== undefined, 'the calendar appears')

  setSwitch(whenSwitch(draw()), false)
  assert.equal(whenSwitch(draw()).props.checked, false)
  assert.equal(dayButton(draw(), 15), undefined, 'and it goes away again')
})

test('days before today are disabled: the guard-rail against a past time', () => {
  const { React, entry } = setup()
  const tree = openCalendar(mountWindow(React, entry))

  const today = new Date()
  const days = dayButtons(tree)
  assert.ok(days.length > 0, 'the grid must render day buttons')

  for (const button of days) {
    const day = Number(texts(button)[0])
    assert.equal(button.props.disabled === true, day < today.getDate(), `day ${day}`)
  }
})

test('picking a day and a time builds a future instant', async () => {
  const calls = []
  const connection = {
    rpc: {
      call: async (channel, method, payload) => {
        calls.push({ channel, method, payload })
        return { ok: true, value: { id: 'hold-1', items: [] } }
      },
    },
  }
  const { React, entry } = setup({ connection })
  const draw = mountWindow(React, entry)
  openCalendar(draw)

  // Step to the next month, where every day is in the future, then pick 09:30.
  monthStep(draw(), 'Next month').props.onClick()
  dayButton(draw(), 15).props.onClick()
  pickFromDropdown(draw, 'Hour', '09')
  pickFromDropdown(draw, 'Minute', '30')

  const now = new Date()
  const expected = new Date(now.getFullYear(), now.getMonth() + 1, 15, 9, 30, 0, 0)

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const created = calls.find((call) => call.method === 'create')
  assert.ok(created, 'the window must call create')
  assert.equal(created.channel, '/dsh-hold')
  assert.equal(created.payload.at, expected.getTime())
  assert.equal(created.payload.behavior, 'wait')
})

test('a chosen time that has already passed is refused, not sent', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const { React, entry } = setup({ connection })
  const draw = mountWindow(React, entry)
  openCalendar(draw)

  // Today at this hour and minute zero is always at or before now.
  const now = new Date()
  dayButton(draw(), now.getDate()).props.onClick()
  pickFromDropdown(draw, 'Hour', String(now.getHours()).padStart(2, '0'))
  pickFromDropdown(draw, 'Minute', '00')

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.filter((call) => call.method === 'create').length, 0, 'nothing may be created')
  assert.ok(texts(draw()).includes('That time has already passed.'), 'the guard-rail must be reported inline')
})

test('a refusal this half does not know is shown the way the host put it', async () => {
  // The case that matters: the running host answers with a code the window has
  // no sentence for. Swallowing it into "that did not work" hides the reason.
  const connection = {
    rpc: {
      call: async () => ({ ok: false, error: { code: 'not-found', message: 'unknown endpoint: create' } }),
    },
  }
  const { React, entry } = setup({ connection })
  const draw = mountWindow(React, entry)

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const text = texts(draw())
  assert.ok(text.includes('unknown endpoint: create'), 'the host message must reach the window')
  assert.equal(text.includes('That did not work.'), false)
})

test('every refusal the host can send reads in the viewer language', async () => {
  // The host answers in English. A code without a sentence here would surface
  // that English text in a Chinese interface.
  const codes = [
    'invalid_at',
    'invalid_session',
    'invalid_id',
    'hold_not_found',
    'hold_not_stored',
    'too_many_attachments',
    'invalid_attachment',
    'attachment_too_large',
    'attachment_not_staged',
    'attachments_unavailable',
    'delivery_failed',
  ]

  for (const code of codes) {
    const connection = {
      rpc: { call: async () => ({ ok: false, error: { code, message: 'HOST SENTENCE' } }) },
    }
    const { React, entry } = setup({ connection })
    const draw = mountWindow(React, entry)

    submitButton(draw()).props.onClick()
    await settle()

    const text = texts(draw())
    assert.equal(text.includes('HOST SENTENCE'), false, `${code} must be localized`)
    assert.equal(text.includes('That did not work.'), false, `${code} must have its own sentence`)
    assert.equal(text.includes(code), false, `${code} must not surface as a bare code`)
  }
})

test('a localized refusal reads in Chinese when the interface is Chinese', async () => {
  const connection = {
    rpc: { call: async () => ({ ok: false, error: { code: 'hold_not_found', message: 'HOST SENTENCE' } }) },
  }
  const { React, client, entry } = setup({ connection })
  client.locale.getSnapshot = () => ({ active: 'zh' })
  const draw = mountWindow(React, entry)

  find(draw(), (node) => node.props?.variant === 'primary').props.onClick()
  await settle()

  const text = texts(draw())
  assert.ok(
    text.some((value) => /[\u4e00-\u9fff]/u.test(value)),
    'the refusal must read in Chinese',
  )
  assert.equal(text.includes('HOST SENTENCE'), false)
})

test('a failure that was thrown says only the short sentence, and logs the detail', async () => {
  const connection = { rpc: { call: async () => { throw new Error('socket closed') } } }
  const { React, entry } = setup({ connection })
  const draw = mountWindow(React, entry)

  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args)
  try {
    submitButton(draw()).props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    console.error = original
  }

  const text = texts(draw())
  assert.ok(text.includes('That did not work.'))
  assert.equal(text.includes('socket closed'), false, 'a thrown failure is not window copy')
  assert.equal(logged.length, 1, 'but the console keeps it')
})

test('the window shows the composer attachments and can drop one', () => {
  const conversation = fakeConversation({
    descriptors: [stagedImage(), stagedFile()],
    uploads: { 'draft-1': { status: 'ready' }, 'draft-2': { status: 'ready', receiptId: 'r-2' } },
  })
  const { React, entry } = setup({ conversation: conversation.service })
  const tree = mountWindow(React, entry, sessionProps({ attachmentIds: ['draft-1', 'draft-2'] }))()

  assert.ok(texts(tree).includes('shot.png'), 'the staged image is named')
  assert.ok(texts(tree).includes('notes.txt'), 'the staged file is named')
  assert.ok(texts(tree).includes('2.0 KB'), 'and its size is shown')
  assert.ok(texts(tree).includes('12 B'))
  assert.equal(findAll(tree, (node) => node.props?.title === 'Remove this attachment').length, 2)
})

test('a staged attachment is removed from the composer through the input actions', () => {
  const removed = []
  const conversation = fakeConversation({ descriptors: [stagedImage()], uploads: { 'draft-1': { status: 'ready' } } })
  const { React, entry } = setup({ conversation: conversation.service })
  const props = sessionProps({
    attachmentIds: ['draft-1'],
    inputActions: { setDraft: () => {}, removeAttachment: (id) => removed.push(id) },
  })
  const draw = mountWindow(React, entry, props)

  find(draw(), (node) => node.props?.title === 'Remove this attachment').props.onClick()
  assert.deepEqual(removed, ['draft-1'])
})

test('holding a staged attachment serializes it and takes it out of the composer', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const removed = []
  const conversation = fakeConversation({
    descriptors: [stagedImage(), stagedFile()],
    serialized: [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { type: 'file', receiptId: 'r-2' },
    ],
    uploads: { 'draft-1': { status: 'ready' }, 'draft-2': { status: 'ready', receiptId: 'r-2' } },
  })
  const { React, entry } = setup({ connection, conversation: conversation.service })
  const props = sessionProps({
    attachmentIds: ['draft-1', 'draft-2'],
    inputActions: { setDraft: () => {}, removeAttachment: (id) => removed.push(id) },
  })

  submitButton(mountWindow(React, entry, props)()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const created = calls.find((call) => call.method === 'create')
  assert.deepEqual(created.payload.attachments, [
    { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    { kind: 'file', receiptId: 'r-2' },
  ])
  assert.deepEqual(removed, ['draft-1', 'draft-2'], 'the attachments belong to the hold now')
  assert.deepEqual(conversation.calls.serialized, [['draft-1', 'draft-2']])
})

test('a file that is still uploading refuses the hold, and says why', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const conversation = fakeConversation({
    descriptors: [stagedFile()],
    uploads: { 'draft-2': { status: 'uploading', loaded: 3, total: 12 } },
  })
  const { React, entry } = setup({ connection, conversation: conversation.service })
  const draw = mountWindow(React, entry, sessionProps({ attachmentIds: ['draft-2'] }))

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.some((call) => call.method === 'create'), false)
  assert.ok(texts(draw()).includes('A file is still uploading.'))
  assert.deepEqual(conversation.calls.serialized, [], 'nothing is serialized for an unfinished upload')
})

test('a failed upload refuses the hold too', async () => {
  const conversation = fakeConversation({
    descriptors: [stagedFile()],
    uploads: { 'draft-2': { status: 'error', message: 'nope' } },
  })
  const { React, entry } = setup({ conversation: conversation.service })
  const draw = mountWindow(React, entry, sessionProps({ attachmentIds: ['draft-2'] }))

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(texts(draw()).includes('A file upload failed.'))
})

test('an oversized batch is refused in the window, before it is sent', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const conversation = fakeConversation({
    descriptors: [stagedImage()],
    // One byte over the hold's whole budget.
    serialized: [
      {
        type: 'image',
        mediaType: 'image/png',
        data: 'A'.repeat(base64Chars(MAX_ATTACHMENT_BYTES + 3) - ((3 - ((MAX_ATTACHMENT_BYTES + 3) % 3)) % 3)) +
          '='.repeat((3 - ((MAX_ATTACHMENT_BYTES + 3) % 3)) % 3),
      },
    ],
    uploads: { 'draft-1': { status: 'ready' } },
  })
  const { React, entry } = setup({ connection, conversation: conversation.service })
  const draw = mountWindow(React, entry, sessionProps({ attachmentIds: ['draft-1'] }))

  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.some((call) => call.method === 'create'), false)
  assert.ok(texts(draw()).includes('Those attachments are too large to hold.'))
})

test('an image-only hold can be submitted', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const conversation = fakeConversation({
    descriptors: [stagedImage()],
    serialized: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    uploads: { 'draft-1': { status: 'ready' } },
  })
  const { React, entry } = setup({ connection, conversation: conversation.service })
  const props = sessionProps({ draft: '   ', attachmentIds: ['draft-1'] })
  const draw = mountWindow(React, entry, props)

  assert.equal(submitButton(draw()).props.disabled, false, 'an image is a message')
  submitButton(draw()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const created = calls.find((call) => call.method === 'create')
  assert.equal(created.payload.text, '   ')
  assert.equal(created.payload.attachments.length, 1)
})

test('a held row shows what it is carrying', async () => {
  const { React, entry } = setup({ connection: connectionWith([heldRow()]) })
  const draw = mountWindow(React, entry)
  draw()
  await settle()
  const tree = draw()

  assert.ok(texts(tree).includes('shot.png'), 'the image is named')
  assert.ok(texts(tree).includes('notes.txt'), 'the file is named')
  assert.ok(texts(tree).includes('1.0 KB'), 'and the file size is shown')
  const thumb = find(tree, (node) => node.type === 'img')
  assert.equal(thumb.props.src, 'data:image/png;base64,AAAA', 'the thumbnail comes from the held bytes')
})

test('editing seeds the held attachments, and dropping one saves the rest', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    if (method === 'list') return { ok: true, value: { now: Date.now(), items: [heldRow()] } }
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const { React, entry } = setup({ connection })
  const draw = mountWindow(React, entry)
  draw()
  await settle()
  const tree = draw()

  findAll(tree, (node) => node.type === 'button' && texts(node).includes('Edit'))[0].props.onClick()
  const opened = draw()
  assert.ok(texts(opened).includes('shot.png'))
  assert.ok(texts(opened).includes('notes.txt'))

  const removeButtons = findAll(opened, (node) => node.props?.title === 'Remove this attachment')
  assert.equal(removeButtons.length, 2)
  removeButtons[0].props.onClick()

  submitButton(draw()).props.onClick()
  await settle()

  const updated = calls.find((call) => call.method === 'update')
  assert.equal(updated.payload.attachments.length, 1, 'the dropped attachment is not sent back')
  assert.equal(updated.payload.attachments[0].kind, 'file')
  assert.equal(updated.payload.attachments[0].attachment.name, 'notes.txt')
})

test('an unset time sends as soon as possible', async () => {
  const calls = []
  const connection = { rpc: { call: async (channel, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, value: { id: 'hold-1', items: [] } }
  } } }
  const { React, entry } = setup({ connection })
  submitButton(mountWindow(React, entry)()).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.find((call) => call.method === 'create').payload.at, null)
})

test('the window hint is just "Optional."', () => {
  const { React, entry } = setup()
  const tree = openCalendar(mountWindow(React, entry))
  assert.ok(texts(tree).includes('Optional.'), 'the hint must be the short form')
  assert.equal(texts(tree).some((text) => text.includes('Days before today')), false)
})

test('the three behaviours read as the agreed labels', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)
  menuTrigger(draw(), 'If the AI is still working')
  findAll(draw(), (node) => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')[0].props.onClick()

  assert.deepEqual(
    menuRows(draw()).map((row) => texts(row)[0]),
    ['Queue (Default)', 'Wait idle', 'Send now (Steer)'],
  )
})

test('choosing a behaviour in the menu updates the selection', () => {
  const { React, entry } = setup()
  const draw = mountWindow(React, entry)

  const trigger = find(draw(), (node) => node.type === 'button' && node.props?.['aria-haspopup'] === 'menu')
  assert.ok(trigger, 'the menu needs a trigger button')
  trigger.props.onClick()

  const opened = draw()
  const steer = findAll(opened, (node) => node.props?.['data-item'] === 'steer')[0]
  assert.ok(steer, 'the open menu must offer steer')
  steer.props.onClick()

  const menu = find(draw(), (node) => node.props?.['data-primitive'] === 'menu')
  assert.equal(menu.props['data-selected'], 'steer')
  assert.equal(menu.props['data-open'], 'false', 'choosing closes the menu')
})

test('the dock renders nothing while nothing is held', () => {
  const { React, entry } = setup()
  assert.equal(render(React, entry('conversation.input.dock').component, sessionProps()), null)
})

test('one held message renders as itself, with no header to open', async () => {
  const { React, entry } = setup({ connection: connectionWith([heldRow()]) })
  const draw = mountWindow(React, entry)
  draw()
  await settle()
  const tree = draw()

  assert.ok(texts(tree).includes('carry on'), 'the row renders')
  assert.equal(findAll(tree, (node) => node.props?.['aria-expanded'] !== undefined).length, 0, 'no header')
  assert.ok(texts(tree).includes('Edit'))
})

test('two or more held messages collapse into a count header', async () => {
  const items = [heldRow(), heldRow({ id: 'hold-2', text: 'and this one' }), heldRow({ id: 'hold-3', text: 'and this' })]
  const { React, entry } = setup({ connection: connectionWith(items) })
  const draw = mountWindow(React, entry)
  draw()
  await settle()
  const tree = draw()

  assert.ok(texts(tree).includes('3 held messages'), 'the header counts them')
  assert.equal(texts(tree).includes('carry on'), false, 'nothing is listed while collapsed')
  assert.equal(texts(tree).includes('Edit'), false)

  const header = find(tree, (node) => node.props?.['aria-expanded'] !== undefined)
  assert.equal(header.props['aria-expanded'], false)
  assert.equal(findAll(header, (node) => node.props?.['data-icon'] === 'chevron-up').length, 1)
  assert.equal(findAll(header, (node) => node.props?.['data-icon'] === 'queue').length, 1)
})

test('opening the header lists every hold, inside a capped scroller', async () => {
  const items = [heldRow(), heldRow({ id: 'hold-2', text: 'and this one' }), heldRow({ id: 'hold-3', text: 'and this' })]
  const { React, entry } = setup({ connection: connectionWith(items) })
  const draw = mountWindow(React, entry)
  draw()
  await settle()

  find(draw(), (node) => node.props?.['aria-expanded'] !== undefined).props.onClick()
  const tree = draw()

  assert.ok(texts(tree).includes('3 held messages'), 'the header stays')
  assert.ok(texts(tree).includes('carry on'), 'and the rows are listed')
  assert.ok(texts(tree).includes('and this one'))
  assert.equal(buttons(tree).filter((node) => texts(node).includes('Edit')).length, 3)

  const header = find(tree, (node) => node.props?.['aria-expanded'] !== undefined)
  assert.equal(header.props['aria-expanded'], true)
  assert.equal(findAll(header, (node) => node.props?.['data-icon'] === 'chevron-down').length, 1)

  // The shipped queue strip's own bound: a long list scrolls, it does not grow.
  const list = find(tree, (node) => node.props?.id === 'dsh-hold-list')
  assert.equal(list.props.style.maxHeight, '180px')
  assert.equal(list.props.style.overflowY, 'auto')

  find(draw(), (node) => node.props?.['aria-expanded'] !== undefined).props.onClick()
  assert.equal(texts(draw()).includes('carry on'), false)
})

test('a held row is a filled block, and clears the list scrollbar', async () => {
  const items = [heldRow(), heldRow({ id: 'hold-2', text: 'and this one' })]
  const { React, entry } = setup({ connection: connectionWith(items) })
  const draw = mountWindow(React, entry)
  draw()
  await settle()
  find(draw(), (node) => node.props?.['aria-expanded'] !== undefined).props.onClick()
  const tree = draw()

  // The harness' own hover wash, so a held message reads as a block instead of bare text on the panel.
  const row = find(tree, (node) => node.props?.style?.background === 'var(--dsw-alias-interactive-bg-hover)')
  assert.ok(row, 'a held row must be filled')
  assert.equal(row.props.style.borderRadius, '8px')

  // The scrollbar is drawn inside the list, so the rows have to clear its width.
  const list = find(tree, (node) => node.props?.id === 'dsh-hold-list')
  assert.match(list.props.style.paddingRight, /--dsh-scrollbar-width/)

  // Hovering the header fills it with the same wash a row carries, so the two
  // must never sit flush against each other.
  const header = find(tree, (node) => node.props?.['aria-expanded'] !== undefined)
  assert.equal(header.props.style.marginBottom, '6px')
})

test('the window follows the active locale', () => {
  const { React, client, entry } = setup()
  client.locale.getSnapshot = () => ({ active: 'zh' })

  const control = entry('conversation.input.right').component
  const dock = entry('conversation.input.dock').component

  const button = find(render(React, control, sessionProps()), (node) => node.props?.['data-primitive'] === 'button')
  assert.deepEqual(texts(button), ['暂缓'])
  button.props.onClick()

  assert.ok(texts(render(React, dock, sessionProps())).includes('暂缓这条消息'))
})

test('a missing slots service aborts instead of throwing', () => {
  const { module } = loadBundle()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  try {
    module.apply({ get: () => undefined })
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /client apply aborted/)
})
