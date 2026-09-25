import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROVIDED_MODULES, buildClientBundle } from '../scripts/build-client.mjs'

const committed = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('the committed browser bundle matches the build script', () => {
  assert.equal(committed, buildClientBundle(), 'client.js has drifted from src/; run `node scripts/build-client.mjs`')
})

test('the bundle registers itself under its package name', () => {
  assert.match(committed, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(committed, /id: 'dsh-hold'/)
})

test('the bundle inlines its modules and keeps no module syntax', () => {
  assert.equal(/^\s*import\s/m.test(committed.replace(/^\/\*[\s\S]*?\*\//, '')), false)
  assert.equal(/^\s*export\s/m.test(committed), false)
  assert.match(committed, /BEHAVIORS/)
  assert.match(committed, /evaluateHold/)
})

test('the bundle asks the platform for React and the shipped primitives', () => {
  for (const name of PROVIDED_MODULES) {
    assert.ok(committed.includes(`require('${name}')`), `${name} must be required from the platform`)
  }
  assert.match(committed, /exports\.apply = plugin\.apply/)
  assert.match(committed, /exports\.inject = plugin\.inject/)
})

test('the bundle uses the shipped primitives rather than hand-rolled or native controls', () => {
  assert.match(committed, /primitives\.Button/)
  assert.match(committed, /primitives\.Menu/, 'the delivery choice must be the harness dropdown')
  assert.match(committed, /primitives\.Switch/, 'the send-at toggle must be the harness switch')
  assert.match(committed, /primitives\.IconQueueOutline14/)

  // A native select or date picker renders its popup with the OS theme, which does not match the shell.
  assert.equal(committed.includes("'select'"), false)
  assert.equal(committed.includes('datetime-local'), false)
})

test('the bundle caps the picker list, which the Menu portals out of reach', () => {
  // The shipped Menu bounds itself to the viewport, so a 24-hour or 60-minute list
  // fills the page. The list is portaled to the body, so the cap is scoped from there.
  assert.match(committed, /body:has\(\[data-dsh-hold-window\]\) > div\[role="menu"\]/)
  assert.match(committed, /max-height: min\(320px, 100vh - 96px\)/)
  assert.ok(committed.includes('data-plugin-css'), 'the tag must be marked the way the platform marks its own')
  assert.match(committed, /compact: true/)
})

test('the bundle takes the composer width rather than hiding the resize handles', () => {
  // The goal bar's recipe, so the dock follows the conversation's drag handle.
  assert.match(committed, /--dsh-composer-side-clearance/)
  assert.match(committed, /--dsh-composer-card-max-width/)
  assert.equal(
    committed.includes('data-conversation-composer-overlay'),
    false,
    'the handles must not be hidden while the window is open',
  )
})

test('the bundle carries the attachment path the conversation service provides', () => {
  // Staged attachments are read, serialized and released through the shipped
  // conversation service, never by reaching into the composer's own objects.
  assert.match(committed, /resolveDraftAttachments/)
  assert.match(committed, /serializeDraftAttachments/)
  assert.match(committed, /removeAttachment/)
  assert.match(committed, /parseAttachments/)
  assert.match(committed, /fileUploads/)
})

test('the bundle collapses a long held list the way the queue strip does', () => {
  assert.match(committed, /heldCount/)
  assert.match(committed, /IconChevronDownOutline14/)
  assert.match(committed, /IconChevronUpOutline14/)
  assert.match(committed, /maxHeight: '180px'/)
  // A filled row, and the width the shell reserves for a scrollbar.
  assert.match(committed, /background: 'var\(--dsw-alias-interactive-bg-hover\)'/)
  assert.match(committed, /--dsh-scrollbar-width, 8px/)
  // The header keeps a gap: its hover fill is the rows' own fill.
  assert.match(committed, /marginBottom: '6px'/)
})

test('the bundle carries no emoji and no Node-only dependency', () => {
  for (const forbidden of ["from 'node:", "require('node:", 'process.env']) {
    assert.equal(committed.includes(forbidden), false, `bundle must not reference ${forbidden}`)
  }
  // Any astral-plane or dingbat glyph would be an emoji in the UI.
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23F0}-\u{23FF}]/u.test(committed), false)
})

test('the bundle talks to the host over the channel the host serves', () => {
  assert.match(committed, /const CHANNEL = '\/dsh-hold'/)
})

test('the bundle registers the composer button and the held list, and no settings page', () => {
  assert.ok(committed.includes('conversation.input.right'))
  assert.ok(committed.includes('conversation.input.dock'))
  assert.equal(committed.includes('settings.section'), false)
})
