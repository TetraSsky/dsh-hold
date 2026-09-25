import { readdirSync } from 'node:fs'

const dir = new URL('.', import.meta.url)
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const name of files) await import(new URL(name, dir).href)
