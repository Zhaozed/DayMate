// Structured-output tool helpers for the LLM agent step (Spec §12: agent
// reasoning only inside explicit agent steps). The model returns its decision
// by calling a designated output tool whose TypeBox `parameters` schema mirrors
// the authoritative Zod output schema; the runtime captures the args and
// validates them with Zod before returning (defence in depth).
//
// This module has NO runtime imports from the ESM-only agent packages — every
// import is `import type` (erased at build) — so it is safe to load from the
// CommonJS main process. The runtime `Type` builder and the TypeBox schema
// objects are produced by the model gateway (which dynamic-imports pi-ai) and
// passed in here.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TSchema, Static, TextContent } from '@earendil-works/pi-ai'

/** Mutable box the output tool writes its captured args into. */
export interface CaptureBox<T = unknown> {
  value: T | undefined
}

/**
 * Structural subset of the TypeBox `Type` builder. The real `Type` (re-exported
 * by pi-ai) satisfies this; declaring the subset here keeps the module free of
 * runtime imports. Used by `buildOutputSchemas`, which is pure logic.
 */
export interface TypeBuilder {
  Object(props: Record<string, TSchema>, options?: Record<string, unknown>): TSchema
  Array(schema: TSchema): TSchema
  String(): TSchema
  Number(): TSchema
  Boolean(): TSchema
  Optional(schema: TSchema): TSchema
  Union(schemas: readonly TSchema[]): TSchema
  Literal(value: string | number): TSchema
  Null(): TSchema
  Record(key: TSchema, val: TSchema): TSchema
  Unknown(): TSchema
}

/** The TypeBox output-tool parameter schemas, keyed by action. */
export interface OutputSchemas {
  submit_brief: TSchema
  submit_classifications: TSchema
  submit_meeting_prep: TSchema
  submit_work_summary: TSchema
  submit_draft_reply: TSchema
  submit_resume: TSchema
  submit_interview_transcript: TSchema
  submit_application_email_classifications: TSchema
  submit_funnel_review: TSchema
  submit_score_job_matches: TSchema
  submit_daily_fortune: TSchema
}

/**
 * Build the TypeBox parameter schemas that mirror the authoritative Zod output
 * schemas (`morningBriefOutputSchema` / `classifyInboxOutputSchema`). The model
 * must call the matching tool with args matching this shape; the runtime then
 * re-validates with Zod. `Type` is the runtime builder from pi-ai.
 */
export function buildOutputSchemas(Type: TypeBuilder): OutputSchemas {
  const sourceRef = Type.Object({
    type: Type.Union([
      Type.Literal('email'),
      Type.Literal('calendar'),
      Type.Literal('task'),
      Type.Literal('activity')
    ]),
    id: Type.String(),
    label: Type.Optional(Type.String())
  })
  const suggestedAction = Type.Object({
    label: Type.String(),
    toolName: Type.Optional(Type.String()),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  })
  const memoryProposal = Type.Object({
    key: Type.Union([
      Type.Literal('email_tone'),
      Type.Literal('writing_style'),
      Type.Literal('persona'),
      Type.Literal('working_hours'),
      Type.Literal('meeting_duration'),
      Type.Literal('contact'),
      Type.Literal('project'),
      Type.Literal('notification_prefs'),
      Type.Literal('other')
    ]),
    value: Type.String()
  })
  const taskPriority = Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('urgent')
  ])
  const briefPriority = Type.Union([
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('urgent')
  ])
  const classification = Type.Union([
    Type.Literal('reply'),
    Type.Literal('follow_up'),
    Type.Literal('information'),
    Type.Literal('ignore')
  ])
  const topic = Type.Union([
    Type.Literal('fees_billing'),
    Type.Literal('recruiting'),
    Type.Literal('ads'),
    Type.Literal('meeting'),
    Type.Literal('general')
  ])

  const submit_brief = Type.Object({
    title: Type.String(),
    summary: Type.String(),
    reason: Type.String(),
    priority: briefPriority,
    sourceRefs: Type.Array(sourceRef),
    suggestedActions: Type.Array(suggestedAction),
    taskToCreate: Type.Union([
      Type.Object({
        title: Type.String(),
        sourceId: Type.String(),
        priority: taskPriority
      }),
      Type.Null()
    ]),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  const submit_classifications = Type.Object({
    results: Type.Array(
      Type.Object({
        provider: Type.Union([Type.Literal('gmail'), Type.Literal('mail163')]),
        accountId: Type.String(),
        messageId: Type.String(),
        classification,
        topic,
        untrusted: Type.Boolean(),
        reason: Type.String(),
        suggestedAction: Type.Optional(suggestedAction)
      })
    ),
    counts: Type.Object({
      reply: Type.Number(),
      follow_up: Type.Number(),
      information: Type.Number(),
      ignore: Type.Number()
    }),
    topicCounts: Type.Object({
      fees_billing: Type.Number(),
      recruiting: Type.Number(),
      ads: Type.Number(),
      meeting: Type.Number(),
      general: Type.Number()
    }),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  // Publishable brief fields shared by meeting prep / work summary.
  const publishable = {
    title: Type.String(),
    summary: Type.String(),
    reason: Type.String(),
    priority: briefPriority,
    sourceRefs: Type.Array(sourceRef),
    suggestedActions: Type.Array(suggestedAction)
  }

  const submit_meeting_prep = Type.Object({
    ...publishable,
    objective: Type.String(),
    context: Type.Array(Type.String()),
    questions: Type.Array(Type.String()),
    openActions: Type.Array(Type.String()),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  const submit_work_summary = Type.Object({
    ...publishable,
    processedEmails: Type.Number(),
    tasksCreated: Type.Number(),
    tasksCompleted: Type.Number(),
    meetingsAttended: Type.Number(),
    waitingItems: Type.Array(Type.String()),
    tomorrowHighlights: Type.Array(Type.String()),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  const mailAddressT = Type.Object({
    name: Type.Optional(Type.String()),
    address: Type.String()
  })
  const submit_draft_reply = Type.Object({
    to: Type.Array(mailAddressT),
    subject: Type.String(),
    body: Type.String(),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  // ── Milestone A: resume / transcript / application-email classification ──────
  const submit_resume = Type.Object({
    html: Type.String(),
    summary: Type.String(),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  const submit_interview_transcript = Type.Object({
    html: Type.String(),
    selfIntro: Type.String(),
    starProjects: Type.Array(
      Type.Object({
        title: Type.String(),
        situation: Type.String(),
        task: Type.String(),
        action: Type.String(),
        result: Type.String()
      })
    ),
    commonQA: Type.Array(
      Type.Object({
        question: Type.String(),
        answer: Type.String()
      })
    ),
    reverseQuestions: Type.Array(Type.String()),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  const applicationEventType = Type.Union([
    Type.Literal('applied'),
    Type.Literal('communicated'),
    Type.Literal('assessment'),
    Type.Literal('written_test'),
    Type.Literal('interview'),
    Type.Literal('offer'),
    Type.Literal('rejected'),
    Type.Literal('withdrawn')
  ])
  const confidence = Type.Union([
    Type.Literal('high'),
    Type.Literal('medium'),
    Type.Literal('low')
  ])
  const submit_application_email_classifications = Type.Object({
    results: Type.Array(
      Type.Object({
        messageId: Type.String(),
        eventType: applicationEventType,
        company: Type.Optional(Type.String()),
        position: Type.Optional(Type.String()),
        confidence,
        evidence: Type.String(),
        untrusted: Type.Boolean()
      })
    ),
    matched: Type.Number(),
    pending: Type.Number(),
    ignored: Type.Number()
  })

  // ── Milestone B: funnel review (descriptive recap) ──────────────────────────
  const submit_funnel_review = Type.Object({
    ...publishable,
    highlights: Type.Array(Type.String()),
    riskApps: Type.Array(
      Type.Object({
        company: Type.String(),
        position: Type.Optional(Type.String()),
        issue: Type.String()
      })
    ),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  // ── Milestone C: score job matches ───────────────────────────────────────────
  // PublishableBrief shape + `results` (per-job score/reason). Publishable to
  // NTK via `need_to_know fromKey`; the renderer lists `results`.
  const jobTier = Type.Union([
    Type.Literal('high'),
    Type.Literal('medium'),
    Type.Literal('low'),
    Type.Literal('skip')
  ])
  const submit_score_job_matches = Type.Object({
    ...publishable,
    results: Type.Array(
      Type.Object({
        securityId: Type.String(),
        jobName: Type.String(),
        companyName: Type.String(),
        score: Type.Number(),
        tier: jobTier,
        reasons: Type.Array(Type.String()),
        recommend: Type.Boolean(),
        salary: Type.Optional(Type.String()),
        city: Type.Optional(Type.String())
      })
    ),
    memoryProposals: Type.Optional(Type.Array(memoryProposal))
  })

  // Milestone E — daily 运势 output (NOT a PublishableBrief; never NTK).
  const submit_daily_fortune = Type.Object({
    title: Type.String(),
    summary: Type.String(),
    tip: Type.String(),
    mood: Type.Number()
  })

  return {
    submit_brief,
    submit_classifications,
    submit_meeting_prep,
    submit_work_summary,
    submit_draft_reply,
    submit_resume,
    submit_interview_transcript,
    submit_application_email_classifications,
    submit_funnel_review,
    submit_score_job_matches,
    submit_daily_fortune
  }
}

/**
 * Create an `AgentTool` that simply records the validated tool-call args into
 * `box.value` and tells the agent loop to stop (`terminate: true`). The model's
 * "final answer" IS the call to this tool.
 *
 * `TParams` is the TypeBox schema built at runtime in the gateway (where the
 * `Type` builder is available); `parameters` is that runtime object.
 */
export function createCaptureTool<TParams extends TSchema>(
  name: string,
  description: string,
  parameters: TParams,
  box: CaptureBox
): AgentTool<TParams, Static<TParams>> {
  return {
    name,
    label: name,
    description,
    parameters,
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      params: Static<TParams>,
      _signal?: AbortSignal,
      _onUpdate?: (partial: AgentToolResult<Static<TParams>>) => void
    ): Promise<AgentToolResult<Static<TParams>>> {
      box.value = params
      const content: TextContent[] = [{ type: 'text', text: 'recorded' }]
      return { content, details: params, terminate: true }
    }
  }
}
