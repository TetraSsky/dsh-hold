import {
  BEHAVIORS,
  MAX_ATTACHMENT_BYTES,
  attachmentBytes,
  formatWhenField,
  heldAttachmentDisplay,
  instantFromParts,
  monthGrid,
  parseAttachments,
  shiftMonth,
  stagedAttachmentDisplay,
  toHeldAttachment,
} from './hold.js'
import { fallbackLocale, translate } from './i18n.js'

// The platform singletons the bundle wrapper provides.
const CHANNEL = '/dsh-hold'

// A release made elsewhere has to show up, and the countdown has to keep moving.
const POLL_MS = 2000

const h = React.createElement

// The composer dock's width recipe, copied from the shipped goal bar. It keeps
// this block clear of the conversation's width handles, which sit 24px outside
// the chat content width, so no handle has to be hidden while it is open.
const DOCK_WIDTH = {
  boxSizing: 'border-box',
  width: [
    'calc(100%',
    '- var(--dsh-composer-side-clearance)',
    '- var(--dsh-composer-side-clearance)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset))',
  ].join(' '),
  margin: '0 auto',
  flex: 'none',
}

// The goal bar's `card-max-width` less the dock's own insets, which lands the
// card on the chat content width.
const CARD_WIDTH = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: [
    'calc(var(--dsh-composer-card-max-width)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset)',
    '- var(--dsh-composer-dock-inset))',
  ].join(' '),
  margin: '0 auto',
}

// Every control is a harness primitive. A native <select> or date picker draws
// its popup with the OS theme, which does not match the shell.
const styles = {
  wrap: { ...DOCK_WIDTH, display: 'flex', flexDirection: 'column', gap: '8px' },
  card: {
    ...CARD_WIDTH,
    border: '1px solid var(--dsw-alias-border-secondary)',
    borderRadius: '10px',
    padding: '12px',
    background: 'var(--dsw-alias-bg-secondary)',
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  title: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
  hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
  divider: { height: '1px', background: 'var(--dsw-alias-border-secondary)', margin: '10px 0' },
  textarea: {
    width: '100%',
    minHeight: '56px',
    padding: '8px',
    fontSize: '13px',
    fontFamily: 'inherit',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-primary)',
    border: '1px solid var(--dsw-alias-border-secondary)',
    borderRadius: '6px',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  calendar: {
    marginTop: '8px',
    padding: '10px',
    border: '1px solid var(--dsw-alias-border-secondary)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-primary)',
  },
  monthRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
  month: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' },
  weekday: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '2px 0' },
  dayCell: { display: 'flex', justifyContent: 'center' },
  clockRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' },
  attachments: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '100%',
    padding: '2px 4px 2px 6px',
    border: '0.5px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-primary)',
  },
  thumb: { width: '24px', height: '24px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 },
  chipName: {
    minWidth: 0,
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary-dimmed)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipSize: { flexShrink: 0, fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' },
  // The harness' own hover wash, so a held message reads as a block.
  holdRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '8px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  // Hovering the header fills it with the wash the rows carry, so it keeps a gap
  // below it rather than reading as one block with the first row.
  listHeader: { width: '100%', justifyContent: 'flex-start', marginBottom: '6px' },
  lead: { display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
  count: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, textAlign: 'left' },
  chevron: { display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
  // 180px is the shipped queue strip's own bound. The padding clears the
  // scrollbar, which is drawn inside the list at the width the shell reserves.
  holdList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '180px',
    overflowY: 'auto',
    paddingRight: 'calc(var(--dsh-scrollbar-width, 8px) + 4px)',
    '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
    '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
  },
  holdText: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}

// Only one dock is mounted at a time, so one id is enough.
const LIST_ID = 'dsh-hold-list'

const attachmentChip = (item, t, onRemove) =>
  h(
    'span',
    { key: item.key, style: styles.chip },
    item.previewUrl === undefined
      ? null
      : h('img', { src: item.previewUrl, alt: '', style: styles.thumb }),
    h('span', { style: styles.chipName }, item.name === '' ? t('attachment') : item.name),
    h('span', { style: styles.chipSize }, item.sizeText),
    onRemove === undefined
      ? null
      : h(primitives.Button, {
          variant: 'ghost',
          icon: h(primitives.IconTrashOutline16, { size: 14 }),
          title: t('removeAttachment'),
          onClick: () => onRemove(item.key),
        }),
  )

const attachmentRow = (items, t, onRemove) =>
  items.length === 0 ? null : h('div', { style: styles.attachments }, items.map((item) => attachmentChip(item, t, onRemove)))

// The shipped Menu bounds its list to the viewport, which for 24 hours or 60
// minutes is the whole page. The list is portaled to the body, out of this
// plugin's subtree, so the cap is scoped from the body and keyed to a marker the
// window carries only while it is open.
const MENU_CSS = [
  'body:has([data-dsh-hold-window]) > div[role="menu"] {',
  '  max-height: min(320px, 100vh - 96px);',
  '  min-width: 96px;',
  '}',
].join('\n')

const STYLE_ID = 'dsh-hold/menu.css'

// One tag per page, marked the way the platform marks its own client styles.
const installStyles = (doc = typeof document === 'undefined' ? undefined : document) => {
  if (doc === undefined || doc === null) return false
  if (doc.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return false

  const tag = doc.createElement('style')
  tag.dataset.plugin = 'dsh-hold'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = MENU_CSS
  doc.head.appendChild(tag)
  return true
}

// Every code the host can refuse with, so a refusal reads in the viewer's
// language instead of arriving as the host's own English sentence.
const ERROR_KEYS = {
  invalid_at: 'errorInvalidDate',
  invalid_date: 'errorInvalidDate',
  not_future: 'errorNotFuture',
  invalid_text: 'errorInvalidText',
  text_too_long: 'errorTooLong',
  invalid_session: 'errorInvalidSession',
  invalid_id: 'errorInvalidId',
  hold_not_found: 'errorHoldGone',
  hold_not_stored: 'errorNotStored',
  too_many_attachments: 'errorTooManyAttachments',
  invalid_attachment: 'errorInvalidAttachment',
  attachment_too_large: 'errorAttachmentTooLarge',
  attachment_not_staged: 'errorAttachmentGone',
  attachments_unavailable: 'errorAttachmentsUnavailable',
  attachment_uploading: 'errorAttachmentUploading',
  attachment_upload_failed: 'errorAttachmentUploadFailed',
  delivery_failed: 'errorDeliveryFailed',
  'no-connection': 'errorNoConnection',
}

// A code this half does not know is the host's own refusal, so the host's message
// is shown rather than swallowed into a generic sentence.
const errorText = (failure, t) => {
  const code = typeof failure === 'string' ? failure : failure?.code
  const key = ERROR_KEYS[code]
  if (key !== undefined) return t(key)

  const message = typeof failure?.message === 'string' ? failure.message.trim() : ''
  return message === '' ? t('errorGeneric') : message
}

const useLocaleId = (locale) => {
  const subscribe = React.useCallback(
    (onChange) => (locale && locale.subscribe ? locale.subscribe(onChange) : () => {}),
    [locale],
  )
  const read = React.useCallback(() => {
    try {
      return locale?.getSnapshot?.().active ?? fallbackLocale
    } catch {
      return fallbackLocale
    }
  }, [locale])
  return React.useSyncExternalStore(subscribe, read)
}

const call = (connection, method, payload) => {
  if (connection === undefined || connection === null) {
    return Promise.resolve({ ok: false, error: { code: 'no-connection' } })
  }
  return connection.rpc.call(CHANNEL, method, payload)
}

// Two slot entries have to share one window and cannot share React context, so
// the open request lives here, scoped by session id.
const createStore = (initial) => {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const calendarFor = (ms) => {
  const at = new Date(ms)
  return {
    date: { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate() },
    view: { year: at.getFullYear(), month: at.getMonth() + 1 },
    hour: String(at.getHours()).padStart(2, '0'),
    minute: String(at.getMinutes()).padStart(2, '0'),
  }
}

const thisMonth = () => {
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth() + 1 }
}

// A null date is how "no earliest time" is expressed, which is the switch off.
const basePanel = () => ({
  open: false,
  sessionId: null,
  editingId: null,
  text: '',
  date: null,
  view: thisMonth(),
  hour: '00',
  minute: '00',
  behavior: 'wait',
  // The attachments an edit is holding, in the shape the record stores.
  attachments: [],
})

const panel = createStore(basePanel())
const usePanel = () => React.useSyncExternalStore(panel.subscribe, panel.get)
const closePanel = () => panel.set(basePanel())

const REASON_KEYS = {
  time: 'reasonTime',
  agent: 'reasonAgent',
  'agent-absent': 'reasonAgentAbsent',
  subagents: 'reasonSubagents',
  jobs: 'reasonJobs',
}

const behaviorLabel = (behavior, t) =>
  behavior === 'queue' ? t('behaviorQueue') : behavior === 'steer' ? t('behaviorSteer') : t('behaviorWait')

const formatRemaining = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
}

const holdMeta = (item, hostNow, t) => {
  const parts = [behaviorLabel(item.behavior, t)]

  if (item.at !== null) {
    parts.push(formatWhenField(item.at))
    if (item.at > hostNow) parts.push(formatRemaining(item.at - hostNow))
  }

  parts.push(
    item.waitingOn?.length
      ? t('waitingOn', { reasons: item.waitingOn.map((reason) => t(REASON_KEYS[reason] ?? 'reasonTime')).join(', ') })
      : t('readyNow'),
  )

  return parts.join(' \u00B7 ')
}

const dayKey = (parts) => parts.year * 10000 + parts.month * 100 + parts.day

// Days before today are disabled, which is the guard-rail against a past time.
const monthCells = (view, localeId, selected, actions, t) => {
  const today = new Date()
  const floor = dayKey({ year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() })

  const label = new Intl.DateTimeFormat(localeId, { month: 'long', year: 'numeric' }).format(
    new Date(view.year, view.month - 1, 1),
  )
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(localeId, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + index)),
  )

  return [
    h(
      'div',
      { key: 'month', style: styles.monthRow },
      h(
        primitives.Button,
        {
          variant: 'ghost',
          icon: h(primitives.IconChevronLeftOutline14, {}),
          title: t('previousMonth'),
          onClick: () => actions.onView(shiftMonth(view.year, view.month, -1)),
        },
      ),
      h('div', { style: styles.month }, label),
      h(
        primitives.Button,
        {
          variant: 'ghost',
          icon: h(primitives.IconChevronRightOutline14, {}),
          title: t('nextMonth'),
          onClick: () => actions.onView(shiftMonth(view.year, view.month, 1)),
        },
      ),
    ),
    h(
      'div',
      { key: 'grid', style: styles.grid },
      weekdays.map((name, index) => h('div', { key: `w${index}`, style: styles.weekday }, name)),
      monthGrid(view.year, view.month).map((day, index) => {
        if (day === null) return h('div', { key: `e${index}` })
        const parts = { year: view.year, month: view.month, day }
        const chosen = selected !== null && dayKey(selected) === dayKey(parts)
        return h(
          'div',
          { key: `d${day}`, style: styles.dayCell },
          h(
            primitives.Button,
            {
              variant: chosen ? 'primary' : 'ghost',
              disabled: dayKey(parts) < floor,
              onClick: () => actions.onDate(parts),
            },
            String(day),
          ),
        )
      }),
    ),
  ]
}

const numberOptions = (count) =>
  Array.from({ length: count }, (_, value) => {
    const text = String(value).padStart(2, '0')
    return { id: text, label: text }
  })

const hourOptions = numberOptions(24)
const minuteOptions = numberOptions(60)

const dropdown = (label, openMenu, setOpenMenu, id, value, items, onPick) =>
  h(primitives.Menu, {
    open: openMenu === id,
    align: 'start',
    portal: true,
    // 26px rows rather than 40, so the capped list shows as many values as it can.
    compact: true,
    items,
    selectedId: value,
    onSelect: (next) => {
      onPick(next)
      setOpenMenu(null)
    },
    onClose: () => setOpenMenu(null),
    anchor: h(
      primitives.Button,
      {
        variant: 'ghost',
        'aria-haspopup': 'menu',
        title: label,
        onClick: () => setOpenMenu(openMenu === id ? null : id),
      },
      value,
    ),
  })

function HoldButton({ sessionId, useInput, locale, connection }) {
  const localeId = useLocaleId(locale)
  const t = (key, vars) => translate(localeId, key, vars)
  const draft = useInput((state) => state.draft)
  const opened = usePanel()

  if (sessionId === undefined || connection === undefined) return null

  const empty = draft.trim() === ''
  const openHere = opened.open && opened.sessionId === sessionId

  return h(
    primitives.Button,
    {
      variant: 'ghost',
      icon: h(primitives.IconQueueOutline14, {}),
      disabled: empty || openHere,
      title: empty ? t('buttonEmpty') : t('buttonTitle'),
      onClick: () => panel.set({ ...basePanel(), open: true, sessionId, text: draft }),
    },
    t('buttonLabel'),
  )
}

function HoldDock({ sessionId, useInput, inputActions, locale, connection, conversation }) {
  const localeId = useLocaleId(locale)
  const t = (key, vars) => translate(localeId, key, vars)
  const draft = useInput((state) => state.draft)
  const stagedIds = useInput((state) => state.attachmentIds)
  const opened = usePanel()

  const [state, setState] = React.useState({ items: [], now: Date.now(), fetchedAt: Date.now() })
  // 'behavior', 'hour', 'minute', or nothing.
  const [openMenu, setOpenMenu] = React.useState(null)
  // Two or more held messages start folded into their count header.
  const [collapsed, setCollapsed] = React.useState(true)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [, setTick] = React.useState(0)

  // What the composer has staged right now, so the window shows what a hold will
  // carry while the composer's own rail stays where it is.
  const staged = (() => {
    if (conversation === undefined || !Array.isArray(stagedIds) || stagedIds.length === 0) return []
    try {
      return conversation.resolveDraftAttachments(stagedIds) ?? []
    } catch {
      return []
    }
  })()

  const load = React.useCallback(async () => {
    if (sessionId === undefined) return
    try {
      const result = await call(connection, 'list', { sessionId })
      if (!result.ok) return
      const at = Date.now()
      setState({ items: result.value.items ?? [], now: result.value.now ?? at, fetchedAt: at })
    } catch {
      // A failed poll keeps the previous view rather than blanking it.
    }
  }, [sessionId, connection])

  React.useEffect(() => {
    if (sessionId === undefined) return undefined
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [sessionId, load])

  // The host clock is advanced by local elapsed, so countdowns move between polls.
  React.useEffect(() => {
    if (state.items.length === 0) return undefined
    const id = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(id)
  }, [state.items.length])

  // A window opened for another session is discarded, so its captured draft
  // cannot linger behind a session switch.
  React.useEffect(() => {
    if (opened.open && opened.sessionId !== null && sessionId !== undefined && opened.sessionId !== sessionId) {
      closePanel()
    }
  }, [opened.open, opened.sessionId, sessionId])

  if (sessionId === undefined) return null

  const editingHere = opened.open && opened.sessionId === sessionId
  const patchPanel = (next) => panel.set((current) => ({ ...current, ...next }))

  // Anything that is not a valid clock reads as zero.
  const clockValue = (raw) => {
    const value = Number(String(raw).replace(/\D/g, '').slice(0, 2))
    return Number.isSafeInteger(value) && value >= 0 && value <= 59 ? value : 0
  }

  const chosenAt = () =>
    opened.date === null
      ? null
      : instantFromParts({
          year: opened.date.year,
          month: opened.date.month,
          day: opened.date.day,
          hour: clockValue(opened.hour),
          minute: clockValue(opened.minute),
        })

  // The composer's staged attachments, serialized into the shapes a hold keeps.
  const stagedPayload = async () => {
    if (staged.length === 0) return { ok: true, attachments: [], ids: [] }

    const uploads = conversation?.fileUploads?.getSnapshot?.() ?? {}
    for (const id of stagedIds) {
      const upload = uploads[id]
      if (upload?.status === 'uploading') return { ok: false, reason: 'attachment_uploading' }
      if (upload?.status === 'error') return { ok: false, reason: 'attachment_upload_failed' }
    }

    const serialized = await conversation.serializeDraftAttachments(stagedIds)
    const attachments = (serialized?.attachments ?? []).map(toHeldAttachment).filter(Boolean)

    // The same budget the host enforces, so an oversized hold is refused here.
    const checked = parseAttachments(attachments)
    if (!checked.ok) return { ok: false, reason: checked.code }

    return { ok: true, attachments, ids: [...stagedIds] }
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const at = chosenAt()
      if (opened.date !== null && at === null) {
        setError(errorText('invalid_date', t))
        return
      }
      // Never hand the host a time that has already passed.
      if (at !== null && at <= Date.now()) {
        setError(errorText('not_future', t))
        return
      }

      // An edit carries the attachments the window holds, a new hold the staged ones.
      const carried =
        opened.editingId === null
          ? await stagedPayload()
          : { ok: true, attachments: opened.attachments, ids: [] }

      if (carried.ok !== true) {
        setError(errorText(carried.reason, t))
        return
      }

      const body = { text: opened.text, at, behavior: opened.behavior, attachments: carried.attachments }
      const result =
        opened.editingId === null
          ? await call(connection, 'create', { sessionId, ...body })
          : await call(connection, 'update', { id: opened.editingId, ...body })

      if (!result.ok) {
        setError(errorText(result.error, t))
        return
      }

      // The attachments belong to the hold now, so they must not ride along with
      // the next message sent from the composer.
      for (const id of carried.ids) inputActions?.removeAttachment?.(id)

      // Only clear the composer if it still holds the text that was taken.
      if (opened.editingId === null && draft === opened.text) inputActions?.setDraft?.('')
      closePanel()
      await load()
    } catch (failure) {
      // A thrown failure is the transport, so it has no message worth showing.
      console.error('[hold] the request failed', failure)
      setError(t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  const act = async (method, id) => {
    setBusy(true)
    setError('')
    try {
      const result = await call(connection, method, { id })
      if (!result.ok) {
        setError(errorText(result.error, t))
        return
      }
      closePanel()
      await load()
    } catch (failure) {
      console.error('[hold] the request failed', failure)
      setError(t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  // The composer's staged attachments for a new hold, the hold's own for an edit.
  const windowAttachments =
    opened.editingId === null
      ? staged.map((descriptor, index) => stagedAttachmentDisplay(descriptor, stagedIds[index]))
      : opened.attachments.map((attachment, index) => heldAttachmentDisplay(attachment, String(index)))

  const dropAttachment = (key) => {
    if (opened.editingId === null) {
      inputActions?.removeAttachment?.(key)
      return
    }
    patchPanel({ attachments: opened.attachments.filter((_, index) => String(index) !== key) })
  }

  const windowNode = editingHere
    ? h(
        'div',
        { style: styles.card },
        h('div', { style: styles.title }, t('windowTitle')),
        h('div', { style: { ...styles.hint, marginTop: '2px' } }, t('windowHint')),

        h('textarea', {
          style: { ...styles.textarea, marginTop: '10px' },
          value: opened.text,
          'aria-label': t('message'),
          onChange: (event) => patchPanel({ text: event.target.value }),
        }),

        attachmentRow(windowAttachments, t, dropAttachment),

        h('div', { style: styles.divider }),

        // The switch is the whole "send as soon as possible" story. Off means no
        // earliest time, which is the default.
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('when')),
          h(primitives.Switch, {
            checked: opened.date !== null,
            label: t('when'),
            onChange: (on) => patchPanel(on ? calendarFor(Date.now() + 3600 * 1000) : { date: null }),
          }),
        ),

        opened.date === null
          ? null
          : h(
              'div',
              { style: styles.calendar },
              monthCells(opened.view, localeId, opened.date, {
                onDate: (date) => patchPanel({ date }),
                onView: (view) => patchPanel({ view }),
              }, t),
              h(
                'div',
                { style: styles.clockRow },
                h('span', { style: styles.label }, t('hour')),
                dropdown(t('hour'), openMenu, setOpenMenu, 'hour', opened.hour, hourOptions, (id) =>
                  patchPanel({ hour: id }),
                ),
                h('span', { style: styles.label }, t('minute')),
                dropdown(t('minute'), openMenu, setOpenMenu, 'minute', opened.minute, minuteOptions, (id) =>
                  patchPanel({ minute: id }),
                ),
              ),
            ),

        h('div', { style: { ...styles.hint, marginTop: '6px' } }, t('whenHint')),

        // The delivery axis, a harness dropdown rather than a native select.
        h(
          'div',
          { style: { ...styles.row, marginTop: '10px' } },
          h('span', { style: styles.label }, t('behavior')),
          h(primitives.Menu, {
            open: openMenu === 'behavior',
            align: 'start',
            portal: true,
            items: BEHAVIORS.map((value) => ({ id: value, label: behaviorLabel(value, t) })),
            selectedId: opened.behavior,
            onSelect: (id) => {
              patchPanel({ behavior: id })
              setOpenMenu(null)
            },
            onClose: () => setOpenMenu(null),
            anchor: h(
              primitives.Button,
              {
                variant: 'ghost',
                'aria-haspopup': 'menu',
                onClick: () => setOpenMenu(openMenu === 'behavior' ? null : 'behavior'),
              },
              behaviorLabel(opened.behavior, t),
            ),
          }),
        ),

        error ? h('div', { style: { ...styles.error, marginTop: '8px' } }, error) : null,

        h(
          'div',
          { style: { ...styles.row, marginTop: '10px' } },
          h(
            primitives.Button,
            {
              variant: 'primary',
              // An image-only hold is a message, so the empty-draft guard counts
              // the attachments too.
              disabled: busy || (opened.text.trim() === '' && windowAttachments.length === 0),
              onClick: submit,
            },
            opened.editingId === null ? t('create') : t('save'),
          ),
          h(primitives.Button, { variant: 'ghost', onClick: closePanel }, t('close')),
        ),
      )
    : null

  const hostNow = state.now + (Date.now() - state.fetchedAt)

  // The shipped queue strip's guard rail: one hold renders as itself, and two or
  // more fold into a count header that opens on demand.
  const rowCount = state.items.length
  const listVisible = rowCount === 1 || !collapsed

  const listNode = rowCount
    ? h(
        'div',
        { style: styles.card },
        rowCount > 1
          ? h(
              primitives.Button,
              {
                variant: 'ghost',
                style: styles.listHeader,
                'aria-expanded': listVisible,
                'aria-controls': LIST_ID,
                onClick: () => setCollapsed((value) => !value),
              },
              h('span', { style: styles.lead }, h(primitives.IconQueueOutline14, {})),
              h('span', { style: styles.count }, t('heldCount', { count: rowCount })),
              h(
                'span',
                { style: styles.chevron },
                listVisible ? h(primitives.IconChevronDownOutline14, {}) : h(primitives.IconChevronUpOutline14, {}),
              ),
            )
          : null,
        listVisible
          ? h(
              'div',
              { id: LIST_ID, style: styles.holdList },
              state.items.map((item) =>
                h(
                  'div',
                  { key: item.id, style: styles.holdRow },
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    item.text.trim() === '' ? null : h('div', { style: styles.holdText }, item.text),
                    attachmentRow(
                      (item.attachments ?? []).map((attachment, index) =>
                        heldAttachmentDisplay(attachment, `${item.id}-${index}`),
                      ),
                      t,
                    ),
                    h('div', { style: { ...styles.hint, marginTop: '4px' } }, holdMeta(item, hostNow, t)),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '6px', flexShrink: 0 } },
                    h(
                      primitives.Button,
                      {
                        variant: 'ghost',
                        icon: h(primitives.IconEditOutline16, { size: 14 }),
                        disabled: busy,
                        onClick: () =>
                          panel.set({
                            ...basePanel(),
                            open: true,
                            sessionId,
                            editingId: item.id,
                            text: item.text,
                            behavior: item.behavior,
                            attachments: item.attachments ?? [],
                            ...(item.at === null ? {} : calendarFor(item.at)),
                          }),
                      },
                      t('edit'),
                    ),
                    h(
                      primitives.Button,
                      {
                        variant: 'ghost',
                        icon: h(primitives.IconSendOutline14, {}),
                        disabled: busy,
                        onClick: () => act('release', item.id),
                      },
                      t('sendNow'),
                    ),
                    h(
                      primitives.Button,
                      {
                        variant: 'ghost',
                        icon: h(primitives.IconTrashOutline16, { size: 14 }),
                        disabled: busy,
                        onClick: () => act('cancel', item.id),
                      },
                      t('remove'),
                    ),
                  ),
                ),
              ),
            )
          : null,
      )
    : null

  // An empty wrapper would still occupy a row in the composer dock.
  if (windowNode === null && listNode === null) return null

  return h(
    'div',
    {
      style: styles.wrap,
      // The stylesheet above keys the picker cap to this marker, so nothing is
      // capped while the window is closed.
      ...(windowNode === null ? {} : { 'data-dsh-hold-window': '' }),
    },
    windowNode,
    listNode,
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx) {
  installStyles()

  const slots = ctx.get('slots')
  const locale = ctx.get('locale')

  if (!slots) {
    console.error('[hold] client apply aborted; slots=', Boolean(slots))
    return
  }

  // The connection and the conversation service are not part of the slot's
  // standard session face, so both are closed over here.
  slots.inject('conversation.input.right', () =>
    slots.register({ name: 'conversation.input.right', id: 'hold-button', order: 60 }, (props) =>
      h(HoldButton, { ...(props ?? {}), locale, connection: ctx.get('connection') }),
    ),
  )

  slots.inject('conversation.input.dock', () =>
    slots.register({ name: 'conversation.input.dock', id: 'hold-dock', order: 40 }, (props) =>
      h(HoldDock, {
        ...(props ?? {}),
        locale,
        connection: ctx.get('connection'),
        // Absent, the dock holds text only, exactly as it did before attachments.
        conversation: ctx.get('conversation'),
      }),
    ),
  )
}
