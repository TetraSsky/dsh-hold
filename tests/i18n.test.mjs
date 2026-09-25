import test from 'node:test'
import assert from 'node:assert/strict'
import { dictionaries, fallbackLocale, translate } from '../src/i18n.js'

const locales = Object.keys(dictionaries)

test('the fallback locale is a shipped dictionary', () => {
  assert.ok(locales.includes(fallbackLocale))
})

test('every locale ships the same key set', () => {
  const reference = Object.keys(dictionaries[fallbackLocale]).sort()
  for (const locale of locales) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), reference, `locale ${locale} is out of step`)
  }
})

test('every message is a non-empty string', () => {
  for (const locale of locales) {
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key}`)
      assert.ok(value.trim() !== '', `${locale}.${key} is blank`)
    }
  }
})

test('the Chinese dictionary is translated rather than copied', () => {
  const english = dictionaries[fallbackLocale]
  const chinese = dictionaries.zh
  const identical = Object.keys(english).filter((key) => english[key] === chinese[key])
  assert.ok(identical.length < Object.keys(english).length * 0.1, `untranslated: ${identical.join(', ')}`)
})

test('placeholder sets match across locales', () => {
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(dictionaries[fallbackLocale])) {
    const reference = names(dictionaries[fallbackLocale][key])
    for (const locale of locales) {
      assert.deepEqual(names(dictionaries[locale][key]), reference, `${locale}.${key} placeholders differ`)
    }
  }
})

test('translation substitutes named variables and falls back safely', () => {
  assert.equal(translate('en', 'waitingOn', { reasons: 'a subagent' }), 'Waiting on a subagent')
  assert.equal(translate('de', 'buttonLabel'), dictionaries[fallbackLocale].buttonLabel)
  assert.equal(translate('zh-CN', 'buttonLabel'), dictionaries.zh.buttonLabel)
  assert.equal(translate('en', 'no.such.key'), 'no.such.key')
})

test('no message carries an emoji', () => {
  for (const locale of locales) {
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      assert.equal(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23F0}-\u{23FF}]/u.test(value),
        false,
        `${locale}.${key} contains an emoji`,
      )
    }
  }
})
