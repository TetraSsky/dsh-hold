import { createUserMessage } from '@deepseek-ai/dsh-llm'

// The harness' own prompt content shapes: text, an image as encoded bytes, and a
// file as an already resolved durable reference.
export const holdParts = (record) => {
  const parts = []
  if (record.text.trim() !== '') parts.push({ type: 'text', text: record.text })

  for (const attachment of record.attachments ?? []) {
    if (attachment.kind === 'image') {
      parts.push({
        type: 'image',
        mediaType: attachment.mediaType,
        data: attachment.data,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
      })
    } else {
      parts.push({ type: 'file', attachment: attachment.attachment })
    }
  }

  return parts
}

// Images are admitted into durable storage here, the way the harness' prompt
// endpoint does it, so they are not carried as bytes any longer than necessary.
export const buildHeldMessage = async (record, { attachments } = {}) => {
  const parts = holdParts(record)
  if (!parts.some((part) => part.type !== 'text')) {
    return createUserMessage({ content: parts, source: { kind: 'user' } })
  }
  if (attachments === undefined || attachments === null) {
    throw new Error('the attachments service is unavailable')
  }

  const content = await attachments.admitPromptContent(parts)
  return createUserMessage({ content, source: { kind: 'user' } })
}

// Steer only means anything against a running agent. Against an idle one the
// harness' own rule is to queue, so an idle agent always takes the queue path.
export const deliverHeld = ({ agent, message, behavior }) => {
  if (behavior === 'steer' && agent.status === 'running') {
    agent.steer(message)
    return { mode: 'steer' }
  }
  agent.followup(message)
  return { mode: 'queue' }
}
