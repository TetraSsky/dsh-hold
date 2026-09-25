// Shared test harness: a React stand-in, stands-in for the shipped primitives,
// a stub module loader, and tree walkers. Imported by the client and integration
// tests so both drive the real generated bundle the same way.

import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// A minimal React stand-in: one component instance, effects run immediately,
// cells kept across passes so a render/effect/re-render cycle is real.
export const makeReact = () => {
  let cells = []
  let cursor = 0

  return {
    reset() {
      cells = []
      cursor = 0
    },
    rewind() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
      }
      return [cells[index], set]
    },
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    memo(component) {
      return component
    },
  }
}

// The shipped primitives, stood in for by plain elements so the tree is
// walkable. Button renders its icon into the tree. Menu renders its anchor and,
// when open, its rows.
export const makePrimitives = (React) => {
  const icon = (name) => (props) => React.createElement('span', { ...props, 'data-icon': name })
  return {
    Button: (props) =>
      React.createElement('button', { ...props, 'data-primitive': 'button' }, props.icon, props.children),
    Menu: (props) =>
      React.createElement(
        'div',
        {
          'data-primitive': 'menu',
          'data-open': String(props.open),
          'data-selected': props.selectedId ?? '',
          'data-compact': String(props.compact === true),
        },
        props.anchor,
        props.open
          ? props.items.map((item) =>
              React.createElement(
                'button',
                { key: item.id, 'data-item': item.id, onClick: () => props.onSelect(item.id) },
                item.label,
              ),
            )
          : null,
      ),
    Input: (props) => React.createElement('input', { ...props, 'data-primitive': 'input' }),
    Switch: (props) =>
      React.createElement('input', {
        type: 'checkbox',
        'data-primitive': 'switch',
        'data-label': props.label,
        checked: props.checked === true,
        disabled: props.disabled === true,
        onChange: (event) => props.onChange(event.target.checked),
      }),
    IconQueueOutline14: icon('queue'),
    IconEditOutline16: icon('edit'),
    IconSendOutline14: icon('send'),
    IconTrashOutline16: icon('trash'),
    IconCloseOutline16: icon('close'),
    IconChevronLeftOutline14: icon('chevron-left'),
    IconChevronRightOutline14: icon('chevron-right'),
    IconChevronDownOutline14: icon('chevron-down'),
    IconChevronUpOutline14: icon('chevron-up'),
  }
}

// The exact slice of the DOM the client half touches: one idempotent style tag
// in the head, found by its data attribute.
export const makeDocument = () => {
  const head = {
    children: [],
    appendChild(node) {
      head.children.push(node)
      return node
    },
  }
  return {
    head,
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: '' }
    },
    querySelector(selector) {
      const wanted = /^style\[data-plugin-css="(.*)"\]$/u.exec(selector)?.[1]
      if (wanted === undefined) return null
      return (
        head.children.find((node) => node.tagName === 'style' && node.dataset.pluginCss === wanted) ?? null
      )
    },
  }
}

export const loadBundle = () => {
  let spec
  const window = { __ModuleLoader__: { load: (loaded) => { spec = loaded } } }
  new Function('window', source)(window)
  if (spec === undefined) throw new Error('the bundle must register itself with the module loader')

  const React = makeReact()
  const primitives = makePrimitives(React)
  const module = spec.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  return { spec, React, primitives, module }
}

export const makeClientContext = (options = {}) => {
  // An explicitly absent connection must stay absent, so no destructuring default.
  const connection = 'connection' in options ? options.connection : {}
  const conversation = 'conversation' in options ? options.conversation : undefined
  const registrations = []
  const injections = []
  const slots = {
    inject(name, callback) {
      injections.push(name)
      return callback()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  }
  const locale = { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      if (name === 'connection') return connection
      if (name === 'conversation') return conversation
      return undefined
    },
  }
  return { ctx, registrations, injections, locale }
}

// The conversation service, stood in for by the three calls the dock makes: what the
// composer has staged, what those serialize to, and how their uploads are going.
export const fakeConversation = (options = {}) => {
  const calls = { resolved: [], serialized: [] }
  const descriptors = options.descriptors ?? []
  const serialized = options.serialized ?? []
  const uploads = options.uploads ?? {}

  return {
    calls,
    service: {
      resolveDraftAttachments(ids) {
        calls.resolved.push([...ids])
        return descriptors
      },
      async serializeDraftAttachments(ids) {
        calls.serialized.push([...ids])
        if (options.serializeThrows !== undefined) throw new Error(options.serializeThrows)
        return { attachments: serialized }
      },
      fileUploads: { getSnapshot: () => uploads },
    },
  }
}

// A staged composer attachment, as the conversation service describes one.
export const stagedImage = (overrides = {}) => ({
  kind: 'image',
  id: 'draft-1',
  file: { name: 'shot.png', size: 2048 },
  previewUrl: 'blob:shot',
  ...overrides,
})

export const stagedFile = (overrides = {}) => ({
  kind: 'file',
  id: 'draft-2',
  file: { name: 'notes.txt', size: 12 },
  ...overrides,
})

export const connectionWith = (items) => ({
  rpc: {
    call: async (channel, method) =>
      method === 'list'
        ? { ok: true, value: { now: Date.now(), items } }
        : { ok: true, value: { id: 'hold-1', items: [] } },
  },
})

// One held row as the host describes it, carrying both attachment shapes.
export const heldRow = (overrides = {}) => ({
  id: 'hold-1',
  sessionId: 'session-1',
  text: 'carry on',
  at: null,
  behavior: 'wait',
  createdAt: 1,
  attachments: [
    { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    { kind: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 1024 } },
  ],
  waitingOn: [],
  remainingMs: null,
  ready: true,
  ...overrides,
})

export const sessionProps = (overrides = {}) => {
  const { draft = 'hello', attachmentIds = [], ...rest } = overrides
  return {
    sessionId: 'session-1',
    useInput: (selector) =>
      selector({ draft, attachmentIds, draftRev: 1, phase: 'plain', occurrences: [], queue: [] }),
    inputActions: { setDraft: () => {}, removeAttachment: () => {} },
    ...rest,
  }
}

export const setupClient = (options = {}) => {
  const { module, React, primitives } = loadBundle()
  const client = makeClientContext(options)
  // The client half installs its stylesheet on apply. Stand in for the exact
  // document calls it makes, so the real path runs rather than being skipped.
  const document = 'document' in options ? options.document : makeDocument()
  const hadDocument = 'document' in globalThis
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    module.apply(client.ctx)
  } finally {
    if (hadDocument) globalThis.document = previousDocument
    else delete globalThis.document
  }
  const entry = (name) => {
    const found = client.registrations.find((registration) => registration.spec.name === name)
    if (found === undefined) throw new Error(`slot ${name} was not registered`)
    return found
  }
  return { module, React, primitives, client, entry, document }
}

// A slot entry is a component, so the factory returns an element whose type is
// the component. Two passes: the first renders the initial state, the second the
// state its own effects just produced.
export const render = (React, factory, props) => {
  React.reset()
  const pass = () => {
    React.rewind()
    const element = factory(props)
    if (element === null || element === undefined) return element
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
  pass()
  return pass()
}

// A mounted entry: each call re-renders over the SAME hook cells, which is what
// an event handler followed by a re-render looks like.
export const mount = (React, factory, props) => {
  React.reset()
  return () => {
    React.rewind()
    const element = factory(props)
    if (element === null || element === undefined) return element
    return typeof element.type === 'function' ? element.type(element.props) : element
  }
}

// Expand a node the way React would, as many component layers as it takes.
export const deref = (node) => {
  let current = node
  for (let depth = 0; depth < 10; depth += 1) {
    if (current === null || typeof current !== 'object' || typeof current.type !== 'function') return current
    current = current.type(current.props)
  }
  return current
}

export const childrenOf = (node) => {
  const children = node?.props?.children
  return Array.isArray(children) ? children : children === undefined ? [] : [children]
}

export const findAll = (node, predicate, out = []) => {
  // A children array is a container, not a node: descend into it.
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  const current = deref(node)
  if (current === null || current === undefined || typeof current !== 'object') return out
  if (predicate(current)) out.push(current)
  for (const child of childrenOf(current)) findAll(child, predicate, out)
  return out
}

export const find = (node, predicate) => findAll(node, predicate)[0]

export const texts = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  const current = deref(node)
  if (typeof current === 'string' || typeof current === 'number') {
    out.push(String(current))
    return out
  }
  if (current === null || current === undefined || typeof current !== 'object') return out
  for (const child of childrenOf(current)) texts(child, out)
  return out
}

export const buttons = (node) => findAll(node, (item) => item.props?.['data-primitive'] === 'button')
export const inputs = (node) => findAll(node, (item) => item.props?.['data-primitive'] === 'input')
export const switches = (node) => findAll(node, (item) => item.props?.['data-primitive'] === 'switch')
// Drives the switch the way the DOM would, so tests do not hand-build events.
export const setSwitch = (node, on) => node.props.onChange({ target: { checked: on } })
export const menuRows = (node) => findAll(node, (item) => item.props?.['data-item'])
export const menuTrigger = (node, title) =>
  findAll(node, (item) => item.type === 'button' && item.props?.title === title)[0]
export const labelled = (node, label) => findAll(node, (item) => texts(item).includes(label))

// ---------------------------------------------------------------------------
// Driving the plugin's own window. Shared so both suites speak one vocabulary.
// ---------------------------------------------------------------------------

export const composerButton = (React, entry, props) =>
  find(render(React, entry('conversation.input.right').component, props), (node) => node.props?.['data-primitive'] === 'button')

// Opens the window from the composer button and returns a redraw function over the same hook cells.
export const mountWindow = (React, entry, props = sessionProps()) => {
  composerButton(React, entry, props).props.onClick()
  return mount(React, entry('conversation.input.dock').component, props)
}

// The Send-at switch, and the calendar it reveals.
export const whenSwitch = (tree) => switches(tree)[0]

export const openCalendar = (draw) => {
  setSwitch(whenSwitch(draw()), true)
  return draw()
}

// A calendar day cell. The hour and minute triggers are also two-digit buttons,
// so a day is identified by what it is NOT: a dropdown, or a titled control.
const isDayButton = (node) =>
  node.type === 'button' &&
  node.props?.['aria-haspopup'] === undefined &&
  node.props?.title === undefined &&
  texts(node).length === 1 &&
  /^\d{1,2}$/.test(texts(node)[0])

export const dayButtons = (tree) => findAll(tree, isDayButton)

export const dayButton = (tree, day) => dayButtons(tree).find((node) => texts(node)[0] === String(day))

export const monthStep = (tree, title) => menuTrigger(tree, title)

// Picks one value out of a dropdown, redrawing between the click that opens it
// and the click that chooses.
export const pickFromDropdown = (draw, title, id) => {
  menuTrigger(draw(), title).props.onClick()
  menuRows(draw()).find((row) => row.props['data-item'] === id).props.onClick()
}

// The window's own confirm button: Hold for a new one, Save for an edit.
export const submitButton = (tree) =>
  buttons(tree).find((node) => texts(node).some((text) => text === 'Hold' || text === 'Save'))

export const textIncludes = (tree, needle) => texts(tree).some((text) => text.includes(needle))
