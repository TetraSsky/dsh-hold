# dsh-hold

Hold a drafted message until the session is **actually** finished, then send it.

The harness already queues a message you send while the agent is working, and it
releases that queue as soon as the main agent stops talking. That is not the same
as being done: a subagent and a background job are invisible to the composer, so
the queue hands your message over while real work is still in flight. `dsh-hold`
adds the missing option, **wait until nothing is running at all**, and it holds
the message on the host, so closing the tab does not lose it.

This is a standalone plugin. It reads and writes only its own file and depends on
no other plugin.

## Requirements

- DeepSeek Harness with the web profile.
- Nothing else. Without the job or subagent service the corresponding check simply
  reports nothing running.

## Install

```sh
dsh plugin --profile web add github:TetraSsky/dsh-hold
```

Then add `dsh-hold` to `dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json`
and restart. The package's `cordis.patch.yml` inserts its own row.

## The button

A **Hold** button sits in the composer tool row, next to the send action. It uses
the harness' own `Button` and queue glyph, so it looks like the controls around it.

Type a message, click **Hold**, and a window opens over the composer with two
independent choices:

| Axis | Control |
|---|---|
| **Send at** | A switch. Off, which is the default, means no earliest time, so the message goes as soon as it can. On reveals a calendar and two time dropdowns. |
| **If the AI is still working** | A dropdown: **Queue (Default)** · **Wait idle** · **Send now (Steer)** |

The date is chosen from a calendar rather than typed, and the hour and minute are
picked from two dropdowns, so a typo cannot produce a nonsense instant. **Days before
today are disabled**, which is the guard-rail. There is a second one at confirmation:
a chosen time that has already passed is refused in the window and never sent.

The two time lists are **capped** rather than left to the shipped `Menu`'s own bound,
which is the viewport: 24 hours or 60 minutes at that height is a full-page column, not
a picker. The cap is one small stylesheet the bundle installs, keyed to a marker the
window carries only while it is open, so nothing else on the page is affected. Rows are
the `compact` variant, which is what fits the most values in the capped list.

The axes combine. `Next month, the 15th at 09:30` with **Wait idle** means: at that
time, if the session is still going, keep waiting until it is complete, then send. An
unset time with **Wait idle** is the headline case, the one the harness' own queue
cannot express.

The window's controls are harness primitives (`Button`, `Switch`, `Menu`) and the
calendar is built from those same buttons. The message field is a plain multi-line
textarea, because the shipped `Input` is single-line. No native `<select>` or date
picker is used anywhere, because those draw their popup with the operating system's
theme instead of the shell's.

The held list and the window take the composer's own width, the same recipe the
shipped goal bar and queue strip use, so they are as wide as the chat content and
**follow the conversation's drag handle** when it is moved. That width sits inside the
resize handles rather than across them, so no handle has to be hidden while the window
is open.

Confirming takes the message out of the composer and into the held list. The three
behaviours are the harness' own vocabulary:

- **Queue (Default)** is an ordinary follow-up turn, which is what the composer's queue
  does.
- **Wait idle** is the same delivery, but only once the session is complete.
- **Send now (Steer)** is taken at the nearest step boundary. Against an idle agent this
  is the same as queueing, which is the harness' own rule, so it never steers a sleeping
  agent.

## What "finished" means

Three things must be true, all read from in-memory registries at the moment of
evaluation:

| Check | Source |
|---|---|
| No main agent running | `agent.status`. `running` spans the whole turn, every tool call included, so `idle` really does mean the agent stopped talking |
| No live subagent | live agents owned by this session whose status is still `running` |
| No background job | `ctx.jobs.list(agent)`, excluding `completed` / `killed` / `failed` |

A continuable subagent is deliberately judged by its agent's `status`, not by
whether it is resident: a settled child stays resident after its turn ends, so
residency would hold a message forever.

**Nothing waiting on you is already covered.** A pending approval, question, or plan
review keeps the turn open. `dsh-user-approval` documents that "the request requires
an open turn", and `ask_user_question` and `exit_plan_mode` are ordinary tool calls
whose result the driver is still awaiting. So the main agent reads `running` for the
whole time it is blocked on you, and no separate check is needed.

A session with no live agent is never finished: the message is **kept**, not dropped,
and delivered once that session is running again.

## The held list

Held messages for the current session appear above the composer. There is no limit on
how many you hold, so the list uses the shipped queue strip's own guard rail: **one**
hold renders as itself, and **two or more fold into a `{n} held messages` header** with
the queue glyph and a chevron. Opening it lists every hold, and that open list is
capped at 180px and scrolls rather than growing, so twenty holds are one header and a
scroll box, never twenty stacked rows.

Every row offers:

- **Edit** reopens the window with that message's text, its attachments and both axes,
  and saves.
- **Send now** delivers immediately, ignoring what it was waiting for.
- **Delete** drops it without sending.

Each row also says what it is waiting for ("Waiting on the main agent, a background
job") or that it is ready, and counts down when it has a time.

**Order.** Several holds that come due together go out one at a time, oldest first. A
**Wait idle** hold that has just been delivered puts the session back to work, so the
next one waits for the next completion instead of landing on top of it. A **Queue
(Default)** or **Send now (Steer)** hold is not gated on anything, so those all go out
in the same pass, still oldest first. Two holds set for the same instant behave the
same way: the time axis decides when a hold becomes ready, not how many go at once.

## Languages

The window follows the interface language, English or Chinese, and so does every
refusal it shows. The host answers in English, so a code the browser has a sentence for
is replaced by that sentence, and only a code it does not recognise is shown as the
host worded it.

## Attachments

A hold carries what the composer has staged, images and files alike. The window lists
them above the time axis, and any of them can be dropped before holding.

- **An image** is held as its own bytes. That is what lets the row show its thumbnail
  while the message does not exist yet, because the harness will not serve an image the
  session has not cited. It is admitted into the harness' durable attachment
  storage at delivery, through the same `admitPromptContent` call its own prompt
  endpoint uses.
- **A file** is held as the durable reference its upload was already resolved to.
  A staged file travels as the receipt its upload minted, and that receipt does not
  outlive the draft, so the host resolves it to the reference the moment the hold is
  made. If it can no longer be resolved, the hold is **refused** rather than stored
  without its file.

Once a hold owns an attachment it is removed from the composer's rail, so it cannot
ride along with the next message sent from there. Editing a hold keeps its
attachments and lets you drop one. Adding new ones means staging them in the composer
and holding again.

Holding is refused, with the reason, while a file is still uploading or after an
upload has failed, the same states in which the composer itself will not send.

`@` references need no special handling and never did: `@file` is literal text the
system prompt explains, `@session` is resolved by a host pre-step hook over any direct
user message, and the reference codec is identity, so the draft a hold captures is
the exact text a send would have used.

## Persistence

The queue is one JSON file at `$DSH_HOME/hold-queue.json`, written temp-and-rename.
It stores what to send, where, when, and how, never delivery state. On restart the
queue is restored. Unloading the plugin clears the in-memory view and leaves the
durable records alone: unloading is not cancellation.

## No settings

There is nothing to configure, and the plugin registers no settings namespace. It
always waits for all three checks, and every choice is made per message in the
window.

## Known limits

- **The host process must be running.** A hold fires on the host. A stopped `dsh`
  process sends nothing and the queue is delivered after the next start.
- **A released message is an ordinary user message.** It is delivered through the
  same path as a real send (`agent.followup`, or `agent.steer` while running), so it
  renders as your own bubble and carries no marker saying it was held.
- **Attachments have a budget.** The harness lets one message carry 200 MB of images, but
  a hold is a JSON file the host rewrites on every change, so it takes 20 MB per image
  and 32 MB across the hold, and refuses beyond that with the reason. A hold with an
  attachment needs the harness' attachment and upload services. Without them a file is
  refused rather than stored without it.
- **One-shot.** A hold fires once. Recurring reminders are
  `@deepseek-ai/dsh-schedule`'s job.
- **The subagent check degrades.** Without the agent ownership API the live-agent
  walk is unavailable and no subagent is reported, so a hold can release while a
  child is still running. The main agent and job checks are unaffected.
- **No cross-session view.** The held list shows the current session. Holds in other
  sessions are delivered normally but are not listed anywhere.

## Development

```sh
npm test            # 203 tests
npm run build       # regenerate client.js after editing src/client.js
```

The suite includes `tests/integration.test.mjs`, which drives the real generated
browser bundle against the real host gate through a **JSON-serialized** RPC, the way
Connection carries it: compose a hold, watch it wait for a running agent and a
background job, then release it and see it arrive as an ordinary user message.

`tests/harness.mjs` holds the shared test scaffolding: a React stand-in, stand-ins
for the shipped primitives, and the tree walkers.

The browser bundle is generated: `scripts/build-client.mjs` inlines the shared
modules into `client.js`, which is what lets the browser load one file with no import
graph. `tests/bundle.test.mjs` fails if the committed bundle has drifted from `src/`.

Layout:

| Path | Role |
|---|---|
| `index.js` | Host entry: queue, gate, and the RPC route |
| `src/hold.js` | Pure model: validation, the busy reasons, the release decision |
| `src/world.js` | One synchronous snapshot of a session's live work |
| `src/gate.js` | The hold engine: tick, deliver, edit, cancel, restore |
| `src/queue.js` | Durable queue, temp-and-rename |
| `src/deliver.js` | Message construction and the queue/steer verb |
| `src/rpc.js` | `/dsh-hold` route behind Connection's request fence |
| `src/client.js` | Browser half: the button, the window, the held list |
| `src/i18n.js` | English and Chinese strings |

## License

MIT
