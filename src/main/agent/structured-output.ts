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
  submit_classifications: TSchema
  submit_interview_transcript: TSchema
  submit_application_email_classifications: TSchema
  submit_funnel_review: TSchema
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
      Type.Literal('job_search_profile'),
      Type.Literal('other')
    ]),
    value: Type.String()
  })
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
        suggestedAction: Type.Optional(suggestedAction),
        // ADR 0026 — when the email implies a concrete, useful next action,
        // the model fills todoTitle (an easy-to-understand ToDo phrase). Leaving
        // it empty = no useful action = no ToDo is created. dueDate (ISO date)
        // only when the email states a concrete date/deadline/interview time.
        todoTitle: Type.Optional(Type.String()),
        dueDate: Type.Optional(Type.String()),
        // ADR 0027 — coarse domain tag (学校/求职/账单/会议/其他). The model
        // fills this from the mail content; absence falls back to a topic-derived
        // value in the deterministic stub.
        category: Type.Optional(
          Type.Union([
            Type.Literal('school'),
            Type.Literal('job'),
            Type.Literal('bill'),
            Type.Literal('meeting'),
            Type.Literal('other')
          ])
        )
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
        jobCode: Type.Optional(Type.String()),
        jdExcerpt: Type.Optional(Type.String()),
        city: Type.Optional(Type.String()),
        salary: Type.Optional(Type.String()),
        confidence,
        evidence: Type.String(),
        untrusted: Type.Boolean(),
        // ADR 0026 — todoTitle only when the email implies a concrete next action
        // (e.g. an interview/笔试 notice). dueDate only when a concrete date is
        // stated. Empty todoTitle = no ToDo created (the "no useless ToDo" rule).
        todoTitle: Type.Optional(Type.String()),
        dueDate: Type.Optional(Type.String()),
        // ADR 0027 — domain tag for the funnel ToDo (always 'job').
        category: Type.Optional(
          Type.Union([
            Type.Literal('school'),
            Type.Literal('job'),
            Type.Literal('bill'),
            Type.Literal('meeting'),
            Type.Literal('other')
          ])
        ),
        round: Type.Optional(Type.String()),
        isReschedule: Type.Optional(Type.Boolean()),
        isCancelled: Type.Optional(Type.Boolean()),
        meetingInfo: Type.Optional(Type.String()),
        isAdjusted: Type.Optional(Type.Boolean()),
        adjustedPosition: Type.Optional(Type.String()),
        isJobRelated: Type.Optional(Type.Boolean())
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
  return {
    submit_classifications,
    submit_interview_transcript,
    submit_application_email_classifications,
    submit_funnel_review
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
