// One synchronous snapshot of a session's live work, read from in-memory
// registries only. The live-agent walk covers continuable children, which are
// never jobs, and the job registry covers background tasks.

const TERMINAL_JOB_STATUSES = new Set(['completed', 'killed', 'failed'])

const isLiveJob = (snapshot) => !TERMINAL_JOB_STATUSES.has(snapshot?.status)

// Runtime ownership rather than durable session lineage, because it is what
// resolves for continuable children.
const runningSubtree = (registry, rootId) => {
  if (typeof registry?.list !== 'function' || typeof registry?.isOwnedBy !== 'function') return null

  const agents = registry.list()
  const childrenOf = new Map()

  for (const candidate of agents) {
    if (candidate.id === rootId) continue
    for (const possibleParent of agents) {
      if (possibleParent.id === candidate.id) continue
      let owned = false
      try {
        owned = registry.isOwnedBy(candidate.id, possibleParent) === true
      } catch {
        owned = false
      }
      if (!owned) continue
      const siblings = childrenOf.get(possibleParent.id) ?? []
      siblings.push(candidate.id)
      childrenOf.set(possibleParent.id, siblings)
      break
    }
  }

  const running = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
      const agent = registry.get(child)
      if (agent !== undefined && agent.status === 'running') running.push(child)
    }
  }
  return running
}

export const createWorld = ({ ctx, report = () => {} }) => {
  const service = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  // An absent agent short-circuits, because nothing else is knowable.
  const sample = (sessionId) => {
    const registry = service('agents')
    const agent = registry?.get?.(sessionId)

    if (agent === undefined) {
      return { agent: 'absent', subagents: { running: 0, ids: [] }, jobs: { running: 0, ids: [] } }
    }

    const subagents = runningSubtree(registry, sessionId) ?? []

    let jobs = []
    const jobService = service('jobs')
    if (typeof jobService?.list === 'function') {
      try {
        jobs = (jobService.list(agent) ?? []).filter(isLiveJob).map((snapshot) => snapshot.id)
      } catch (error) {
        report('job sample failed', { message: String((error && error.message) || error) })
      }
    }

    return {
      agent: agent.status,
      subagents: { running: subagents.length, ids: subagents },
      jobs: { running: jobs.length, ids: jobs },
    }
  }

  return { sample }
}
