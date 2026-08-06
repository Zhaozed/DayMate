// Agent runtime — the seam where model reasoning lives (Spec §12: agent
// reasoning only inside explicit agent steps).
//
// M1 ships a DETERMINISTIC stub: `generate_morning_brief` produces a canned
// brief from the tool outputs. This lets the Routine Engine run end-to-end
// without an LLM. The real `@earendil-works/pi-agent-core` + `pi-ai` adapter is
// wired in M3. The contract (action name in, structured output out) stays the
// same, so the engine does not change when the stub is replaced.
//
// Security note (Spec §17): email content is UNTRUSTED input. The stub reads
// message bodies for summarization but never treats them as instructions. The
// prompt-injection fixture (SPAM label) is classified as untrusted and ignored.

import type {
  NormalizedEmail,
  CalendarEvent,
  Task,
  SourceRef,
  SuggestedAction,
  EmailClassification,
  EmailClassificationResult
} from '@shared/types'

export interface MorningBriefOutput {
  title: string
  summary: string
  reason: string
  priority: 'medium' | 'high' | 'urgent'
  sourceRefs: SourceRef[]
  suggestedActions: SuggestedAction[]
  taskToCreate: { title: string; sourceId: string; priority: 'low' | 'medium' | 'high' | 'urgent' } | null
}

export interface AgentStepInput {
  emails?: NormalizedEmail[]
  events?: CalendarEvent[]
  tasks?: Task[]
}

/** Input for the Auto Inbox classifier — one array per provider (Spec §13.2). */
export interface ClassifyInboxInput {
  gmailEmails?: NormalizedEmail[]
  mail163Emails?: NormalizedEmail[]
  emails?: NormalizedEmail[]
}

export interface ClassifyInboxOutput {
  results: EmailClassificationResult[]
  /** Counts per bucket, for the Activity summary. */
  counts: Record<EmailClassification, number>
}

type AgentInputs = Record<string, unknown>

export async function runAgentStep(action: string, input: AgentInputs): Promise<unknown> {
  if (action === 'generate_morning_brief') {
    return generateMorningBrief(input as AgentStepInput)
  }
  if (action === 'classify_inbox') {
    return classifyInbox(input as ClassifyInboxInput)
  }
  throw new Error(`Unknown agent action: ${action}`)
}

function isUntrusted(email: NormalizedEmail): boolean {
  // Spam-labeled mail, or mail containing injection markers, is untrusted.
  if (email.labels.includes('SPAM')) return true
  const body = email.textBody.toLowerCase()
  return (
    body.includes('ignore previous instructions') ||
    body.includes('reveal your system prompt') ||
    body.includes('automatically reply without asking') ||
    body.includes('reply with your') ||
    body.includes('forward this to all')
  )
}

/** Deterministic Auto Inbox classifier (Spec §13.2). Real LLM classification is M3. */
function classifyInbox(input: ClassifyInboxInput): ClassifyInboxOutput {
  const all = [...(input.gmailEmails ?? []), ...(input.mail163Emails ?? []), ...(input.emails ?? [])]

  // Dedupe by (provider, accountId, messageId) — a re-run never re-classifies
  // the same message (Spec §12.6 idempotency).
  const seen = new Set<string>()
  const results: EmailClassificationResult[] = []
  const counts: Record<EmailClassification, number> = { reply: 0, follow_up: 0, information: 0, ignore: 0 }

  for (const email of all) {
    const key = `${email.provider}:${email.accountId}:${email.messageId}`
    if (seen.has(key)) continue
    seen.add(key)

    // Untrusted content is ALWAYS ignore + untrusted — never produces a task,
    // draft, or send (Spec §17).
    if (isUntrusted(email)) {
      results.push({
        provider: email.provider,
        accountId: email.accountId,
        messageId: email.messageId,
        classification: 'ignore',
        untrusted: true,
        reason: 'SPAM / prompt-injection content — ignored'
      })
      counts.ignore++
      continue
    }

    const subject = email.subject.toLowerCase()
    const body = email.textBody.toLowerCase()
    const wantsReply =
      /reply|following up|follow up|confirmation|please (confirm|reply)|need your|decision needed/.test(subject) ||
      /please reply|following up|need your|confirmation|by (today|friday|monday|tomorrow)|asap/.test(body)

    if (wantsReply) {
      const isFollowUp = /following up|follow up|need your|confirmation/.test(subject + ' ' + body)
      const classification: EmailClassification = isFollowUp ? 'follow_up' : 'reply'
      results.push({
        provider: email.provider,
        accountId: email.accountId,
        messageId: email.messageId,
        classification,
        untrusted: false,
        reason: isFollowUp ? 'Sender is following up — a reply is expected' : 'Sender expects a reply',
        suggestedAction: {
          label: `Reply to ${email.from.name ?? email.from.address}`,
          toolName: 'email.create_draft',
          args: {
            accountId: email.accountId,
            threadId: email.threadId,
            to: [{ address: email.from.address, name: email.from.name }],
            subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
            body: 'Thanks — I will review and get back to you shortly.'
          }
        }
      })
      counts[classification]++
      continue
    }

    // Pure FYI / informational.
    const isFyi = /for your information|fyi|no action required|for your reference/.test(subject + ' ' + body)
    results.push({
      provider: email.provider,
      accountId: email.accountId,
      messageId: email.messageId,
      classification: 'information',
      untrusted: false,
      reason: isFyi ? 'Informational — no action required' : 'No reply expected'
    })
    counts.information++
  }

  return { results, counts }
}

function generateMorningBrief(input: AgentStepInput): MorningBriefOutput {
  const emails = input.emails ?? []
  const events = input.events ?? []
  const tasks = input.tasks ?? []

  // Only trust non-spam unread mail for action extraction.
  const actionable = emails.filter((e) => !isUntrusted(e))

  // Pick the first unread actionable email as the priority.
  const priorityEmail = actionable.find((e) => e.unread) ?? actionable[0] ?? undefined

  const sourceRefs: SourceRef[] = []
  if (priorityEmail) {
    sourceRefs.push({
      type: 'email',
      id: priorityEmail.messageId,
      label: `${priorityEmail.from.name ?? priorityEmail.from.address} — ${priorityEmail.subject}`
    })
  }
  const firstEvent = events[0]
  if (firstEvent) {
    sourceRefs.push({
      type: 'calendar',
      id: firstEvent.eventId,
      label: `${firstEvent.title} @ ${new Date(firstEvent.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    })
  }
  for (const t of tasks.slice(0, 3)) {
    if (t.status !== 'done' && t.status !== 'dismissed') {
      sourceRefs.push({ type: 'task', id: t.id, label: t.title })
    }
  }

  const suggestedActions: SuggestedAction[] = []
  let taskToCreate: MorningBriefOutput['taskToCreate'] = null

  if (priorityEmail) {
    suggestedActions.push({
      label: `Review & reply to ${priorityEmail.from.name ?? priorityEmail.from.address}`,
      toolName: 'email.create_draft',
      args: {
        accountId: priorityEmail.accountId,
        threadId: priorityEmail.threadId,
        to: [{ address: priorityEmail.from.address, name: priorityEmail.from.name }],
        subject: `Re: ${priorityEmail.subject}`,
        body: 'Thanks — I will review and get back by Friday.'
      }
    })
    taskToCreate = {
      title: `Decision needed: ${priorityEmail.subject}`,
      sourceId: priorityEmail.messageId,
      priority: 'high'
    }
  }

  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dismissed')

  return {
    title: 'Morning Brief',
    summary: priorityEmail
      ? `Today's priority: ${priorityEmail.subject} (${priorityEmail.from.name ?? priorityEmail.from.address} needs a decision). ${firstEvent ? `Next meeting: ${firstEvent.title}.` : ''} ${openTasks.length} open task(s).`
      : `Inbox clear. ${firstEvent ? `Next meeting: ${firstEvent.title}.` : ''} ${openTasks.length} open task(s).`,
    reason: priorityEmail
      ? `${priorityEmail.from.name ?? priorityEmail.from.address} needs your response; flagged as high priority.`
      : 'No actionable unread mail this morning.',
    priority: priorityEmail ? 'high' : 'medium',
    sourceRefs,
    suggestedActions,
    taskToCreate
  }
}
