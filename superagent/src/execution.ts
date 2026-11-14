import { createHash, randomUUID } from 'node:crypto'
import { CoreError, identifier, type Work } from './model.js'
import type { Storage, AsyncTx } from './storage.js'
import type { Effects, Effect, EffectHandler, EffectResult } from './effects.js'
import type { NativeSessions, NativeTool } from './native-sessions.js'
import { LocalSetupError, type RemoteJobObservation } from './local-environment.js'
import { environmentCommandNames, environmentHasCommand, environmentLocation, sameEnvironment,
  type EnvironmentLocation, type ExecutionEnvironment, type PreparedEnvironment } from './environment.js'
import { commandTransaction } from './commands.js'
import { deliveryMessageId, type WorkInput, type WorkInputs, type WorkOwnership } from './work-inputs.js'
import type { Attention, Attentions } from './attention.js'
import type { SourceEvents } from './source-events.js'
import type { Slots, SlotActivation } from './slots.js'
import { Jobs, type JobRecord, type JobView } from './jobs.js'
import { Previews, type PreviewView } from './previews.js'
import { Subagents, type SubagentRecord, type SubagentView } from './subagents.js'
import { type Deliveries, type DeliveryView } from './deliveries.js'
import type { ContextKind, ContextReader } from './context.js'
import type { RoleConfigStore } from './config.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionPolicyStore, loadExecutionSelection, saveExecutionSelection, selectExecutionTarget } from './execution-target.js'
import { capabilityLocations, type CapabilityPlanView, type HostCapabilities } from './capability-locations.js'
import { uniqueBlockers, type HandoffCopyView } from './work-copy.js'
import { environmentHandoffPrompt, handoffCopyBlockers, isEnvironmentHandoffActive, isHandoffPromptPending,
  loadEnvironmentHandoff, saveEnvironmentHandoffIn, type EnvironmentHandoffCommand, type EnvironmentHandoffRevalidation,
  type EnvironmentHandoffView, type HandoffBlocker } from './environment-handoff.js'
import { assertHostTakeoverSettled, hostTakeoverKey, isHostTakeoverPending, loadHostTakeover, type HostTakeoverBlocker, type HostTakeoverRecord,
  type HostTakeoverTicket } from './host-takeover.js'

const maxRecoveryAttempts = 3
const maxDeliveryAttempts = 5

/**
 * The completed job reaches its own Worker as a fact, with the confirmed exit and the bounded retained
 * output. The text never claims success on its own: only the ToolFact and exit code do.
 */
function jobEventText(job: JobRecord) {
  const output = job.output ?? { stdout: { text: '', lossy: false }, stderr: { text: '', lossy: false } }
  return `Background job ${job.id} (${job.command}) finished with state ${job.state}${job.exitCode === undefined ? '' : ` and exit code ${job.exitCode}`}. `
    + `${job.reason ? `${job.reason} ` : ''}Continue this Ticket using these facts. `
    + `Standard output:${JSON.stringify(output.stdout)} Standard error:${JSON.stringify(output.stderr)}`
}

/** A child Agent's outcome is evidence for the parent, never the Ticket's own completed result. */
function subagentEventText(subagent: SubagentRecord) {
  const result = subagent.result ?? { text: '', truncated: false }
  return `Subagent ${subagent.id} (delegated by Assignment generation ${subagent.generation}) finished with state ${subagent.state}. ${subagent.reason ? `${subagent.reason} ` : ''}`
    + `Continue this Ticket using this evidence; a subtask result is not a ready report.`
    + `${result.truncated ? ' Its result was shortened to the declared size limit.' : ''} Result:${JSON.stringify(result.text)}`
}

export interface Assignment {
  id: string
  ticketId: string
  sessionId: string
  state: 'pending' | 'running' | 'stopping' | 'ended'
  generation: string
  createdAt: number
  runtimeToken?: string
  environment?: EnvironmentLocation
  recovery?: { reason: 'HOST_REPLACED'; previousAssignmentId: string; takeoverId: string }
}
export interface EnvironmentHandoffRequest {
  ticketId: string
  source: EnvironmentLocation
  target: EnvironmentLocation
  copy?: HandoffCopyView
  targetBlockers?: HandoffBlocker[]
  revalidate?: () => Promise<EnvironmentHandoffRevalidation>
  command?: EnvironmentHandoffCommand
  /** A restart continues the recorded attempt; the copy was already checked before the crash. */
  recovering?: boolean
  actorId: string
  reason: string
}
type TurnCause = 'status' | 'background' | 'followup' | 'environment-handoff' | 'context-handoff' | 'host-takeover' | 'resume' | 'launch'

/**
 * A replacement may continue a running turn, a queued Router/relay/slot wake or an already committed rollover.
 * Ready, idle, blocked, stopping and environment-waiting intents keep their existing outcome; a takeover must not
 * turn an exhausted recovery or a waiting target into fresh work.
 */
function resumableIntent(intent: Work['intent']) {
  if (intent.state === 'running') return true
  return ['router-pending', 'recovery-pending', 'followup-pending', 'context-rollover', 'worker-background',
    'slot-queued', 'slot-priority-waiting'].includes(intent.reason)
}

interface WorkerTurnRequest {
  ticketId: string
  inputId?: string
  resume?: boolean
  takeover?: boolean
  status?: boolean
  jobId?: string
  subagentId?: string
  contextHandoff?: boolean
  environmentHandoffId?: string
}
export interface StopState {
  id: string
  instanceId: string
  ticketId: string
  state: 'stopping' | 'stopped'
  requestedAt: number
  requestedBy: string
  reason: string
  assignmentId?: string
  cancellationConfirmedAt?: number
  pendingDeviceConfirmation?: boolean
  previousConstraint?: Work['ticket']['constraint']
  resumedAt?: number
  resumeCommandId?: string
  recoveryReason?: 'ENGINE_RESTARTED' | 'HOST_REPLACED'
  recoveredAt?: number
  runtimeToken: string
}

interface StopHead { stopId: string }
export interface ReadyReport { id: string; ticketId: string; assignmentId: string; sessionId: string; kind: 'ready'; result: string; evidence: string; artifacts: Artifact[]; toolFacts: ToolFact[]; inputId?: string; directionVersion: number; createdAt: number }
export interface Artifact { path: string; bytes: number; sha256: string }
export interface ToolFact { tool: string; outcome: 'success' | 'failed'; output: Record<string, unknown> }
export interface SetupState { assignmentId: string; state: 'failed' | 'ready' | 'pending'; output?: Record<string, unknown>; code?: string }
export interface StatusReport { id: string; ticketId: string; assignmentId: string; text: string; createdAt: number }
export interface RetryDecision {
  id: string
  instanceId: string
  ticketId: string
  previousAssignmentId?: string
  previousGeneration?: string
  assignmentId: string
  sessionId: string
  environment?: EnvironmentLocation
  reason: 'RETRY_REQUESTED'
  requestedBy: string
  requestReason: string
  checks: string[]
  blockedWork?: { kind: 'job' | 'subagent'; id: string; state: string }[]
  createdAt: number
}
export interface SessionRollover {
  id: string
  instanceId: string
  ticketId: string
  previousAssignmentId: string
  previousSessionId: string
  assignmentId: string
  sessionId: string
  forked: boolean
  goal: string
  mandateId: string
  constraint?: Work['ticket']['constraint']
  pendingInputs: { id: string; text: string; directionVersion: number }[]
  evidence: { triggerId: string; reportId?: string; attentionId?: string }
  reason: 'CONTEXT_WINDOW'
  createdAt: number
}

export class Execution {
  private readonly runtimeToken = randomUUID()
  private readonly workerControllers = new Map<string, { assignmentId: string; controller: AbortController }>()
  private readonly handoffLocks = new Map<string, Promise<unknown>>()
  private readonly jobs: Jobs | undefined
  private readonly previews: Previews | undefined
  private readonly subagents: Subagents | undefined
  private readonly deliveries: Deliveries
  private readonly context: ContextReader
  private readonly roleConfig: RoleConfigStore
  private readonly executionPolicy: ExecutionPolicyStore
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly effects: Effects, private readonly sessions: NativeSessions,
    private readonly inputs: WorkInputs, private readonly attentions: Attentions, private readonly sourceEvents: SourceEvents,
    private allowedRequesterIds: string[], private readonly environments: ExecutionEnvironment[] = [], private readonly slots?: Slots, jobs?: Jobs,
    subagents?: Subagents, previews?: Previews, deliveries?: Deliveries, context?: ContextReader, roleConfig?: RoleConfigStore,
    private readonly deliveryState?: import('./delivery-state.js').DeliveryState, private readonly hostId = 'local-host',
    private readonly hostCapabilities: HostCapabilities = {},
    private readonly hostEpoch?: () => number | undefined) {
    this.jobs = jobs
    this.previews = previews
    this.subagents = subagents
    if (!deliveries) throw new CoreError('INVALID_CONFIG', 'The native runtime requires the delivery ledger.')
    this.deliveries = deliveries
    if (!context) throw new CoreError('INVALID_CONFIG', 'The native runtime requires the context reader.')
    this.context = context
    if (!roleConfig) throw new CoreError('INVALID_CONFIG', 'The native runtime requires the role configuration store.')
    this.roleConfig = roleConfig
    this.executionPolicy = new ExecutionPolicyStore(storage, instanceId, Date.now)
    this.jobs?.setHandlers({ settled: record => this.wakeForJob(record), deadline: record => this.wakeForJob(record),
      unknown: record => { void this.raiseRemoteUnknown(record) } })
    this.subagents?.setHandlers({ settled: record => this.wakeForSubagent(record), deadline: record => this.wakeForSubagent(record) })
  }

  /** Terminates managed background processes without writing business facts; the Host owns this shutdown. */
  async shutdown() {
    await this.subagents?.shutdown()
    try {
      const previews = await this.storage.transaction(this.instanceId, async transaction => {
        const ticketIds: string[] = []
        let cursor: string | undefined
        for (let pageCount = 0; pageCount < 10; pageCount++) {
          const page = await transaction.scan<Work['ticket']>('ticket', { limit: 100, ...(cursor ? { after: cursor } : {}) })
          ticketIds.push(...page.items.map(item => item.value.id))
          if (!page.cursor) break
          cursor = page.cursor
        }
        const ids: string[] = []
        for (const ticketId of ticketIds) ids.push(...await this.activePreviewJobs(transaction, ticketId))
        return ids
      })
      if (previews.length) {
        await this.jobs?.shutdownPreviews(previews)
      }
    } catch { /* The Host still terminates every managed handle below. */ } finally { this.jobs?.shutdown() }
  }

  private async wakeForSubagent(record: SubagentRecord) {
    // A cancellation the person, the Worker or the host's own stop decided is not new information; none of them
    // may start an unasked turn.
    if (record.state === 'cancelled' && record.cancelReason !== 'deadline') return
    try {
      await commandTransaction(this.storage, this.instanceId, async transaction => {
        const ticket = await transaction.get<Work['ticket']>('ticket', record.ticketId)
        const assignment = await transaction.get<Assignment>('assignment', record.ticketId)
        // The completion only reaches the Assignment generation that delegated it.
        if (!ticket || ticket.state !== 'open' || ticket.constraint) return
        if (!assignment || assignment.state !== 'running' || assignment.id !== record.assignmentId || assignment.generation !== record.generation) return
        const intent = await transaction.get<Work['intent']>('intent', record.ticketId)
        if (intent) await transaction.replace('intent', record.ticketId, { ...intent, state: 'pending', reason: 'followup-pending' })
        // The wake names the generation that delegated the child, so a replacement Assignment can never consume it.
        await this.effects.enqueue(transaction, { key: `subagent:${record.id}`, stream: 'relay', scope: record.ticketId,
          payload: { ticketId: record.ticketId, subagentId: record.id, generation: record.generation } })
      })
    } catch { /* The durable subagent record stays queryable; the Ticket keeps its hold until the next wake. */ }
  }

  private async wakeForJob(record: JobRecord) {
    // An accepted preview is deliberately not execution input; its exit is a queryable fact only.
    if (await this.storage.transaction(this.instanceId, transaction => this.previews?.isPreview(transaction, record.ticketId, record.id) ?? Promise.resolve(false))) return
    // A cancellation the person or the Worker itself decided is not new information; it must not start an
    // unasked turn. A stop is already guarded by the Ticket constraint below.
    if (record.state === 'cancelled' && (record.cancelReason === 'human' || record.cancelReason === 'worker')) return
    try {
      await commandTransaction(this.storage, this.instanceId, async transaction => {
        const ticket = await transaction.get<Work['ticket']>('ticket', record.ticketId)
        const assignment = await transaction.get<Assignment>('assignment', record.ticketId)
        // A stop, a waiting question, a ready handoff or a newer Assignment generation means the completion
        // must not wake work or a new generation.
        if (!ticket || ticket.state !== 'open' || ticket.constraint) return
        if (!assignment || assignment.state !== 'running' || assignment.id !== record.assignmentId || assignment.generation !== record.generation) return
        const intent = await transaction.get<Work['intent']>('intent', record.ticketId)
        if (intent) await transaction.replace('intent', record.ticketId, { ...intent, state: 'pending', reason: 'followup-pending' })
        await this.effects.enqueue(transaction, { key: `job:${record.id}`, stream: 'relay', scope: record.ticketId, payload: { ticketId: record.ticketId, jobId: record.id } })
      })
    } catch { /* The durable job record stays queryable; the Ticket keeps `worker-background` until the next wake. */ }
  }

  /**
   * A remote range the device could not observe keeps its outcome unknown. The Ticket asks one
   * bounded, evidence-backed question; later reconciliation returns the same question.
   */
  private async raiseRemoteUnknown(record: JobRecord | undefined) {
    if (!record || record.environmentKind !== 'remote' || !record.remote?.recovery || record.remote.recoveryQuestionId) return
    try {
      await commandTransaction(this.storage, this.instanceId, async transaction => {
        const current = await this.jobs!.get(transaction, record.ticketId, record.id)
        if (!current?.remote || current.remote.recoveryQuestionId) return
        const ticket = await transaction.get<Work['ticket']>('ticket', record.ticketId)
        const assignment = await transaction.get<Assignment>('assignment', record.ticketId)
        if (!ticket || ticket.state !== 'open' || ticket.constraint || !assignment) return
        const reason = current.reason ?? current.remote.recovery?.reason ?? 'The device could not confirm the original range.'
        const evidence = `job ${current.id} on device ${current.remote.deviceId} (incarnation ${current.remote.deviceIncarnation}) is ${current.state}: ${reason}`
        const question = `The device could not confirm the outcome of ${evidence}. It may still be running or may have changed files after the daemon restarted. Keep this Ticket waiting until you decide whether to keep it unknown, recheck the device, or stop it.`
        const attention = await this.attentions.ask(transaction, { ticketId: record.ticketId, assignmentId: assignment.id,
          sessionId: assignment.sessionId, question, options: ['Keep it unknown', 'Recheck the device', 'Stop the job'] })
        await this.jobs!.noteRecoveryQuestion(transaction, { ticketId: record.ticketId, jobId: record.id,
          attentionId: attention.id, evidence: evidence.slice(0, 2048) })
      })
    } catch { /* The unknown job remains queryable; a later command or restart can raise the question. */ }
  }

  setAllowedRequesterIds(ids: string[]) {
    this.allowedRequesterIds = [...ids]
  }

  handlers(): Record<'notice' | 'relay', EffectHandler> {
    // A relay turn is safe to re-run after an unknown outcome: the Worker re-reads the durable Input and Session
    // boundary before sending, so a lost delivery is resumed instead of duplicated.
    const relay = async (effect: Effect): Promise<EffectResult> => {
      try {
        const admitted = await this.worker({ ticketId: String(effect.payload.ticketId),
          ...(typeof effect.payload.inputId === 'string' ? { inputId: effect.payload.inputId } : {}),
          resume: effect.payload.resume === true, takeover: effect.payload.takeover === true, status: effect.payload.status === true,
          ...(typeof effect.payload.jobId === 'string' ? { jobId: effect.payload.jobId } : {}),
          ...(typeof effect.payload.subagentId === 'string' ? { subagentId: effect.payload.subagentId } : {}),
          contextHandoff: effect.payload.handoff === true,
          ...(typeof effect.payload.environmentHandoff === 'string' ? { environmentHandoffId: effect.payload.environmentHandoff } : {}) })
        return admitted === 'waiting'
          ? { type: 'defer', reason: 'The Worker turn is waiting for an execution slot.' }
          : { type: 'success' }
      } catch (error) {
        // A turn already running on this Ticket is not a failure of the queued wake: keep it due instead of
        // turning an ordinary overlap into an unknown outcome that would block the lane.
        if (error instanceof CoreError && error.code === 'TURN_ACTIVE') return { type: 'defer', reason: 'The Ticket already has an active Worker turn.' }
        throw error
      }
    }
    return {
      notice: { execute: async (effect, context) => {
        try { await this.router(String(effect.payload.ticketId), effect.payload.type === 'report-ready', context.signal); return { type: 'success' } }
        catch (error) {
          if (error instanceof CoreError && error.code === 'ROUTER_NOTICE_UNHANDLED') return { type: 'transient', reason: error.message }
          throw error
        }
      }, batch: { maxSize: 7, execute: (effects, context) => this.routerBatch(effects, context.signal) } },
      relay: { execute: relay, reconcile: relay },
    }
  }

  private async trigger(transaction: AsyncTx, ticketId: string) {
    const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket && await transaction.get<Work['trigger']>('trigger', ticket.triggerId)
    if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The work does not exist in this instance.')
    return trigger
  }

  /**
   * Frees a Ticket's slot after a turn. `wake` is only passed when the release is the last fact written,
   * so the dispatcher never runs a queued relay against a half-committed turn.
   */
  private async releaseSlot(ticketId: string, assignmentId: string, wake = false) {
    if (!this.slots) return
    const queued = await this.storage.transaction(this.instanceId, async transaction => {
      const released = await this.slots!.release(transaction, { ticketId, assignmentId })
      return released && await this.slots!.hasWaiting(transaction)
    })
    if (wake && queued) this.effects.wake()
  }

  private async admitSlot(transaction: AsyncTx, assignment: Assignment, request: { ticketId: string; activation: SlotActivation }) {
    const outcome = await this.slots?.acquire(transaction, { ticketId: request.ticketId, assignmentId: assignment.id, activation: request.activation })
    if (!outcome || outcome.acquired) return true
    const intent = await transaction.get<Work['intent']>('intent', request.ticketId)
    if (intent) await transaction.replace('intent', request.ticketId, { ...intent, state: 'pending', reason: outcome.reason === 'PRIORITY_WAITING' ? 'slot-priority-waiting' : 'slot-queued' })
    return false
  }

  /**
   * Resolves the Ticket target once and fixes the selected Environment on the Assignment. The
   * probe happens outside the write transaction; the final transaction rechecks the Ticket and
   * any concurrently created Assignment before committing.
   */
  private async bindExecutionTarget(ticketId: string, wake = true) {
    const initial = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      const trigger = await this.trigger(transaction, ticketId)
      return { ticket, assignment, trigger }
    })
    if (!initial.ticket || initial.ticket.state !== 'open' || initial.ticket.constraint) {
      return { assignmentId: undefined, reason: 'The Ticket is stopped or constrained.' }
    }
    if (initial.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This source cannot choose an execution target for the Ticket.')
    }
    if (initial.assignment?.environment) return { assignmentId: initial.assignment.id, selection: undefined }
    const policy = await this.executionPolicy.get()
    const selection = await selectExecutionTarget({ ticketId, instanceId: this.instanceId,
      actorId: initial.trigger.source.actorId, hostId: this.hostId, environments: this.environments, policy,
      ...(initial.trigger.targetSource ? { source: initial.trigger.targetSource } : {}),
      ...(initial.trigger.target ? { ticketTarget: initial.trigger.target } : {}),
      ...(initial.trigger.capabilities?.length ? { requiredCapabilities: initial.trigger.capabilities } : {}),
      hostCapabilities: this.hostCapabilities,
      ...(initial.trigger.environmentId ? { explicitEnvironmentId: initial.trigger.environmentId } : {}) })
    return this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      if (!ticket || ticket.state !== 'open' || ticket.constraint) {
        return { assignmentId: undefined, selection, reason: 'The Ticket became stopped or constrained.' }
      }
      const existing = await transaction.get<Assignment>('assignment', ticketId)
      if (existing?.environment) return { assignmentId: existing.id, selection }
      if (existing && existing.state !== 'pending') {
        throw new CoreError('ENVIRONMENT_BOUND', 'The active Assignment has no replaceable Environment binding.')
      }
      const trigger = await this.trigger(transaction, ticketId)
      if (trigger.source.actorId !== initial.trigger.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The original actor changed before the Environment was fixed.')
      }
      await saveExecutionSelection(transaction, selection)
      const intent = await transaction.get<Work['intent']>('intent', ticketId)
      if (!intent) throw new CoreError('INCOMPLETE_STATE', 'The Ticket has no execution intent.')
      if (selection.status === 'waiting' || !selection.selected && !selection.answerOnly) {
        await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'environment-waiting' })
        return { assignmentId: undefined, selection, reason: selection.reason }
      }
      if (selection.selected && intent.environment !== selection.selected.kind) {
        await transaction.replace('intent', ticketId, { ...intent, environment: selection.selected.kind })
      }
      const assignment: Assignment = { ...existing, id: existing?.id ?? randomUUID(), generation: randomUUID(), ticketId,
        sessionId: existing?.sessionId ?? `worker-${randomUUID()}`, state: 'pending', createdAt: existing?.createdAt ?? Date.now(),
        runtimeToken: this.runtimeToken, ...(selection.selected ? { environment: structuredClone(selection.selected) } : {}) }
      await this.saveAssignment(transaction, assignment)
      if (wake) await this.effects.enqueue(transaction, { key: assignment.id, stream: 'relay', scope: ticketId,
        payload: { ticketId, assignmentId: assignment.id } })
      return { assignmentId: assignment.id, selection }
    })
  }

  async retryExecutionTarget(ticketId: string, options: { replay?: boolean } = {}) {
    const existing = await this.storage.transaction(this.instanceId, transaction => transaction.get<Assignment>('assignment', ticketId))
    if (existing?.environment) {
      if (options.replay) return this.conversation(ticketId)
      throw new CoreError('ENVIRONMENT_BOUND', 'The Ticket already has a fixed execution Environment.')
    }
    const bound = await this.bindExecutionTarget(ticketId)
    if (!bound.assignmentId) return { ...(await this.conversation(ticketId)), waitingReason: bound.reason }
    return this.conversation(ticketId)
  }

  /** One handoff per Ticket at a time: the probe, flush and switch must not interleave with a second request. */
  requestEnvironmentHandoff(request: EnvironmentHandoffRequest): Promise<EnvironmentHandoffView> {
    const previous = this.handoffLocks.get(request.ticketId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await this.assertHostAdmission()
      return this.runEnvironmentHandoff(request)
    })
    this.handoffLocks.set(request.ticketId, next)
    return next.finally(() => { if (this.handoffLocks.get(request.ticketId) === next) this.handoffLocks.delete(request.ticketId) })
  }

  private async runEnvironmentHandoff(request: EnvironmentHandoffRequest): Promise<EnvironmentHandoffView> {
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', request.ticketId),
      assignment: await transaction.get<Assignment>('assignment', request.ticketId),
      setup: await transaction.get<SetupState>('setup', request.ticketId),
      stop: await this.activeStop(transaction, request.ticketId),
      attention: await this.attentions.current(transaction, request.ticketId),
      report: await transaction.get<ReadyReport>('report', request.ticketId),
      unknownEffects: await this.effects.hasUnknownScopeInTransaction(transaction, request.ticketId, 'relay'),
      jobs: this.jobs ? await this.jobs.listIn(transaction, request.ticketId) : [],
      subagents: this.subagents ? await this.subagents.listIn(transaction, request.ticketId) : [],
      previews: this.previews ? await this.previews.list(transaction, request.ticketId) : [],
      prior: request.command
        ? await transaction.get<{ fingerprint: string; record: EnvironmentHandoffView }>('work-command', request.command.key)
        : undefined,
    }))
    if (initial.prior) {
      if (initial.prior.fingerprint !== request.command!.fingerprint) {
        throw new CoreError('IDENTITY_CONFLICT', 'The handoff command was reused for different input.')
      }
      return initial.prior.record
    }
    const active = await this.storage.transaction(this.instanceId, transaction => loadEnvironmentHandoff(transaction, request.ticketId))
    if (active && isEnvironmentHandoffActive(active)) {
      // Re-running an unfinished handoff would repeat the flush and switch from an unverified point; T41 owns that
      // reconciliation, so this request fails closed instead of replacing the persisted progress with a new record.
      throw new CoreError('HANDOFF_IN_PROGRESS', 'An earlier handoff for this Ticket has not reached a terminal state and needs reconciliation.')
    }
    const assignment = initial.assignment
    const blockers = this.handoffBoundaryBlockers(initial, request, assignment)
    const now = Date.now()
    // A settled job is the only accepted proof that its range is gone; active or unconfirmed ones already blocked the
    // boundary above, so the record names exactly which source ranges were accounted for before the switch.
    const settledJobs = initial.jobs.filter(job => (job.state === 'exited' || job.state === 'cancelled')
      && (job.environmentKind !== 'remote' || job.remote?.rangeSettled === true)).map(job => job.id)
    const record: EnvironmentHandoffView = { id: randomUUID(), instanceId: this.instanceId, ticketId: request.ticketId,
      source: structuredClone(request.source), target: structuredClone(request.target),
      sourceAssignmentId: assignment?.id ?? 'none', sourceGeneration: assignment?.generation ?? 'none',
      ...(request.copy ? { copyId: request.copy.id } : {}), state: 'requested', reason: request.reason,
      requestedBy: request.actorId, requestedAt: now, ...(settledJobs.length ? { settledJobs } : {}), blockers: [],
      ...(request.command ? { command: request.command } : {}),
      steps: [{ name: 'requested', state: 'completed', at: now }] }
    await this.saveEnvironmentHandoff(record, request.command)
    if (!blockers.length && this.workerControllers.has(request.ticketId)) {
      blockers.push({ code: 'active-turn', message: 'A Worker turn started before the handoff request was durable.' })
    }
    if (blockers.length) return this.blockEnvironmentHandoff(record, blockers, 'safe-boundary')
    return this.continueEnvironmentHandoff(record, request, assignment!, settledJobs.length)
  }

  private async continueEnvironmentHandoff(record: EnvironmentHandoffView, request: EnvironmentHandoffRequest,
    assignment: Assignment, settledCount?: number) {
    record.state = 'flushing'
    if (!record.steps.some(step => step.name === 'safe-boundary' && step.state === 'completed')) {
      record.steps.push({ name: 'safe-boundary', state: 'completed', at: Date.now() })
    }
    if (settledCount !== undefined) {
      record.steps.push({ name: 'jobs-reconciled', state: 'completed', at: Date.now(),
        detail: `${settledCount} settled source job(s) accounted for; no active or unconfirmed range remains` })
    }
    await this.saveEnvironmentHandoff(record, record.command)
    let flushed = true
    try { flushed = await this.sessions.flush(assignment.sessionId) } catch { flushed = false }
    if (!flushed) {
      return this.blockEnvironmentHandoff(record,
        [{ code: 'session-flush-failed', message: 'The source Session could not be flushed before the handoff.' }],
        'session-flushed', 'Session persistence did not confirm the flush.')
    }
    record.steps.push({ name: 'session-flushed', state: 'completed', at: Date.now() })
    if (request.revalidate) {
      let revalidated: EnvironmentHandoffRevalidation
      try { revalidated = await request.revalidate() }
      catch {
        return this.blockEnvironmentHandoff(record,
          [{ code: 'handoff-revalidation-failed', message: 'The target or work copy could not be revalidated after the flush.' }],
          'target-revalidated')
      }
      if (revalidated.target) record.target = structuredClone(revalidated.target)
      if (revalidated.copy) record.copyId = revalidated.copy.id
      const copyBlockers = handoffCopyBlockers(revalidated.copy, assignment.id, request.source, record.target)
      const revalidationBlockers = uniqueBlockers([...revalidated.blockers, ...copyBlockers])
      if (revalidationBlockers.length) {
        return this.blockEnvironmentHandoff(record, revalidationBlockers, 'target-revalidated')
      }
    } else {
      const copyBlockers = handoffCopyBlockers(request.copy, assignment.id, request.source, record.target)
      if (copyBlockers.length) return this.blockEnvironmentHandoff(record, copyBlockers, 'copy-verified')
    }
    record.steps.push({ name: 'target-revalidated', state: 'completed', at: Date.now() })
    record.steps.push({ name: 'copy-verified', state: 'completed', at: Date.now(), ...(record.copyId ? { detail: record.copyId } : {}) })
    record.state = 'switching'
    await this.saveEnvironmentHandoff(record, record.command)
    const switched = await this.switchEnvironmentHandoff(record, request)
    if ('blocker' in switched) {
      return this.blockEnvironmentHandoff(record, [switched.blocker], 'source-ended')
    }
    this.effects.wake()
    return switched.record
  }

  private handoffBoundaryBlockers(initial: {
    ticket: Work['ticket'] | undefined; assignment: Assignment | undefined; setup: SetupState | undefined
    stop: StopState | undefined; attention: Attention | undefined; report: ReadyReport | undefined; unknownEffects: boolean
    jobs: { state: string }[]; subagents: { state: string }[]; previews: { state: string }[]
  }, request: EnvironmentHandoffRequest, assignment: Assignment | undefined) {
    const blockers: HandoffBlocker[] = [...(request.targetBlockers ?? [])]
    if (!assignment) blockers.push({ code: 'no-assignment', message: 'The Ticket has no active Assignment.' })
    else if (assignment.state !== 'running') blockers.push({ code: 'assignment-not-running', message: 'The source Assignment is not running.' })
    if (!initial.ticket || initial.ticket.state !== 'open') blockers.push({ code: 'ticket-ended', message: 'The Ticket is not open.' })
    if (initial.ticket?.constraint) blockers.push({ code: 'ticket-constrained', message: 'The Ticket is stopped or waiting for a person.' })
    if (initial.stop) blockers.push({ code: 'ticket-stopping', message: 'The Ticket has an active stop request.' })
    if (initial.attention?.status === 'waiting') blockers.push({ code: 'waiting-human', message: 'A human question must be answered before this handoff.' })
    if (initial.report) blockers.push({ code: 'ready-report', message: 'A ready report already ended this Assignment.' })
    if (initial.setup?.state === 'failed') blockers.push({ code: 'setup-failed', message: 'The source workspace setup failed.' })
    if (initial.unknownEffects) blockers.push({ code: 'unknown-effect', message: 'An external outcome for this Ticket is still unknown; reconcile it before switching.' })
    if (this.workerControllers.has(request.ticketId)) {
      blockers.push({ code: 'active-turn', message: 'A Worker turn is still active; handoff needs a safe boundary.' })
    }
    blockers.push(...activeBackgroundBlockers(initial.jobs, initial.subagents, initial.previews))
    // A prepared copy must exist before anything is flushed; its hashes are verified again after the flush.
    if (!request.revalidate) blockers.push(...handoffCopyBlockers(request.copy, assignment?.id, request.source, request.target))
    else if (!request.recovering && !request.copy) {
      blockers.push({ code: 'handoff-copy-missing', message: 'No prepared work copy exists for this handoff.' })
    }
    if (request.source.id === request.target.id) blockers.push({ code: 'same-environment', message: 'A handoff needs a different target Environment.' })
    return uniqueBlockers(blockers)
  }

  private async blockEnvironmentHandoff(record: EnvironmentHandoffView, blockers: HandoffBlocker[], step: string, detail?: string) {
    const unique = uniqueBlockers(blockers)
    const next: EnvironmentHandoffView = { ...record, state: 'blocked', blockers: unique,
      steps: [...record.steps, { name: step, state: 'blocked', at: Date.now(),
        detail: detail ?? unique.map(blocker => blocker.code).join(', ') }] }
    return this.saveEnvironmentHandoff(next, record.command)
  }

  private async switchEnvironmentHandoff(record: EnvironmentHandoffView, request: EnvironmentHandoffRequest) {
    return this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', request.ticketId)
      const current = await transaction.get<Assignment>('assignment', request.ticketId)
      if (!ticket || ticket.state !== 'open' || ticket.constraint || !current || current.id !== record.sourceAssignmentId
        || current.generation !== record.sourceGeneration || current.state !== 'running') {
        return { blocker: { code: 'handoff-stale', message: 'The source Assignment changed while the handoff was being prepared.' } }
      }
      if (this.workerControllers.has(request.ticketId)) {
        return { blocker: { code: 'handoff-stale', message: 'A Worker turn started while the handoff was being prepared.' } }
      }
      const jobs = this.jobs ? await this.jobs.listIn(transaction, request.ticketId) : []
      const subagents = this.subagents ? await this.subagents.listIn(transaction, request.ticketId) : []
      const previews = this.previews ? await this.previews.list(transaction, request.ticketId) : []
      if (activeBackgroundBlockers(jobs, subagents, previews).length) {
        return { blocker: { code: 'handoff-stale', message: 'New background work appeared during the handoff.' } }
      }
      const ended: Assignment = { ...current, state: 'ended' }
      const next: Assignment = { ...current, id: randomUUID(), generation: randomUUID(), state: 'pending',
        createdAt: Date.now(), runtimeToken: this.runtimeToken, environment: structuredClone(record.target) }
      await this.saveAssignment(transaction, ended)
      await this.saveAssignment(transaction, next)
      await this.slots?.release(transaction, { ticketId: request.ticketId, assignmentId: current.id })
      const intent = await transaction.get<Work['intent']>('intent', request.ticketId)
      if (!intent) return { blocker: { code: 'handoff-stale', message: 'The Ticket intent disappeared during the handoff.' } }
      await transaction.replace('intent', request.ticketId, { ...intent, state: 'pending', reason: 'handoff-pending' })
      await this.effects.enqueue(transaction, { key: `handoff:${record.id}`, stream: 'relay', scope: request.ticketId,
        payload: { ticketId: request.ticketId, assignmentId: next.id, environmentHandoff: record.id } })
      const completedAt = Date.now()
      const completed: EnvironmentHandoffView = { ...record, state: 'completed', targetAssignmentId: next.id,
        targetGeneration: next.generation, completedAt,
        steps: [...record.steps, { name: 'source-ended', state: 'completed', at: completedAt, detail: ended.id },
          { name: 'target-created', state: 'completed', at: completedAt, detail: next.id },
          { name: 'completed', state: 'completed', at: completedAt }] }
      await saveEnvironmentHandoffIn(transaction, completed, record.command)
      return { record: completed }
    })
  }

  async activeEnvironmentHandoffs() {
    const active: EnvironmentHandoffView[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.storage.transaction(this.instanceId, transaction => transaction.scan<EnvironmentHandoffView>('handoff-state',
        { limit: 100, ...(cursor ? { after: cursor } : {}) }))
      for (const item of page.items) if (isEnvironmentHandoffActive(item.value)) active.push(item.value)
      if (!page.cursor) break
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('HANDOFF_RECOVERY_BUDGET', 'The interrupted-handoff scan exceeded its bounded budget.')
    }
    return active
  }

  /** A restart reconciles an unfinished handoff against current facts, then continues the same recorded step. */
  async recoverEnvironmentHandoff(record: EnvironmentHandoffView, revalidate: () => Promise<EnvironmentHandoffRevalidation>) {
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', record.ticketId),
      assignment: await transaction.get<Assignment>('assignment', record.ticketId),
      setup: await transaction.get<SetupState>('setup', record.ticketId),
      stop: await this.activeStop(transaction, record.ticketId),
      attention: await this.attentions.current(transaction, record.ticketId),
      report: await transaction.get<ReadyReport>('report', record.ticketId),
      unknownEffects: await this.effects.hasUnknownScopeInTransaction(transaction, record.ticketId, 'relay'),
      jobs: this.jobs ? await this.jobs.listIn(transaction, record.ticketId) : [],
      subagents: this.subagents ? await this.subagents.listIn(transaction, record.ticketId) : [],
      previews: this.previews ? await this.previews.list(transaction, record.ticketId) : [],
    }))
    const assignment = initial.assignment
    const settledJobs = initial.jobs.filter(job => (job.state === 'exited' || job.state === 'cancelled')
      && (job.environmentKind !== 'remote' || job.remote?.rangeSettled === true)).map(job => job.id)
    const request: EnvironmentHandoffRequest = { ticketId: record.ticketId, source: record.source, target: record.target,
      revalidate, recovering: true, actorId: record.requestedBy, reason: record.reason,
      ...(record.command ? { command: record.command } : {}) }
    const blockers = this.handoffBoundaryBlockers(initial, request, assignment)
    if (assignment && (assignment.id !== record.sourceAssignmentId || assignment.generation !== record.sourceGeneration)) {
      blockers.push({ code: 'handoff-superseded', message: 'The source Assignment was replaced before the interrupted handoff could be reconciled.' })
    }
    const recovered: EnvironmentHandoffView = { ...record, recoveredAt: Date.now(),
      ...(record.settledJobs?.length || !settledJobs.length ? {} : { settledJobs }),
      steps: [...record.steps, { name: 'recovered', state: 'completed', at: Date.now() }] }
    if (blockers.length) return this.blockEnvironmentHandoff(recovered, blockers, 'recovered')
    await this.saveEnvironmentHandoff(recovered, record.command)
    const alreadyReconciled = record.steps.some(step => step.name === 'jobs-reconciled')
    return this.continueEnvironmentHandoff(recovered, request, assignment!, alreadyReconciled ? undefined : settledJobs.length)
  }

  /** A recovery fault becomes a visible blocked handoff instead of leaving the Ticket deferred forever. */
  async failInterruptedHandoff(record: EnvironmentHandoffView, error: unknown) {
    const message = error instanceof CoreError ? error.message : 'The interrupted handoff could not be reconciled.'
    return this.blockEnvironmentHandoff(record, [{ code: 'handoff-recovery-failed', message }], 'recovered')
  }

  private async routerRequest(ticketId: string, ready: boolean) {
    const ticket = await this.storage.transaction(this.instanceId, transaction => transaction.get<Work['ticket']>('ticket', ticketId))
    if (ticket?.constraint) return undefined
    const trigger = await this.storage.transaction(this.instanceId, transaction => this.trigger(transaction, ticketId))
    const report = ready ? await this.storage.transaction(this.instanceId, transaction => transaction.get<ReadyReport>('report', ticketId)) : undefined
    if (ready && !report) throw new CoreError('NOT_READY', 'No ready report exists.')
    const tool: NativeTool = ready ? {
      name: 'deliver_result', description: 'Deliver the current verified ready report to the original request.', parameters: { reportId: { type: 'string', required: true } },
      execute: async args => this.storage.transaction(this.instanceId, async transaction => {
        const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
        if (!ticket || ticket.state !== 'open' || ticket.constraint) return 'Result was not delivered because the Ticket is stopped or constrained.'
        const current = await transaction.get<ReadyReport>('report', ticketId)
        const assignment = await transaction.get<Assignment>('assignment', ticketId)
        if (!current || current.id !== args.reportId || current.assignmentId !== assignment?.id) throw new CoreError('NOT_READY', 'Only the current Assignment ready report may be delivered.')
        const trigger = await this.trigger(transaction, ticketId)
        const deliveryId = `${ticketId}:result`
        const destination = { ...trigger.source, eventId: trigger.eventId, ...(trigger.threadId ? { threadId: trigger.threadId } : {}) }
        const effect = await this.effects.enqueue(transaction, { key: `${ticketId}:result`, stream: 'outbox', scope: ticketId,
          payload: { purpose: 'result', ticketId, reportId: current.id, deliveryId } })
        await this.deliveries.record(transaction, { id: deliveryId, ticketId, purpose: 'result', text: current.result, destination,
          basis: { kind: 'ready-report', reportId: current.id, directionVersion: current.directionVersion },
          effectId: effect.id, effectGeneration: effect.generation }, effect)
        return 'Result queued for the original message.'
      }),
    } : {
      name: 'assign_worker', description: 'Assign the accepted original request to one Worker.', parameters: {},
      execute: async () => {
        const bound = await this.bindExecutionTarget(ticketId)
        return bound.assignmentId ?? `No Worker was assigned because the execution Environment is waiting: ${bound.reason ?? 'no eligible target'}`
      },
    }
    return { sessionId: this.sessions.routerSessionId, role: 'router' as const, coalesce: true, text: report ? `Ready report:${JSON.stringify(report)}` : `Accepted original request:${JSON.stringify({ ticketId, text: trigger.text })}`, tools: [tool] }
  }

  private async router(ticketId: string, ready: boolean, signal: AbortSignal) {
    const request = await this.routerRequest(ticketId, ready)
    if (!request) return
    const config = await this.roleConfig.currentView()
    this.sessions.setRoutes(config.roles.router.model, config.roles.worker.model)
    this.sessions.setRoleInstructions(config.roles.router, config.roles.worker)
    const result = await this.sessions.run({ ...request, signal, instructions: config.roles.router.instructions, skills: config.roles.router.skills })
    await this.recordRouterSession(result)
    await this.storage.transaction(this.instanceId, transaction => this.roleConfig.recordUse(transaction, { sessionId: result.sessionId, role: 'router',
      revision: config.revision, router: config.roles.router.model, worker: config.roles.worker.model }))
  }

  private async routerBatch(effects: Effect[], signal: AbortSignal): Promise<EffectResult[]> {
    const requests = await Promise.allSettled(effects.map(effect => this.routerRequest(String(effect.payload.ticketId), effect.payload.type === 'report-ready')))
    return Promise.all(requests.map(async request => {
      if (request.status === 'rejected') return { type: 'unknown' as const, reason: 'The Router notification could not be prepared.' }
      if (!request.value) return { type: 'success' as const }
      try {
        await this.recordRouterSession(await this.sessions.run({ ...request.value, signal }))
        return { type: 'success' as const }
      } catch (error) {
        return error instanceof CoreError && error.code === 'ROUTER_NOTICE_UNHANDLED'
          ? { type: 'transient' as const, reason: error.message }
          : { type: 'unknown' as const, reason: 'The Router notification outcome requires reconciliation.' }
      }
    }))
  }

  private async recordRouterSession(result: { sessionId: string; events: readonly unknown[]; status: string }) {
    await this.storage.transaction(this.instanceId, async transaction => {
      const metadata = { id: result.sessionId, eventCount: result.events.length, role: 'router', status: result.status }
      if (!await transaction.replace('session', result.sessionId, metadata)) await transaction.insert('session', result.sessionId, metadata)
    })
  }

  private async worker(request: WorkerTurnRequest) {
    const { ticketId, inputId, resume = false, takeover = false, status = false, jobId, subagentId, contextHandoff = false, environmentHandoffId } = request
    const gate = await this.storage.transaction(this.instanceId, async transaction => ({
      takeoverPending: await isHostTakeoverPending(transaction, this.instanceId, this.hostEpoch?.()),
      record: await loadEnvironmentHandoff(transaction, ticketId),
      assignment: await transaction.get<Assignment>('assignment', ticketId),
    }))
    if (gate.takeoverPending) return 'waiting' as const
    if (gate.record && isEnvironmentHandoffActive(gate.record)) return 'waiting' as const
    if (environmentHandoffId && gate.record?.id !== environmentHandoffId) return 'waiting' as const
    if (!environmentHandoffId && isHandoffPromptPending(gate.record, gate.assignment?.id)) return 'waiting' as const
    const needsBinding = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      return Boolean(ticket && ticket.state === 'open' && !ticket.constraint
        && !await transaction.get<Assignment>('assignment', ticketId))
    })
    if (needsBinding) {
      const bound = await this.bindExecutionTarget(ticketId, false)
      if (!bound.assignmentId) return 'waiting' as const
    }
    let cancelledJobs: string[] = []
    let cancelledSubagents: string[] = []
    let confirmAfterStop = false
    const skipped = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      if (!ticket?.constraint) return false
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      if (ticket.constraint.kind === 'stopped') {
        if (assignment && assignment.state !== 'ended') await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
        const stop = await this.activeStop(transaction, ticketId)
        const live = await this.hasBackgroundWork(transaction, ticketId) || await this.previewCleanupPending(transaction, ticketId)
        // Background work that is only now being cancelled is not evidence of a quiet range; confirm it below.
        if (stop && !stop.pendingDeviceConfirmation && !live) {
          await transaction.replace('stop-state', stop.id, { ...stop, state: 'stopped', cancellationConfirmedAt: stop.cancellationConfirmedAt ?? Date.now() })
        }
        const intent = await transaction.get<Work['intent']>('intent', ticketId)
        if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'stopped' })
        const previewIds = await this.activePreviewJobs(transaction, ticketId)
        for (const jobId of previewIds) await this.jobs?.requestCancel(transaction, { ticketId, jobId, reason: 'stop' })
        if (this.jobs) cancelledJobs = [...await this.jobs.requestCancelTicket(transaction, { ticketId, reason: 'stop' }), ...previewIds]
        if (this.subagents) cancelledSubagents = await this.subagents.requestCancelTicket(transaction, { ticketId, reason: 'stop' })
        confirmAfterStop = cancelledJobs.length + cancelledSubagents.length > 0
      }
      return true
    })
    if (skipped) {
      await this.storage.transaction(this.instanceId, transaction => this.slots?.release(transaction, { ticketId }) ?? Promise.resolve(false))
      const stoppedJobs = await this.stopJobs(ticketId, cancelledJobs)
      const stoppedSubagents = await this.stopSubagents(ticketId, cancelledSubagents)
      const previewsPending = await this.storage.transaction(this.instanceId, transaction => this.previewCleanupPending(transaction, ticketId))
      // Only a fully confirmed stop earns the cancellation fact; otherwise the Ticket stays `stopping`.
      if (confirmAfterStop && !previewsPending && stoppedJobs.length === cancelledJobs.length && stoppedSubagents.length === cancelledSubagents.length) {
        await this.storage.transaction(this.instanceId, transaction => this.confirmStop(undefined, ticketId, transaction))
      }
      return 'skipped' as const
    }
    const admitted = await this.storage.transaction(this.instanceId, async transaction => {
      let assignment = await transaction.get<Assignment>('assignment', ticketId)
      const trigger = await this.trigger(transaction, ticketId)
      const ticket = (await transaction.get<Work['ticket']>('ticket', ticketId))!
      if (ticket.state !== 'open') throw new CoreError('TICKET_ENDED', 'The Ticket is not open for this Worker turn.')
      if (ticket.constraint) throw new CoreError('TICKET_BLOCKED', 'The Ticket constraint must be resolved before another Worker turn.')
      // An idle Assignment still reads as running, so only a live turn in this process proves a collision.
      if (this.workerControllers.has(ticketId)) throw new CoreError('TURN_ACTIVE', 'This Assignment already has an active Worker turn.')
      const job = jobId ? await this.jobs?.get(transaction, ticketId, jobId) : undefined
      // A completion of an earlier Assignment generation can never wake the current one.
      if (jobId && (!job || job.assignmentId !== assignment?.id || job.generation !== assignment.generation)) return { outcome: 'stale' as const }
      const subagent = subagentId ? await this.subagents?.get(transaction, ticketId, subagentId) : undefined
      if (subagentId && (!subagent || subagent.assignmentId !== assignment?.id || subagent.generation !== assignment.generation)) return { outcome: 'stale' as const }
      // A completion can be queued just before a handoff; it must not turn the ended Assignment back into a turn.
      if ((jobId || subagentId) && (!assignment || assignment.state !== 'running')) return { outcome: 'stale' as const }
      if (!assignment) {
        if (!inputId) throw new CoreError('NOT_FOUND', 'No active Assignment exists.')
        const environment = this.environments.find(candidate => candidate.config.id === trigger.environmentId)
        if (trigger.environmentId && !environment) throw new CoreError('ENVIRONMENT_DENIED', 'The accepted request has no authorized local Environment binding.')
        assignment = { id: randomUUID(), generation: randomUUID(), ticketId, sessionId: `worker-${randomUUID()}`, state: 'pending', createdAt: Date.now(), runtimeToken: this.runtimeToken,
          ...(environment ? { environment: environmentLocation(environment) } : {}) }
        await this.saveAssignment(transaction, assignment)
      } else if (assignment.state === 'ended' && assignment.runtimeToken !== this.runtimeToken) {
        // A stopped, handed-back or replaced generation is history; a follow-up continues in a new generation
        // and keeps the same Session so the Worker can still read the prior turn.
        if (!inputId) return { outcome: 'stale' as const }
        const previousReport = await transaction.get<ReadyReport>('report', ticketId)
        if (previousReport?.assignmentId === assignment.id) await transaction.remove('report', ticketId)
        assignment = { id: randomUUID(), generation: randomUUID(), ticketId, sessionId: assignment.sessionId, state: 'pending',
          createdAt: Date.now(), runtimeToken: this.runtimeToken,
          ...(assignment.environment ? { environment: structuredClone(assignment.environment) } : {}) }
        await this.saveAssignment(transaction, assignment)
      }
      const input = inputId ? await this.inputs.getInput(transaction, inputId) : undefined
      if (inputId && (!input || input.ticketId !== ticketId)) throw new CoreError('STALE_INPUT', 'The follow-up Input does not belong to this Ticket.')
      if (input?.delivery?.completedAt || input?.delivery?.exhaustedAt) return { outcome: 'consumed' as const }
      if (input?.delivery) {
        if (input.delivery.attempts >= maxDeliveryAttempts) {
          await this.exhaustInput(transaction, input)
          return { outcome: 'consumed' as const }
        }
        const ownership = await this.inputs.inputOwnership(transaction, input)
        if (!ownership || ownership.state !== 'owned') {
          await this.settleUnownedInput(transaction, input, ownership?.state)
          return { outcome: 'consumed' as const }
        }
        if (input.delivery.claimedAt !== undefined && !input.delivery.completedAt && input.delivery.assignmentId === assignment.id) {
          assignment = { ...assignment, id: randomUUID(), generation: randomUUID(), state: 'pending', createdAt: Date.now(), runtimeToken: this.runtimeToken }
          await this.saveAssignment(transaction, assignment)
        }
      }
      const handoff = await loadEnvironmentHandoff(transaction, ticketId)
      if (environmentHandoffId) {
        if (!handoff || handoff.id !== environmentHandoffId || handoff.state !== 'completed'
          || handoff.targetAssignmentId !== assignment.id) return { outcome: 'stale' as const }
        if (handoff.promptStartedAt !== undefined) return { outcome: 'stale' as const }
      } else if (isHandoffPromptPending(handoff, assignment.id)) {
        return { outcome: 'waiting' as const }
      }
      const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
      const cause: TurnCause = status ? 'status' : jobId || subagentId ? 'background' : input ? 'followup'
        : environmentHandoffId ? 'environment-handoff' : contextHandoff ? 'context-handoff' : takeover ? 'host-takeover'
          : resume ? 'resume' : 'launch'
      // A job or subagent completion is automatic input like a CI result: it wakes the Worker that started it but
      // never takes the person's extra slot.
      const activation = cause === 'status' ? 'status' : cause === 'background' ? 'background' : cause === 'followup' ? 'followup'
        : cause === 'launch' ? 'launch' : 'resume'
      if (!await this.admitSlot(transaction, assignment, { ticketId, activation })) return { outcome: 'waiting' as const }
      if (environmentHandoffId) await saveEnvironmentHandoffIn(transaction, { ...handoff!, promptStartedAt: Date.now() })
      assignment.state = 'running'
      await this.saveAssignment(transaction, assignment)
      await transaction.replace('intent', ticketId, { ...intent, state: 'running', reason: 'worker-running' })
      const claimed = input ? await this.inputs.claimDelivery(transaction, input, { assignmentId: assignment.id, sessionId: assignment.sessionId }) : undefined
      const environment = assignment.environment ? this.environments.find(candidate => candidate.config.id === assignment.environment!.id) : undefined
      if (assignment.environment && !environment) throw new CoreError('ENVIRONMENT_DENIED', 'The Assignment Environment is no longer configured.')
      return { outcome: 'admitted' as const, assignment, trigger, environment, input: claimed, job, subagent, cause }
    })
    if (admitted.outcome === 'stale') return 'skipped' as const
    if (admitted.outcome === 'consumed') return 'skipped' as const
    if (admitted.outcome === 'waiting') return 'waiting' as const
    const { assignment, trigger, environment, input, job, subagent, cause } = admitted
    try {
      return await this.runTurn({ ticketId, assignment, trigger, environment, input, cause, status, job, subagent })
    } catch (error) {
      await this.releaseSlot(ticketId, assignment.id)
      throw error
    }
  }

  private async runTurn({ ticketId, assignment, trigger, environment, input, cause, status, job, subagent }: {
    ticketId: string; assignment: Assignment; trigger: Work['trigger']; environment: ExecutionEnvironment | undefined; input: WorkInput | undefined
    cause: TurnCause; status: boolean; job: JobRecord | undefined; subagent: SubagentRecord | undefined
  }) {
    const controller = new AbortController()
    const environmentHandoff = cause === 'environment-handoff'
    this.workerControllers.set(ticketId, { assignmentId: assignment.id, controller })
    const stoppedBeforeRun = await this.storage.transaction(this.instanceId, async transaction => Boolean(await this.activeStop(transaction, ticketId)))
    if (stoppedBeforeRun) controller.abort()
    const toolFacts: ToolFact[] = []
    const artifacts: Artifact[] = []
    let reported = false
    let askedAttention: Attention | undefined
    let handedBack = false
    let bound: PreparedEnvironment | undefined
    if (environment) {
      try {
        if (!sameEnvironment(assignment.environment, environment)) throw new CoreError('ENVIRONMENT_CHANGED', 'The original Assignment device or working directory must be retained for setup retry.')
        if (assignment.environment) await this.verifyEnvironmentLocation(assignment.environment, environment, trigger.source.actorId)
        bound = await environment.prepare({ instanceId: this.instanceId, actorId: trigger.source.actorId }, controller.signal)
        await this.storage.transaction(this.instanceId, async transaction => {
          const setup: SetupState = { assignmentId: assignment.id, state: 'ready' }
          if (!await transaction.replace('setup', ticketId, setup)) await transaction.insert('setup', ticketId, setup)
          await this.slots?.phase(transaction, { ticketId, assignmentId: assignment.id, phase: 'turn' })
        })
      } catch (error) {
        if (controller.signal.aborted || await this.storage.transaction(this.instanceId, async transaction => Boolean(await this.activeStop(transaction, ticketId)))) {
          await this.storage.transaction(this.instanceId, transaction => this.slots?.release(transaction, { ticketId, assignmentId: assignment.id }) ?? Promise.resolve(false))
          await this.confirmStop(assignment.id, ticketId)
          this.workerControllers.delete(ticketId)
          return
        }
        await this.storage.transaction(this.instanceId, async transaction => {
          const setup: SetupState = { assignmentId: assignment.id, state: 'failed', code: error instanceof CoreError ? error.code : 'SETUP_FAILED', ...(error instanceof LocalSetupError ? { output: error.output } : {}) }
          if (!await transaction.replace('setup', ticketId, setup)) await transaction.insert('setup', ticketId, setup)
          const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
          await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'setup-failed' })
          const handoff = environmentHandoff ? await loadEnvironmentHandoff(transaction, ticketId) : undefined
          if (handoff?.promptStartedAt !== undefined && handoff.targetAssignmentId === assignment.id) {
            const { promptStartedAt: _promptStartedAt, ...pending } = handoff
            await saveEnvironmentHandoffIn(transaction, pending)
          }
          await this.saveAssignment(transaction, { ...assignment, state: 'pending' })
          await this.slots?.release(transaction, { ticketId, assignmentId: assignment.id })
        })
        this.workerControllers.delete(ticketId)
        return
      }
    }
    if (!environment) await this.storage.transaction(this.instanceId, transaction => this.slots?.phase(transaction, { ticketId, assignmentId: assignment.id, phase: 'turn' }) ?? Promise.resolve())
    const environmentTool = async (name: string, args: Record<string, string>, signal: AbortSignal) => {
      if (!bound) throw new CoreError('ENVIRONMENT_DENIED', 'No Environment is bound to this Assignment.')
      if (reported) throw new CoreError('REPORT_SEALED', 'Environment tools are sealed after the ready report; no later mutation is authorized.')
      if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'Environment tools are sealed after asking a human question.')
      if (toolFacts.length >= 24) throw new CoreError('TOOL_BUDGET', 'The Environment tool-call budget was exhausted.')
      if (name === 'run_command' && bound.planCommand) {
        const planned = bound.planCommand(args.name!, 'foreground')
        try {
          await this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The foreground Assignment is no longer current.')
            return this.jobs!.beginRemote(transaction, { ticketId, assignmentId: assignment.id, generation: assignment.generation,
              environmentId: assignment.environment!.id, command: args.name!, jobId: planned.jobId, remote: planned.remote })
          })
        } catch (error) {
          toolFacts.push({ tool: name, outcome: 'failed', output: { code: error instanceof CoreError ? error.code : 'START_NOT_RECORDED' } })
          throw error
        }
        this.jobs!.holdExternal(planned.jobId)
        try {
          try {
            const output = await bound.invoke(name, { ...args, jobId: planned.jobId }, signal)
            const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null
            const state = output.cancelled === true ? 'cancelled' : exitCode === null ? 'unknown' : 'exited'
            const remote: RemoteJobObservation = { ...planned.remote, deviceState: state, rangeSettled: true }
            if (state === 'unknown') {
              await this.storage.transaction(this.instanceId, transaction => this.jobs!.markRemoteUnknown(transaction, {
                ticketId, jobId: planned.jobId, remote, reason: 'The foreground command range is quiet, but its exit status was not observed.' }))
            } else {
              await this.storage.transaction(this.instanceId, transaction => this.jobs!.applyRemoteTerminal(transaction, {
                ticketId, jobId: planned.jobId, state, remote, exitCode,
                output: { stdout: { text: typeof output.stdout === 'string' ? output.stdout : '', lossy: output.truncated === true },
                  stderr: { text: typeof output.stderr === 'string' ? output.stderr : '', lossy: output.truncated === true } } }))
            }
            const success = state === 'exited' && exitCode === 0 && output.cancelled !== true && output.truncated !== true
            const summary = JSON.parse(JSON.stringify(output, (_key, value) => typeof value === 'string' ? value.slice(0, 2000) : value))
            toolFacts.push({ tool: name, outcome: success ? 'success' : 'failed', output: summary })
            return JSON.stringify(output)
          } catch (error) {
            const code = error instanceof CoreError ? error.code : 'ENVIRONMENT_TOOL_FAILED'
            const reason = error instanceof CoreError ? error.message : 'The bound Environment operation failed.'
            await this.storage.transaction(this.instanceId, transaction => this.jobs!.markRemoteUnknown(transaction, {
              ticketId, jobId: planned.jobId, remote: { ...planned.remote, deviceState: 'unknown', rangeSettled: false,
                recovery: { observedAt: Date.now(), kind: 'unverifiable', processAlive: 'unknown', rangeAlive: 'unknown',
                  rangeEvidence: 'none', reason } }, reason })).catch(() => undefined)
            toolFacts.push({ tool: name, outcome: 'failed', output: { code } })
            throw new CoreError(code, 'The bound Environment operation failed; check the tool fact and authorized directory.')
          }
        } finally {
          this.jobs!.releaseExternal(planned.jobId)
        }
      }
      try {
        const output = await bound.invoke(name, args, signal)
        const success = name !== 'run_command' || output.exitCode === 0 && !output.cancelled && !output.truncated
        const summary = JSON.parse(JSON.stringify(output, (_key, value) => typeof value === 'string' ? value.slice(0, 2000) : value))
        toolFacts.push({ tool: name, outcome: success ? 'success' : 'failed', output: summary })
        return JSON.stringify(output)
      } catch (error) {
        const code = error instanceof CoreError ? error.code : 'ENVIRONMENT_TOOL_FAILED'
        toolFacts.push({ tool: name, outcome: 'failed', output: { code } })
        throw new CoreError(code, 'The bound Environment operation failed; check the tool fact and authorized directory.')
      }
    }
    const writeTool: NativeTool = { name: 'write_file', description: 'Write UTF-8 text inside the bound Environment.', parameters: { path: { type: 'string', required: true }, text: { type: 'string', required: true } }, execute: (args, signal) => environmentTool('write_file', args, signal) }
    const readTool: NativeTool = { name: 'read_file', description: 'Read UTF-8 text inside the bound Environment.', parameters: { path: { type: 'string', required: true } }, execute: (args, signal) => environmentTool('read_file', args, signal) }
    const globTool: NativeTool = { name: 'glob', description: 'Find files by glob inside the bound Environment.', parameters: { pattern: { type: 'string', required: true } }, execute: (args, signal) => environmentTool('glob', args, signal) }
    const grepTool: NativeTool = { name: 'grep', description: 'Search for literal text inside the bound Environment.', parameters: { pattern: { type: 'string', required: true } }, execute: (args, signal) => environmentTool('grep', args, signal) }
    const saveAttachmentTool: NativeTool = { name: 'save_attachment', description: 'Save exact bytes into the bound Environment\'s own attachment store and return a traceable reference. This never writes a Host file for a remote world.',
      parameters: { name: { type: 'string', required: true }, data: { type: 'string', required: true }, encoding: { type: 'string', required: true },
        mediaType: { type: 'string', required: true } },
      execute: (args, signal) => environmentTool('save_attachment', args, signal) }
    const readAssetTool: NativeTool = { name: 'read_asset', description: 'Read one bounded byte page from an attachment, artifact, spill or skill reference inside the same execution world. Use nextOffset for the next page; a truncated page is not the full object.',
      parameters: { kind: { type: 'string', required: true }, id: { type: 'string', required: true }, sha256: { type: 'string', required: true },
        bytes: { type: 'string', required: true }, offset: { type: 'string', required: true }, maxBytes: { type: 'string', required: true },
        path: { type: 'string', required: true } },
      execute: (args, signal) => environmentTool('read_asset', args, signal) }
    const listSkillsTool: NativeTool = { name: 'list_skills', description: 'List the model-invocable skills discovered by the bound Environment\'s public skill provider. A name is not loaded content; read it with read_asset kind=skill.',
      parameters: {}, execute: (_args, signal) => environmentTool('list_skills', {}, signal) }
    const commandNames = environment ? environmentCommandNames(environment).filter(name => name !== environment.config.setup) : []
    const hasCommand = environmentHasCommand(environment)
    const commandTool: NativeTool = { name: 'run_command', description: `Run one configured command inside the bound Environment: ${commandNames.join(', ')}.`, parameters: { name: { type: 'string', required: true } }, execute: (args, signal) => environmentTool('run_command', args, signal) }
    const allowed = new Set(environment?.config.permissions ?? [])
    const assets = environment?.assetSupport
    const readAsset = Boolean(environment)
    const environmentTools: NativeTool[] = bound ? environment?.kind === 'local' ? [
      writeTool, readTool, globTool, grepTool,
      ...(assets?.attachments ? [saveAttachmentTool] : []),
      ...(readAsset ? [readAssetTool] : []),
      ...(assets?.skills ? [listSkillsTool] : []),
      ...(hasCommand ? [commandTool] : []),
    ] : [
      ...(allowed.has('write') ? [writeTool] : []),
      ...(allowed.has('read') ? [readTool] : []),
      ...(allowed.has('search') ? [globTool, grepTool] : []),
      ...(allowed.has('write') && assets?.attachments ? [saveAttachmentTool] : []),
      ...(allowed.has('read') && readAsset ? [readAssetTool] : []),
      ...(allowed.has('read') && assets?.skills ? [listSkillsTool] : []),
      ...(hasCommand ? [commandTool] : []),
    ] : []
    /**
     * A child gets the same local capabilities but its own accounting: its calls must not consume the parent's
     * tool budget or satisfy the parent's verification rule for `report_ready`.
     */
    const childTools = (): NativeTool[] => bound ? environmentTools.map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (args: Record<string, string>, signal: AbortSignal) => JSON.stringify(await bound!.invoke(tool.name, args, signal)),
    })) : []
    // Background work outlives the turn: the tool returns a job identity at once, and the completion event
    // arrives as a later turn on this same Session instead of holding the Router or this step open.
    const jobTools: NativeTool[] = bound?.startCommand && this.jobs && hasCommand ? [
      {
        name: 'start_command',
        description: `Start one configured command in the background and return its job identity at once: ${commandNames.join(', ')}. Do not wait for it in this turn; its completion arrives as a later event.`,
        parameters: { name: { type: 'string', required: true } },
        execute: async (args: Record<string, string>) => {
          if (reported) throw new CoreError('REPORT_SEALED', 'Background work is sealed after the ready report; no later mutation is authorized.')
          if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'Background work is sealed after asking a human question.')
          if (bound!.planCommand) {
            const planned = bound!.planCommand(args.name!, 'background')
            const intent = await this.storage.transaction(this.instanceId, async transaction => {
              const current = await transaction.get<Assignment>('assignment', ticketId)
              if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The starting Assignment is no longer current.')
              return this.jobs!.beginRemote(transaction, { ticketId, assignmentId: assignment.id, generation: assignment.generation,
                environmentId: assignment.environment!.id, command: args.name!, jobId: planned.jobId, remote: planned.remote })
            })
            let job
            try { job = await bound!.startCommand!(args.name!, planned.jobId) }
            catch (error) {
              await this.storage.transaction(this.instanceId, transaction => this.jobs!.failRemoteStart(transaction, {
                ticketId, jobId: intent.id, reason: error instanceof CoreError ? error.message : 'The device start request failed.' }))
              throw error
            }
            let record: JobRecord | undefined
            try {
              record = await this.storage.transaction(this.instanceId, transaction => this.jobs!.activateRemote(transaction, {
                ticketId, jobId: intent.id, job, ...(job.remote ? { remote: job.remote } : {}) }))
            } catch (error) {
              this.jobs!.abandon(job)
              await this.storage.transaction(this.instanceId, transaction => this.jobs!.failRemoteStart(transaction, {
                ticketId, jobId: intent.id,
                reason: error instanceof CoreError ? error.message : 'The device start response could not be activated.' })).catch(() => {})
              throw error
            }
            if (!record || record.state !== 'running') throw new CoreError('INCOMPLETE_STATE', 'The background job start did not activate.')
            this.jobs!.attach(record)
            return JSON.stringify({ jobId: record.id, command: record.command, state: record.state, startedAt: record.startedAt })
          }
          const job = await bound!.startCommand!(args.name!)
          let record: JobRecord | undefined
          try {
            record = await this.storage.transaction(this.instanceId, async transaction => {
              const current = await transaction.get<Assignment>('assignment', ticketId)
              if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The starting Assignment is no longer current.')
              return this.jobs!.start(transaction, { ticketId, assignmentId: assignment.id, generation: assignment.generation,
                environmentId: assignment.environment!.id, environmentKind: environment?.kind ?? 'local', command: args.name!, job })
            })
          } catch (error) {
            this.jobs!.abandon(job)
            throw error
          }
          if (!record) throw new CoreError('INCOMPLETE_STATE', 'The background job start did not record a job.')
          this.jobs!.attach(record)
          return JSON.stringify({ jobId: record.id, command: record.command, state: record.state, startedAt: record.startedAt })
        },
      },
      {
        name: 'job_status',
        description: 'Read one background job of this Ticket: state, confirmed exit and bounded output. A running job is not a result, and an unconfirmed exit stays unknown.',
        parameters: { jobId: { type: 'string', required: true } },
        execute: async (args: Record<string, string>) => JSON.stringify(await this.jobs!.read(ticketId, args.jobId!)),
      },
      {
        name: 'read_job_output',
        description: 'Page through the complete durable output of one background job in this same Execution Environment. The returned spill reference can be read again by read_asset after a disconnect; a page is not proof of completion.',
        parameters: { jobId: { type: 'string', required: true }, stream: { type: 'string', required: true },
          offset: { type: 'string', required: true }, maxBytes: { type: 'string', required: true } },
        execute: async (args: Record<string, string>, signal: AbortSignal) => {
          if (!bound?.spillReference || !bound.readAsset) {
            throw new CoreError('UNSUPPORTED_CAPABILITY', 'This Environment does not expose a durable spill reference.')
          }
          const record = await this.storage.transaction(this.instanceId, transaction => this.jobs!.get(transaction, ticketId, args.jobId!))
          if (!record) throw new CoreError('NOT_FOUND', 'The background job does not belong to this Ticket.')
          if (record.environmentId !== assignment.environment?.id) {
            throw new CoreError('ENVIRONMENT_DENIED', 'The job belongs to a different Execution Environment.')
          }
          const stream = args.stream === 'stderr' ? 'stderr' : 'stdout'
          const offset = args.offset ? Number(args.offset) : 0
          const maxBytes = args.maxBytes ? Number(args.maxBytes) : 8192
          const reference = await bound.spillReference(record.id, stream, signal)
          const page = await bound.readAsset(reference, { offset, maxBytes }, signal)
          return JSON.stringify({ jobId: record.id, state: record.state, reference, page })
        },
      },
      {
        name: 'keep_preview',
        description: 'Explicitly retain one running managed job as a human acceptance preview. It survives a ready handoff, holds no execution slot, and its exit does not wake the Worker.',
        parameters: { jobId: { type: 'string', required: true }, purpose: { type: 'string', required: true }, artifact: { type: 'string', required: true } },
        execute: async (args: Record<string, string>, signal: AbortSignal) => {
          if (reported) throw new CoreError('REPORT_SEALED', 'A preview cannot be created after the ready report.')
          if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'A preview cannot be created after asking a human question.')
          const purpose = args.purpose?.trim() ?? ''
          if (!purpose || Buffer.byteLength(purpose) > 2048) throw new CoreError('INVALID_INPUT', 'A preview needs a bounded nonempty purpose.')
          const path = args.artifact?.trim() ?? ''
          if (!path) throw new CoreError('INVALID_INPUT', 'A preview needs one bounded artifact path.')
          const artifact = await bound!.artifact(path, signal)
          const preview = await this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The starting Assignment is no longer current.')
            const preview = await this.jobs!.retainAsPreview(transaction, { ticketId, jobId: args.jobId!, assignmentId: assignment.id,
              generation: assignment.generation, purpose, artifact })
            return preview
          })
          await this.jobs!.clearPreviewWait(ticketId, preview.jobId)
          return JSON.stringify({ previewId: preview.id, jobId: preview.jobId, state: preview.state, holdsSlot: false })
        },
      },
      {
        name: 'cancel_job',
        description: 'Cancel one running background job of this Ticket and record why.',
        parameters: { jobId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
        execute: async (args: Record<string, string>) => {
          const reason = args.reason?.trim() ?? ''
          if (!reason || Buffer.byteLength(reason) > 2048) throw new CoreError('INVALID_INPUT', 'A job cancellation needs a bounded reason.')
          if (reported) throw new CoreError('REPORT_SEALED', 'Background work is sealed after the ready report.')
          const requested = await this.storage.transaction(this.instanceId, async transaction => {
            if (await this.jobs!.isPreview(transaction, ticketId, args.jobId!)) {
              throw new CoreError('PREVIEW_REQUIRES_CANCEL_PREVIEW', 'Use cancelPreview or stopTicket to end an acceptance preview.')
            }
            return this.jobs!.requestCancel(transaction, { ticketId, jobId: args.jobId!, reason: 'worker' })
          })
          const [confirmed] = await this.jobs!.stopRanges([requested.id])
          let final: JobRecord | undefined
          try {
            final = await this.storage.transaction(this.instanceId, transaction => confirmed
              ? this.jobs!.confirmCancelled(transaction, { ticketId, jobId: requested.id, ...(confirmed.output ? { output: confirmed.output } : {}) })
              : this.jobs!.markUnconfirmed(transaction, { ticketId, jobId: requested.id }))
          } finally { this.jobs!.finishStopped([requested.id]) }
          return JSON.stringify({ jobId: requested.id, state: final?.state, cancelReason: requested.cancelReason })
        },
      },
    ] : []
    let statusFact: string | undefined
    // Delegation hands a child Agent the parent's own already-authorised work tools and bound directory. Router
    // tools, delivery tools, subscription changes and further delegation are never in that list.
    const subagentTools: NativeTool[] = bound && this.subagents ? (() => {
      // Only the parent's own work tools are inherited. Job tools are Ticket-wide closures: handing them down
      // would let a child see or cancel its parent's jobs, and the reference kills a subagent's jobs with it.
      const inherited = childTools()
      return [{
        name: 'delegate_subagent',
        description: 'Delegate one bounded subtask to a child Agent that inherits this Assignment\'s working directory, permissions and work tools. It starts at once and its completion arrives as a later event; do not wait in this turn.',
        parameters: { task: { type: 'string', required: true } },
        execute: async (args: Record<string, string>, _signal: AbortSignal, caller?: Agent) => {
          if (reported) throw new CoreError('REPORT_SEALED', 'Delegation is sealed after the ready report; no later mutation is authorized.')
          if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'Delegation is sealed after asking a human question.')
          const task = args.task?.trim() ?? ''
          if (!task || Buffer.byteLength(task) > 16384) throw new CoreError('INVALID_INPUT', 'A subtask needs bounded nonempty text.')
          // A child never delegates again: only the parent's work tools travel down.
          const tools = inherited.filter(tool => tool.name !== 'delegate_subagent')
          // DSH reports the exact calling Agent; the child is registered under that same live parent.
          const parent = caller ?? this.sessions.agentOf(assignment.sessionId)
          if (!parent) throw new CoreError('STALE_ASSIGNMENT', 'The delegating Worker Session is no longer live.')
          const ticket = (await this.storage.transaction(this.instanceId, transaction => transaction.get<Work['ticket']>('ticket', ticketId)))!
          const scope = {
            parent, cwd: bound!.cwd, environmentId: assignment.environment!.id, mandateId: ticket.mandateId, tools,
            model: this.sessions.workerRoute,
            authorize: async (tx: AsyncTx) => {
              const current = await tx.get<Assignment>('assignment', ticketId)
              if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The delegating Assignment is no longer current.')
              const now = await tx.get<Work['ticket']>('ticket', ticketId)
              if (!now || now.state !== 'open' || now.constraint) throw new CoreError('TICKET_BLOCKED', 'A stopped or waiting Ticket cannot delegate work.')
              if (now.mandateId !== ticket.mandateId) throw new CoreError('MANDATE_CHANGED', 'The delegating Mandate is no longer the Ticket\'s current Mandate.')
            },
            guard: async () => {
              await this.storage.transaction(this.instanceId, async transaction => {
                const live = await this.subagents!.get(transaction, ticketId, id)
                if (!live || live.state !== 'running') throw new CoreError('SUBAGENT_CANCELLED', 'This subtask is no longer running.')
                const current = await transaction.get<Assignment>('assignment', ticketId)
                if (current?.id !== assignment.id || current.state === 'ended') throw new CoreError('STALE_ASSIGNMENT', 'The delegating Assignment is no longer current.')
                // A Mandate change mid-subtask must stop the child from acting under the old one.
                const now = await transaction.get<Work['ticket']>('ticket', ticketId)
                if (!now || now.state !== 'open' || now.constraint) throw new CoreError('TICKET_BLOCKED', 'The Ticket is no longer open for this subtask.')
                if (now.mandateId !== ticket.mandateId) throw new CoreError('MANDATE_CHANGED', 'The delegating Mandate is no longer the Ticket\'s current Mandate.')
              })
            },
          }
          const id = randomUUID()
          let record: SubagentRecord
          try {
            record = await this.storage.transaction(this.instanceId, transaction => this.subagents!.start(transaction, {
              id, ticketId, assignmentId: assignment.id, generation: assignment.generation, mandateId: ticket.mandateId, task, scope,
            }))
          } catch (error) {
            this.subagents!.abandon(id)
            throw error
          }
          this.subagents!.attach(record, scope)
          return JSON.stringify({ subagentId: record.id, state: record.state, startedAt: record.startedAt })
        },
      }, {
        name: 'subagent_status',
        description: 'Read one child Agent of this Ticket: state and its bounded result. A running child is not a result.',
        parameters: { subagentId: { type: 'string', required: true } },
        execute: async (args: Record<string, string>) => {
          const record = await this.storage.transaction(this.instanceId, transaction => this.subagents!.get(transaction, ticketId, args.subagentId!))
          if (!record) throw new CoreError('NOT_FOUND', 'The subagent does not belong to this Ticket.')
          return JSON.stringify({ subagentId: record.id, state: record.state, ...(record.result ? { result: record.result } : {}), ...(record.reason ? { reason: record.reason } : {}) })
        },
      }, {
        name: 'cancel_subagent',
        description: 'Cancel one running child Agent of this Ticket and record why.',
        parameters: { subagentId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
        execute: async (args: Record<string, string>) => {
          const reason = args.reason?.trim() ?? ''
          if (!reason || Buffer.byteLength(reason) > 2048) throw new CoreError('INVALID_INPUT', 'A subagent cancellation needs a bounded reason.')
          if (reported) throw new CoreError('REPORT_SEALED', 'Delegation is sealed after the ready report.')
          const requested = await this.storage.transaction(this.instanceId, transaction =>
            this.subagents!.requestCancel(transaction, { ticketId, id: args.subagentId!, reason: 'worker' }))
          const stopped = await this.stopSubagents(ticketId, [requested.id])
          return JSON.stringify({ subagentId: requested.id, state: stopped.length ? 'cancelled' : requested.state, cancelReason: requested.cancelReason })
        },
      }]
    })() : []
    // A status turn reports facts only: it gets a single restricted tool and none of the delivery tools,
    // so it cannot turn an idle Ticket into a result, a question or a subscription change.
    const statusTools: NativeTool[] = status ? [{
      name: 'report_status', description: 'State the current status in one short bounded sentence. This records a fact only; it cannot complete the Ticket.',
      parameters: { text: { type: 'string', required: true } },
      execute: async (args: Record<string, string>) => {
        const text = args.text?.trim() ?? ''
        if (!text || Buffer.byteLength(text) > 2048) throw new CoreError('INVALID_STATUS', 'A status report needs bounded nonempty text.')
        statusFact = text
        return 'Status recorded.'
      },
    }] : []
    const contextTool: NativeTool = {
      name: 'read_context',
      description: 'Read one bounded page of the original request, acceptance decision, mandate, ready report, human question, delivery or reachable source event. Pass an empty string for unused fields. Use pagination.cursor for the next page; a truncated page is not the full text.',
      parameters: { kind: { type: 'string', required: true }, id: { type: 'string', required: true }, threadId: { type: 'string', required: true },
        objectId: { type: 'string', required: true }, after: { type: 'string', required: true }, maxBytes: { type: 'string', required: true } },
      execute: async (args: Record<string, string>) => {
        const kind = args.kind as ContextKind
        return JSON.stringify(await this.context.read({ ticketId, ref: { kind, ticketId,
          ...(args.id ? { id: args.id } : {}), ...(args.threadId ? { threadId: args.threadId } : {}), ...(args.objectId ? { objectId: args.objectId } : {}) },
          ...(args.after ? { after: args.after } : {}), ...(args.maxBytes ? { maxBytes: Number(args.maxBytes) } : {}) }))
      },
    }
    let turnMessageId: string | undefined
    let turnText: string | undefined
    if (input?.delivery) {
      const delivery = input.delivery
      const found = delivery.persistedAt === undefined ? await this.sessions.hasMessage(delivery.sessionId, delivery.messageId) : undefined
      const persisted = delivery.persistedAt !== undefined || found?.found === true
      if (found?.found) {
        await this.storage.transaction(this.instanceId, transaction => this.inputs.recordPersisted(transaction, input.id, delivery.messageId, found.seq!))
      }
      if (persisted) {
        if (delivery.recoveryAttempts >= maxRecoveryAttempts) {
          await this.storage.transaction(this.instanceId, transaction => this.exhaustInput(transaction, input))
          this.workerControllers.delete(ticketId)
          await this.releaseSlot(ticketId, assignment.id)
          return
        }
        const recovery = await this.storage.transaction(this.instanceId, transaction => this.inputs.beginRecovery(transaction, input.id))
        turnMessageId = recovery.delivery!.recoveryMessageId
        await this.storage.transaction(this.instanceId, transaction => this.inputs.recordSent(transaction, input.id))
        turnText = `Recovery attempt ${recovery.delivery!.recoveryAttempts}: a persisted follow-up was interrupted before it was completed. Do not repeat destructive work. `
          + `Inspect the Session history, files, version control and external state, then continue and complete this request:\n\n${input.text}`
      } else {
        turnMessageId = delivery.messageId
        await this.storage.transaction(this.instanceId, transaction => this.inputs.recordSent(transaction, input.id))
        turnText = input.text
      }
    }
    const activeConfig = await this.roleConfig.currentView()
    this.sessions.setRoutes(activeConfig.roles.router.model, activeConfig.roles.worker.model)
    this.sessions.setRoleInstructions(activeConfig.roles.router, activeConfig.roles.worker)
    let outcome
    try {
      outcome = await this.sessions.run({ sessionId: assignment.sessionId, role: 'worker',
        ...(turnMessageId === undefined ? {} : { messageId: turnMessageId }),
        ...(input ? { onMessagePersisted: async (seq: number) => {
          await this.storage.transaction(this.instanceId, transaction => this.inputs.recordPersisted(transaction, input.id, turnMessageId!, seq))
        } } : {}),
        text: turnText ?? await this.turnTextFor(cause, ticketId, trigger, input, job, subagent),
        instructions: activeConfig.roles.worker.instructions, skills: activeConfig.roles.worker.skills,
        ...(bound ? { cwd: bound.cwd } : {}), signal: controller.signal, tools: status ? statusTools : [
      contextTool,
      ...environmentTools,
      ...jobTools,
      ...subagentTools,
      {
        name: 'add_thread_subscription',
        description: 'Attach an unrelated Thread inside the configured source scope. Mode worker assigns future human follow-ups; mode context supplies background only.',
        parameters: { threadId: { type: 'string' as const, required: true as const }, mode: { type: 'string' as const, required: true as const }, reason: { type: 'string' as const, required: true as const } },
        execute: async (args: Record<string, string>) => {
          if (reported || askedAttention) throw new CoreError('REPORT_SEALED', 'Subscription changes are sealed after completion or a human question.')
          const mode = args.mode
          if (mode !== 'worker' && mode !== 'context') throw new CoreError('INVALID_INPUT', 'Thread subscription mode is worker or context.')
          const threadId = args.threadId, reason = args.reason
          if (!threadId || !reason) throw new CoreError('INVALID_INPUT', 'A Thread subscription requires threadId and reason.')
          return this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The subscription Assignment is no longer current.')
            const subscription = await this.inputs.addSubscription(transaction, ticketId, threadId, 'worker', false, mode, reason, assignment.id)
            return JSON.stringify(subscription)
          })
        },
      },
      {
        name: 'remove_thread_subscription',
        description: 'Remove an unrelated Thread subscription added by this Assignment. Original and source-bound Threads remain protected.',
        parameters: { threadId: { type: 'string' as const, required: true as const }, reason: { type: 'string' as const, required: true as const } },
        execute: async (args: Record<string, string>) => {
          if (reported || askedAttention) throw new CoreError('REPORT_SEALED', 'Subscription changes are sealed after completion or a human question.')
          const threadId = args.threadId, reason = args.reason
          if (!threadId || !reason) throw new CoreError('INVALID_INPUT', 'Removing a Thread subscription requires threadId and reason.')
          return this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The subscription Assignment is no longer current.')
            const decision = await this.inputs.removeWorkerSubscription(transaction, ticketId, threadId, reason, assignment.id)
            return JSON.stringify(decision)
          })
        },
      },
      ...(input ? [{
        name: 'handback_input',
        description: 'Hand this follow-up back to Router because it is outside the original Ticket scope or needs reassignment. Include a concrete reason.',
        parameters: { reason: { type: 'string' as const, required: true as const } },
        execute: async (args: Record<string, string>) => {
          if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'The message is already waiting for a human.')
          const reason = args.reason
          if (!reason?.trim() || Buffer.byteLength(reason) > 2048) throw new CoreError('INVALID_INPUT', 'Handback needs a bounded reason.')
          return this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The handing-back Assignment is no longer current.')
            const ownership = await this.inputs.handback(transaction, ticketId, input.id, reason)
            if (ownership.state === 'handed-back') {
              handedBack = true
              await this.inputs.completeDelivery(transaction, input.id, 'handback')
            }
            return JSON.stringify({ ticketId, inputId: input.id, state: ownership.state, reason })
          })
        },
      }] : []),
      {
        name: 'ask_human',
        description: 'Ask one concise structured question when a human decision is required. Consequential or ambiguous actions must wait for an authorized answer.',
        parameters: { question: { type: 'string' as const, required: true as const }, options: { type: 'string' as const, required: true as const } },
        execute: async (args: Record<string, string>) => {
          if (reported || askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'The Worker turn has already completed or asked a question.')
          const options = (args.options ?? '').split('\n').map(option => option.trim()).filter(Boolean)
          askedAttention = await this.storage.transaction(this.instanceId, async transaction => {
            const current = await transaction.get<Assignment>('assignment', ticketId)
            if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The asking Assignment is no longer current.')
            const attention = await this.attentions.ask(transaction, { ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId,
              question: args.question ?? '', options, ...(input ? { input } : {}) })
            if (input) await this.inputs.completeDelivery(transaction, input.id, 'attention')
            return attention
          })
          return JSON.stringify({ attentionId: askedAttention.id, question: askedAttention.question, options: askedAttention.options })
        },
      },
      {
      name: 'report_ready', description: 'Record a completed answer and concrete verification evidence for the original request.',
      parameters: { result: { type: 'string', required: true }, evidence: { type: 'string', required: true }, ...(bound ? { artifacts: { type: 'string' as const, required: true as const } } : {}) },
      execute: async (args, signal) => {
        if (askedAttention) throw new CoreError('ATTENTION_ACTIVE', 'A ready report cannot be submitted while a human answer is pending.')
        for (const value of [args.result!, args.evidence!]) if (!value?.trim() || Buffer.byteLength(value) > 16384) throw new CoreError('INVALID_REPORT', 'A ready report needs bounded nonempty result and verification evidence.')
        if (bound) {
          const lastWrite = toolFacts.findLastIndex(fact => fact.tool === 'write_file' && fact.outcome === 'success')
          const verified = hasCommand
            ? toolFacts.some((fact, index) => index > lastWrite && fact.tool === 'run_command' && fact.outcome === 'success')
            : toolFacts.some((fact, index) => index > lastWrite && (fact.tool === 'read_file' || fact.tool === 'grep') && fact.outcome === 'success')
          if (!verified) throw new CoreError('VERIFICATION_REQUIRED', hasCommand
            ? 'A ready report needs a successful configured verification command after the last file write.'
            : 'This Environment has no command capability; read or search the written file successfully before the ready report.')
          const rawArtifacts = typeof args.artifacts === 'string' ? args.artifacts : ''
          const paths = [...new Set(rawArtifacts.split('\n').map((path: string) => path.trim()).filter(Boolean))]
          if (!paths.length || paths.length > 10) throw new CoreError('INVALID_REPORT', 'Provide one to ten newline-separated relative artifact paths.')
          artifacts.splice(0)
          for (const path of paths) artifacts.push(await bound.artifact(path, signal))
        }
        return this.storage.transaction(this.instanceId, async transaction => {
          const current = await transaction.get<Assignment>('assignment', ticketId)
          if (current?.id !== assignment.id || current.state !== 'running') throw new CoreError('STALE_ASSIGNMENT', 'The reporting Assignment is no longer current.')
          const existing = await transaction.get<ReadyReport>('report', ticketId)
          if (existing && !input) return existing.id
          const report: ReadyReport = { id: randomUUID(), ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId, kind: 'ready', result: bound ? bound.sanitize(args.result!) : args.result!, evidence: bound ? bound.sanitize(args.evidence!) : args.evidence!, artifacts: structuredClone(artifacts), toolFacts: structuredClone(toolFacts),
            ...(input ? { inputId: input.id } : {}), directionVersion: input?.directionVersion ?? 1, createdAt: Date.now() }
          const historyKey = `${JSON.stringify(['report-history', ticketId])}:${report.id}`
          if (!await transaction.replace('report-history', historyKey, report)) await transaction.insert('report-history', historyKey, report)
          if (!await transaction.replace('report', ticketId, report)) await transaction.insert('report', ticketId, report)
          if (input) await this.inputs.completeDelivery(transaction, input.id, 'ready')
          reported = true
          return report.id
        })
      },
      },
    ] })
    } catch (error) {
      if (controller.signal.aborted || await this.storage.transaction(this.instanceId, async transaction => Boolean(await this.activeStop(transaction, ticketId)))) {
        // The turn is quiet, but its background work may not be: the stop's own path cancels it and confirms.
        if (!await this.hasLiveBackgroundWork(ticketId)) await this.confirmStop(assignment.id, ticketId)
        await this.releaseSlot(ticketId, assignment.id)
        return
      }
      throw error
    } finally {
      this.workerControllers.delete(ticketId)
    }
    const turnEnd = outcome.events.findLast(event => (event as { type?: string }).type === 'turn/end') as { data?: { reason?: { kind?: string } } } | undefined
    if (turnEnd?.data?.reason?.kind === 'max-tokens' && !reported && !askedAttention && !handedBack) {
      const rollover = await this.rolloverSession(ticketId, assignment, trigger, outcome.forkedSessionId)
      if (rollover) {
        await this.releaseSlot(ticketId, assignment.id)
        return
      }
    }
    let endedJobs: string[] = []
    let endedSubagents: string[] = []
    let releasedInTransaction = false
    const keepSlot = await this.storage.transaction(this.instanceId, async transaction => {
      if (await this.activeStop(transaction, ticketId)) {
        // Background work is cancelled and confirmed after this transaction; claiming `stopped` here would be a lie.
        if (!await this.hasBackgroundWork(transaction, ticketId) && !await this.previewCleanupPending(transaction, ticketId)) {
          await this.confirmStop(assignment.id, ticketId, transaction)
        }
        await this.slots?.release(transaction, { ticketId, assignmentId: assignment.id })
        releasedInTransaction = true
        return false
      }
      const sessionMetadata = { id: outcome.sessionId, eventCount: outcome.events.length, ticketId, role: 'worker', status: outcome.status }
      if (!await transaction.replace('session', outcome.sessionId, sessionMetadata)) await transaction.insert('session', outcome.sessionId, sessionMetadata)
      await this.roleConfig.recordUse(transaction, { sessionId: outcome.sessionId, role: 'worker', revision: activeConfig.revision,
        router: activeConfig.roles.router.model, worker: activeConfig.roles.worker.model })
      if (status && statusFact) {
        const fact: StatusReport = { id: `${JSON.stringify(['status-report', ticketId])}:${randomUUID()}`, ticketId, assignmentId: assignment.id, text: statusFact, createdAt: Date.now() }
        if (!await transaction.replace('status-report', `${JSON.stringify(['status-report', ticketId])}:current`, fact)) await transaction.insert('status-report', `${JSON.stringify(['status-report', ticketId])}:current`, fact)
        await transaction.insert('status-history', fact.id, fact)
      }
      if (input) {
        const persisted = outcome.events.find(event => {
          const candidate = event as { type?: string; data?: { id?: string } }
          return candidate.type === 'user/message' && candidate.data?.id === turnMessageId
        }) as { seq?: number } | undefined
        if (persisted?.seq !== undefined) await this.inputs.recordPersisted(transaction, input.id, turnMessageId!, Number(persisted.seq))
        const completed = askedAttention ? 'attention' as const : reported ? 'ready' as const : handedBack ? 'handback' as const : undefined
        if (completed) await this.inputs.completeDelivery(transaction, input.id, completed)
      }
      const report = await transaction.get<ReadyReport>('report', ticketId)
      const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
      if (askedAttention) {
        await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'waiting-human' })
        await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
        endedJobs = await this.endAssignmentJobs(transaction, ticketId, assignment.id)
        // A handoff to a person stops the related subagents; only the Worksheet keeps a review server running.
        endedSubagents = await this.endAssignmentSubagents(transaction, ticketId, assignment.id)
        await this.slots?.release(transaction, { ticketId, assignmentId: assignment.id })
        releasedInTransaction = true
        return false
      }
      // Background work keeps its slot and keeps the Ticket working; it is not an idle Ticket and no report
      // is owed yet. Its completion event wakes this same Assignment on this same slot.
      if (!report && await this.hasBackgroundWork(transaction, ticketId, assignment.id)) {
        await transaction.replace('intent', ticketId, { ...intent, state: 'running', reason: 'worker-background' })
        return true
      }
      await transaction.replace('intent', ticketId, { ...intent, state: report ? 'ready' : 'running', reason: report ? 'ready-report' : 'worker-idle' })
      if (report) {
        await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
        await this.effects.enqueue(transaction, { key: report.id, stream: 'notice', scope: 'router', payload: { type: 'report-ready', ticketId, reportId: report.id } })
        endedJobs = await this.endAssignmentJobs(transaction, ticketId, assignment.id)
        endedSubagents = await this.endAssignmentSubagents(transaction, ticketId, assignment.id)
      }
      await this.slots?.release(transaction, { ticketId, assignmentId: assignment.id })
      releasedInTransaction = true
      return false
    })
    await this.stopJobs(ticketId, endedJobs)
    await this.stopSubagents(ticketId, endedSubagents)
    if (releasedInTransaction) await this.wakeForFreedSlot()
    else if (!keepSlot) await this.releaseSlot(ticketId, assignment.id, true)
    return 'ran' as const
  }

  /** Re-open the unread boundary after a restart: pending Inputs either resend or continue with a recovery note. */
  async recoverInputs() {
    await this.recoverRollovers()
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 1000; pageCount++) {
      const page = await this.storage.transaction(this.instanceId, transaction => this.inputs.pendingInputs(transaction, cursor))
      cursor = page.cursor
      for (const input of page.items) {
        try { await this.recoverInput(input) }
        catch (error) { this.sessions.context.logger.warn(`superagent: recovery for Input "${input.id}" failed: ${String(error)}`) }
      }
      if (cursor === undefined) return
    }
    throw new CoreError('WORK_INPUT_BUDGET', 'The restart recovery scan exceeded its declared page budget.')
  }

  /** A committed context handoff must resume even when the process exits before its relay runs. */
  private async recoverRollovers() {
    const pending: { ticketId: string; assignmentId: string; sessionId: string }[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await this.storage.transaction(this.instanceId, transaction => transaction.scan<Work['intent']>('intent',
        { limit: 100, ...(cursor ? { after: cursor } : {}) }))
      for (const item of page.items) {
        if (item.value.reason !== 'context-rollover') continue
        const assignment = await this.storage.transaction(this.instanceId, transaction => transaction.get<Assignment>('assignment', item.value.ticketId))
        if (assignment) pending.push({ ticketId: item.value.ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId })
      }
      if (!page.cursor) break
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('SESSION_ROLLOVER_BUDGET', 'The context handoff recovery scan exceeded its bounded budget.')
    }
    for (const item of pending) {
      await commandTransaction(this.storage, this.instanceId, async transaction => {
        const ticket = await transaction.get<Work['ticket']>('ticket', item.ticketId)
        const assignment = await transaction.get<Assignment>('assignment', item.ticketId)
        if (!ticket || ticket.state !== 'open' || ticket.constraint || !assignment || assignment.id !== item.assignmentId) return
        await this.effects.enqueue(transaction, { key: `rollover-recover:${item.assignmentId}`, stream: 'relay', scope: item.ticketId,
          payload: { ticketId: item.ticketId, assignmentId: item.assignmentId, handoff: true } })
      })
    }
  }

  private async recoverInput(input: WorkInput) {
    if (input.delivery?.completedAt || input.delivery?.exhaustedAt) return
    if (input.delivery?.attempts !== undefined && input.delivery.attempts >= maxDeliveryAttempts) {
      await this.storage.transaction(this.instanceId, transaction => this.exhaustInput(transaction, input))
      return
    }
    const state = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', input.ticketId)
      if (!ticket || ticket.state !== 'open' || ticket.constraint) return undefined
      const ownership = await this.inputs.inputOwnership(transaction, input)
      if (!ownership || ownership.state !== 'owned') return { unowned: ownership?.state }
      return { unowned: undefined }
    })
    if (!state) return
    if (state.unowned !== undefined) {
      await this.storage.transaction(this.instanceId, transaction => this.settleUnownedInput(transaction, input, state.unowned))
      return
    }
    const sessionId = input.delivery?.sessionId
    const messageId = input.delivery?.messageId ?? deliveryMessageId(input.id)
    const found = sessionId === undefined ? { found: false as const } : await this.sessions.hasMessage(sessionId, messageId)
    const persisted = input.delivery?.persistedAt !== undefined || found.found
    if (found.found && input.delivery?.persistedAt === undefined) {
      await this.storage.transaction(this.instanceId, transaction => this.inputs.recordPersisted(transaction, input.id, messageId, found.seq!))
    }
    if (persisted && (input.delivery?.recoveryAttempts ?? 0) >= maxRecoveryAttempts) {
      await this.storage.transaction(this.instanceId, transaction => this.exhaustInput(transaction, input))
      return
    }
    await commandTransaction(this.storage, this.instanceId, transaction => this.effects.enqueue(transaction, {
      key: `followup:${input.id}`, stream: 'relay', scope: input.ticketId,
      payload: { ticketId: input.ticketId, inputId: input.id, recovery: (input.delivery?.recoveryAttempts ?? 0) + 1 },
    }))
  }

  private async exhaustInput(transaction: AsyncTx, input: WorkInput) {
    await this.inputs.exhaustDelivery(transaction, input.id)
    const intent = await transaction.get<Work['intent']>('intent', input.ticketId)
    if (intent) await transaction.replace('intent', input.ticketId, { ...intent, state: 'pending', reason: 'recovery-exhausted' })
  }

  private async settleUnownedInput(transaction: AsyncTx, input: WorkInput, state: WorkOwnership['state'] | undefined) {
    if (state === 'handed-back') await this.inputs.completeDelivery(transaction, input.id, 'handback')
    else await this.exhaustInput(transaction, input)
  }

  async conversation(ticketId: string) {
    identifier(ticketId, 'ticketId')
    let freed = false
    const conversation = await this.storage.transaction(this.instanceId, async transaction => {
      freed = await this.reconcileJobHold(transaction, ticketId) !== undefined
      const trigger = await this.trigger(transaction, ticketId)
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      const report = await transaction.get<ReadyReport>('report', ticketId)
      const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
      const stop = await this.recoverStaleStop(transaction, ticketId)
      const attention = await this.attentions.current(transaction, ticketId)
      const attentionHistory = await this.attentions.history(transaction, ticketId)
      const slot = await this.slots?.currentFor(transaction, ticketId)
      const assignmentHistory: Assignment[] = []
      let assignmentCursor = `${JSON.stringify(['assignment-history', ticketId])}:`
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<Assignment>('assignment-history', { limit: 100, after: assignmentCursor })
        assignmentHistory.push(...page.items.map(item => item.value))
        if (!page.cursor || !page.cursor.startsWith(assignmentCursor)) break
        assignmentCursor = page.cursor
        if (pageCount === 9) throw new CoreError('ASSIGNMENT_BUDGET', 'The Assignment history exceeds its 1000-record budget.')
      }
      const stopHistory: StopState[] = []
      let stopCursor = `${JSON.stringify(['stop-history', ticketId])}:`
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<StopState>('stop-history', { limit: 100, after: stopCursor })
        stopHistory.push(...page.items.map(item => item.value))
        if (!page.cursor || !page.cursor.startsWith(stopCursor)) break
        stopCursor = page.cursor
        if (pageCount === 9) throw new CoreError('STOP_BUDGET', 'The stop history exceeds its 1000-record budget.')
      }
      const resumeHistory: Record<string, unknown>[] = []
      let resumeCursor = `${JSON.stringify(['resume-decision', ticketId])}:`
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<Record<string, unknown>>('resume-decision', { limit: 100, after: resumeCursor })
        resumeHistory.push(...page.items.map(item => item.value))
        if (!page.cursor || !page.cursor.startsWith(resumeCursor)) break
        resumeCursor = page.cursor
        if (pageCount === 9) throw new CoreError('RESUME_BUDGET', 'The resume history exceeds its 1000-record budget.')
      }
      const messageHistory = await this.deliveries.list(transaction, ticketId)
      const visibleMessages = messageHistory.filter(message => message.state === 'sent')
      const messages: DeliveryView[] = []
      const acknowledgement = visibleMessages.filter(message => message.purpose === 'acknowledgement').at(-1)
      const result = visibleMessages.filter(message => message.purpose === 'result').at(-1)
      if (acknowledgement) messages.push(acknowledgement)
      if (result) messages.push(result)
      if (attention?.status === 'waiting') {
        const question = visibleMessages.find(message => message.purpose === 'attention' && message.id === `${ticketId}:attention:${attention.id}`)
        if (question) messages.push(question)
      }
      const reportHistory = await this.history<ReadyReport>(transaction, 'report-history', `${JSON.stringify(['report-history', ticketId])}:`)
      const retryHistory = await this.history<RetryDecision>(transaction, 'retry-decision', `${JSON.stringify(['retry-decision', ticketId])}:`)
      const sessionRollovers = await this.history<SessionRollover>(transaction, 'session-rollover', `${JSON.stringify(['session-rollover', ticketId])}:`)
      const latestPolicy = visibleMessages.filter(message => message.purpose === 'policy').sort((left, right) =>
        (left.basis.kind === 'policy-update' ? left.basis.revision : 0) - (right.basis.kind === 'policy-update' ? right.basis.revision : 0)).at(-1)
      if (latestPolicy) messages.push(latestPolicy)
      const setup = await transaction.get<SetupState>('setup', ticketId)
      const executionSelection = await loadExecutionSelection(transaction, ticketId)
      const environmentHandoff = await loadEnvironmentHandoff(transaction, ticketId)
      const requiredCapabilities = trigger.capabilities ?? executionSelection?.requiredCapabilities ?? []
      const catalog = capabilityLocations(this.hostCapabilities)
      const capabilityItems = executionSelection?.capabilities ?? requiredCapabilities.map(id => {
        const location = catalog.find(candidate => candidate.id === id)!
        return { id, label: location.label, location: location.location, status: 'blocked' as const,
          reasons: ['The execution target has not been resolved yet.'], requirements: [...location.local.requirements],
          credentials: location.local.credentials, privacy: location.local.privacy, gaps: [...location.remote.gaps] }
      })
      const capabilityPlan: CapabilityPlanView = { required: requiredCapabilities, items: capabilityItems,
        status: !requiredCapabilities.length ? 'none' : executionSelection ? capabilityItems.every(item => item.status === 'available')
          ? 'available' : 'blocked' : 'pending' }
      const statusReport = await transaction.get<StatusReport>('status-report', `${JSON.stringify(['status-report', ticketId])}:current`)
      const jobs = this.jobs ? await this.jobs.listIn(transaction, ticketId) : []
      const previews = this.previews ? await this.previews.list(transaction, ticketId) : []
      const subagents = this.subagents ? await this.subagents.listIn(transaction, ticketId) : []
      const ticketState = (await transaction.get<Work['ticket']>('ticket', ticketId))?.state ?? 'open'
      const stage = stop ? stop.state : attention?.status === 'waiting' ? 'waiting-human'
        : intent.state === 'ready' || intent.reason === 'ready-report' ? 'ready'
          : ticketState === 'ended' ? 'ended' : intent.reason === 'worker-idle' ? 'idle'
              : intent.reason === 'worker-running' || intent.reason === 'worker-background' ? 'draft' : 'pending'
      return { ticketId, request: trigger.text, status: stop?.state ?? (attention?.status === 'waiting' ? 'waiting-human' : intent.state), reason: stop?.state ?? intent.reason,
        executionLocation: assignment?.environment ?? null,
        ...(executionSelection ? { executionSelection } : {}),
        ...(environmentHandoff ? { environmentHandoff } : {}),
        capabilityPlan,
        stage, lifecycle: ticketState,
        ...(slot ? { slot } : {}),
        ...(statusReport ? { statusReport } : {}),
        attention, attentionHistory, stop, assignments: assignment ? [assignment] : [],
        jobs: jobs.map(job => ({ id: job.id, assignmentId: job.assignmentId, command: job.command, state: job.state,
          ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }), ...(job.cancelReason ? { cancelReason: job.cancelReason } : {}),
          startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }) })),
        subagents: subagents.map(subagent => ({ id: subagent.id, assignmentId: subagent.assignmentId, task: subagent.task, state: subagent.state,
          ...(subagent.cancelReason ? { cancelReason: subagent.cancelReason } : {}), startedAt: subagent.startedAt,
          ...(subagent.finishedAt === undefined ? {} : { finishedAt: subagent.finishedAt }) })),
        previews: previews.map(preview => this.previews!.view(preview)),
        assignmentHistory: assignmentHistory.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
        stopHistory: stopHistory.sort((left, right) => left.requestedAt - right.requestedAt), resumeHistory: resumeHistory.sort((left, right) => Number(left.resumedAt ?? 0) - Number(right.resumedAt ?? 0)),
        reports: report ? [report] : [],
        reportHistory: reportHistory.sort((left, right) => left.createdAt - right.createdAt), retryHistory, sessionRollovers,
        ...(sessionRollovers.at(-1) ? { handoff: sessionRollovers.at(-1) } : {}),
        ...(retryHistory.at(-1) ? { recovery: retryHistory.at(-1) } : {}), messages,
        messageHistory: visibleMessages, ...(setup ? { setup } : {}) }
    })
    if (freed) this.wakeForFreedSlot()
    return conversation
  }

  async getEnvironmentHandoff(ticketId: string) {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, transaction => loadEnvironmentHandoff(transaction, ticketId))
  }

  private async wakeForFreedSlot() {
    if (await this.storage.transaction(this.instanceId, transaction => this.slots?.hasWaiting(transaction) ?? Promise.resolve(false))) this.effects.wake()
  }

  private async saveEnvironmentHandoff(record: EnvironmentHandoffView, command?: EnvironmentHandoffCommand) {
    return this.storage.transaction(this.instanceId, transaction => saveEnvironmentHandoffIn(transaction, record, command))
  }

  private async history<T>(transaction: AsyncTx, kind: 'report-history' | 'delivery-history' | 'retry-decision' | 'session-rollover', prefix: string) {
    const items: T[] = []
    let cursor = prefix
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<T>(kind, { limit: 100, after: cursor })
      items.push(...page.items.filter(item => item.id.startsWith(prefix)).map(item => item.value))
      if (!page.cursor || !page.cursor.startsWith(prefix)) return items
      cursor = page.cursor
      if (pageCount === 9) {
        const confirmation = await transaction.scan<T>(kind, { limit: 1, after: cursor })
        if (!confirmation.items[0]?.id.startsWith(prefix)) return items
      }
    }
    throw new CoreError('CONVERSATION_BUDGET', 'The Ticket conversation exceeds its declared 1000-record history budget.')
  }

  private stopHeadKey(ticketId: string) {
    return JSON.stringify(['stop-head', ticketId])
  }

  /** An Assignment that hands the Ticket back to a person or ends keeps no background process range alive. */
  private async endAssignmentJobs(transaction: AsyncTx, ticketId: string, assignmentId: string) {
    if (!this.jobs) return []
    return this.jobs.requestCancelAssignment(transaction, { ticketId, assignmentId, reason: 'assignment-ended' })
  }

  /** A handed-back or ended Assignment owns no child Agents either; DSH's ownership seam disposes them. */
  private async endAssignmentSubagents(transaction: AsyncTx, ticketId: string, assignmentId: string) {
    if (!this.subagents) return []
    return this.subagents.requestCancelAssignment(transaction, { ticketId, assignmentId, reason: 'assignment-ended' })
  }

  private async hasBackgroundWork(transaction: AsyncTx, ticketId: string, assignmentId?: string) {
    if (this.jobs && await this.jobs.hasActive(transaction, { ticketId, ...(assignmentId === undefined ? {} : { assignmentId }) })) return true
    return this.subagents ? this.subagents.hasActive(transaction, ticketId, assignmentId) : false
  }

  private async activePreviewJobs(transaction: AsyncTx, ticketId: string): Promise<string[]> {
    if (!this.previews) return []
    return (await this.previews.pending(transaction, ticketId))
      .filter(preview => preview.state === 'running' || preview.state === 'cancelling')
      .map(preview => preview.jobId)
  }

  /** Running, cancelling and unknown previews all mean acceptance cleanup is not yet proven complete. */
  private async previewCleanupPending(transaction: AsyncTx, ticketId: string): Promise<boolean> {
    if (!this.previews) return false
    return (await this.previews.pending(transaction, ticketId)).length > 0
  }

  /** The same check outside a caller-owned transaction, for the turn-abort path. */
  private hasLiveBackgroundWork(ticketId: string) {
    return this.storage.transaction(this.instanceId, async transaction =>
      await this.hasBackgroundWork(transaction, ticketId) || await this.previewCleanupPending(transaction, ticketId))
  }

  /**
   * Disposes the named child Agents after their cancellation facts committed, then records `cancelled` only where
   * the child was really gone. An unconfirmed child keeps a visible pending state instead of claiming success.
   */
  private async stopSubagents(ticketId: string, ids: string[]): Promise<string[]> {
    if (!this.subagents || !ids.length) return []
    const stopped = await this.subagents.stopChildren(ids)
    const unresolved = ids.filter(id => !stopped.includes(id))
    try {
      await this.storage.transaction(this.instanceId, async transaction => {
        for (const id of stopped) await this.subagents!.confirmCancelled(transaction, { ticketId, id })
        for (const id of unresolved) await this.subagents!.markUnconfirmed(transaction, { ticketId, id })
      })
    } finally { await this.subagents.finishStopped(ids) }
    return stopped
  }

  /**
   * Terminates the named ranges after the cancellation facts committed, then records each `cancelled` only where
   * the managed range was observed empty. A range this Host cannot observe keeps its pending cancel.
   */
  private async stopJobs(ticketId: string, jobIds: string[]) {
    if (!this.jobs || !jobIds.length) return []
    const confirmed = await this.jobs.stopRanges(jobIds)
    const confirmedIds = confirmed.map(outcome => outcome.jobId)
    const unresolved = jobIds.filter(jobId => !confirmedIds.includes(jobId))
    try {
      await this.storage.transaction(this.instanceId, async transaction => {
        for (const outcome of confirmed) await this.jobs!.confirmCancelled(transaction, { ticketId, jobId: outcome.jobId, ...(outcome.output ? { output: outcome.output } : {}) })
        for (const jobId of unresolved) await this.jobs!.markUnconfirmed(transaction, { ticketId, jobId })
      })
    } finally {
      // The claim must not outlive this call, even when the terminal fact could not be written: a stale claim
      // would keep a job that no longer has a range counted as live work.
      this.jobs.finishStopped(jobIds)
    }
    return confirmedIds
  }

  private async activeStop(transaction: AsyncTx, ticketId: string) {
    const head = await transaction.get<StopHead>('stop-head', this.stopHeadKey(ticketId))
    const stop = head ? await transaction.get<StopState>('stop-state', head.stopId) : undefined
    return stop?.resumedAt === undefined ? stop : undefined
  }

  private async recoverStaleStop(transaction: AsyncTx, ticketId: string, reason: 'ENGINE_RESTARTED' | 'HOST_REPLACED' = 'ENGINE_RESTARTED') {
    const stop = await this.activeStop(transaction, ticketId)
    if (stop?.state !== 'stopping' || stop.runtimeToken === this.runtimeToken) return stop
    const current = await transaction.get<Assignment>('assignment', ticketId)
    if (current && current.state !== 'ended') await this.saveAssignment(transaction, { ...current, state: 'ended' })
    // T09's decided semantic: an interrupted stop reads `stopped` with a recovery reason and no cancellation
    // evidence, and resume stays blocked by `CANCELLATION_UNCONFIRMED` until a person resolves it explicitly.
    const recovered: StopState = { ...stop, state: 'stopped', recoveryReason: reason, recoveredAt: Date.now() }
    await transaction.replace('stop-state', stop.id, recovered)
    const intent = await transaction.get<Work['intent']>('intent', ticketId)
    if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'stopped' })
    return recovered
  }

  private async saveAssignment(transaction: AsyncTx, assignment: Assignment) {
    const current = await transaction.get<Assignment>('assignment', assignment.ticketId)
    const prefix = JSON.stringify(['assignment-history', assignment.ticketId])
    if (current) {
      const key = `${prefix}:${current.id}`
      if (!await transaction.replace('assignment-history', key, current)) await transaction.insert('assignment-history', key, current)
    }
    if (!await transaction.replace('assignment', assignment.ticketId, assignment)) await transaction.insert('assignment', assignment.ticketId, assignment)
    const key = `${prefix}:${assignment.id}`
    if (!await transaction.replace('assignment-history', key, assignment)) await transaction.insert('assignment-history', key, assignment)
  }

  /** Records the local cancellation evidence for a stop; `assignmentId` only narrows which Assignment is ended. */
  private async confirmStop(assignmentId: string | undefined, ticketId: string, existing?: AsyncTx, remoteConfirmed = false) {
    const operation = async (transaction: AsyncTx) => {
      const stop = await this.activeStop(transaction, ticketId)
      if (!stop) return
      if (stop.pendingDeviceConfirmation && !remoteConfirmed) return
      const current = await transaction.get<Assignment>('assignment', ticketId)
      if (current && (assignmentId === undefined || current.id === assignmentId) && current.state !== 'ended') {
        await this.saveAssignment(transaction, { ...current, state: 'ended' })
      }
      const confirmed: StopState = { ...stop, state: 'stopped', cancellationConfirmedAt: stop.cancellationConfirmedAt ?? Date.now(),
        pendingDeviceConfirmation: false }
      await transaction.replace('stop-state', stop.id, confirmed)
      const intent = await transaction.get<Work['intent']>('intent', ticketId)
      if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'stopped' })
    }
    if (existing) await operation(existing)
    else await this.storage.transaction(this.instanceId, operation)
  }

  async stopTicket(command: { commandId: string; ticketId: string; reason: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Stop needs a bounded reason.')
    const commandKey = createHash('sha256').update(JSON.stringify(['stop', this.instanceId, command.ticketId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['stop-v1', this.instanceId, command.ticketId, command.actorId, command.reason])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ stopId: string; assignmentId?: string; fingerprint: string }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The stop command was reused with a different reason.')
        return { stopId: prior.stopId, assignmentId: prior.assignmentId, replay: true, remotePending: false, remoteJobIds: [] }
      }
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The stopped Ticket belongs to a different source instance.')
      if (trigger.source.actorId !== command.actorId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may stop this Ticket.')
      const ticket = (await transaction.get<Work['ticket']>('ticket', command.ticketId))!
      const existingHead = await transaction.get<StopHead>('stop-head', this.stopHeadKey(command.ticketId))
      if (existingHead) {
        const existing = await transaction.get<StopState>('stop-state', existingHead.stopId)
        if (existing?.resumedAt === undefined && (existing?.state === 'stopping' || existing?.state === 'stopped')) {
          await transaction.insert('work-command', commandKey, { stopId: existing.id, assignmentId: existing.assignmentId, fingerprint })
          return { stopId: existing.id, assignmentId: existing.assignmentId, replay: false, remotePending: false, remoteJobIds: [] }
        }
      }
      const assignment = await transaction.get<Assignment>('assignment', command.ticketId)
      // A turn ends while its background jobs still hold the slot, so a running Assignment is not proof of a live
      // local turn; background process ranges are cancelled with the stop and confirm quiescence below.
      const liveBackground = await this.hasBackgroundWork(transaction, command.ticketId)
        || await this.previewCleanupPending(transaction, command.ticketId)
      const running = liveBackground || assignment?.state === 'running' && this.workerControllers.has(command.ticketId)
      const activeJobs = this.jobs ? await this.jobs.listIn(transaction, command.ticketId) : []
      const remoteJobIds = activeJobs.filter(job => job.environmentKind === 'remote' && ['starting', 'running', 'cancelling', 'unknown'].includes(job.state))
        .map(job => job.id)
      const remotePending = assignment?.environment?.kind === 'remote' && running
        || remoteJobIds.length > 0
      const stopId = randomUUID()
      const effectiveRunning = running || remotePending
      const stop: StopState = { id: stopId, instanceId: this.instanceId, ticketId: command.ticketId, state: effectiveRunning ? 'stopping' : 'stopped',
        requestedAt: Date.now(), requestedBy: command.actorId, reason: command.reason, ...(assignment ? { assignmentId: assignment.id } : {}),
        ...(remotePending ? { pendingDeviceConfirmation: true } : {}),
        runtimeToken: this.runtimeToken, ...(ticket.constraint ? { previousConstraint: structuredClone(ticket.constraint) } : {}),
        ...(!effectiveRunning ? { cancellationConfirmedAt: Date.now() } : {}) }
      await transaction.insert('stop-state', stopId, stop)
      if (!await transaction.replace('stop-head', this.stopHeadKey(command.ticketId), { stopId })) await transaction.insert('stop-head', this.stopHeadKey(command.ticketId), { stopId })
      await transaction.insert('stop-history', `${JSON.stringify(['stop-history', command.ticketId])}:${stopId}`, stop)
      await transaction.replace('ticket', command.ticketId, { ...ticket, constraint: { kind: 'stopped', stopId, reason: command.reason } })
      const intent = (await transaction.get<Work['intent']>('intent', command.ticketId))!
      await transaction.replace('intent', command.ticketId, { ...intent, state: 'pending', reason: running ? 'stopping' : 'stopped' })
      if (assignment && running) await this.saveAssignment(transaction, { ...assignment, state: 'stopping' })
      else if (assignment && assignment.state !== 'ended') await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
      await this.slots?.release(transaction, { ticketId: command.ticketId })
      await this.effects.cancelScope(transaction, { ticketId: command.ticketId })
      const interruptedHandoff = await loadEnvironmentHandoff(transaction, command.ticketId)
      if (interruptedHandoff && isEnvironmentHandoffActive(interruptedHandoff)) {
        const blocked: EnvironmentHandoffView = { ...interruptedHandoff, state: 'blocked',
          blockers: [{ code: 'ticket-stopping', message: 'A human stop takes precedence over this handoff.' }],
          steps: [...interruptedHandoff.steps, { name: 'stopped', state: 'blocked', at: Date.now(), detail: command.reason }] }
        await saveEnvironmentHandoffIn(transaction, blocked, interruptedHandoff.command)
      }
      const previewIds = await this.activePreviewJobs(transaction, command.ticketId)
      for (const jobId of previewIds) await this.jobs?.requestCancel(transaction, { ticketId: command.ticketId, jobId, reason: 'stop' })
      const jobIds = this.jobs ? await this.jobs.requestCancelTicket(transaction, { ticketId: command.ticketId, reason: 'stop' }) : []
      const subagentIds = this.subagents ? await this.subagents.requestCancelTicket(transaction, { ticketId: command.ticketId, reason: 'stop' }) : []
      await transaction.insert('work-command', commandKey, { stopId, assignmentId: assignment?.id, fingerprint })
      return { stopId, assignmentId: assignment?.id, replay: false, jobIds: [...jobIds, ...previewIds], subagentIds, remotePending, remoteJobIds }
    })
    const worker = this.workerControllers.get(command.ticketId)
    if (!outcome.replay && worker && outcome.assignmentId && worker.assignmentId === outcome.assignmentId) worker.controller.abort()
    if (outcome.replay) return this.conversation(command.ticketId)
    const ranges = outcome.jobIds ?? []
    const children = outcome.subagentIds ?? []
    const confirmed = await this.stopJobs(command.ticketId, ranges)
    const stoppedChildren = await this.stopSubagents(command.ticketId, children)
    const previewsPending = await this.storage.transaction(this.instanceId, transaction => this.previewCleanupPending(transaction, command.ticketId))
    // A confirmed empty set of ranges is the local cancellation evidence. A live turn that aborted deliberately
    // leaves confirmation to this path, because it cannot prove its own background work is quiet.
    const allStopped = confirmed.length === ranges.length && stoppedChildren.length === children.length && !previewsPending
    const confirmedIds = new Set(confirmed)
    const remoteEvidence = !outcome.remotePending
      || outcome.remoteJobIds.length > 0 && outcome.remoteJobIds.every(jobId => confirmedIds.has(jobId))
    if (allStopped && remoteEvidence && (ranges.length || children.length)) {
      await this.storage.transaction(this.instanceId, transaction => this.confirmStop(outcome.assignmentId, command.ticketId, transaction, true))
    }
    return this.conversation(command.ticketId)
  }

  async requestStatus(command: { commandId: string; ticketId: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.actorId, 'actorId')
    await this.reconcileRemoteStops(command.ticketId)
    const commandKey = createHash('sha256').update(JSON.stringify(['status', this.instanceId, command.ticketId, command.actorId, command.commandId])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get('work-command', commandKey)
      if (prior) return
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The status request belongs to a different source instance.')
      if (!this.allowedRequesterIds.includes(command.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor may not request status for the Ticket.')
      const ticket = (await transaction.get<Work['ticket']>('ticket', command.ticketId))!
      const attention = await this.attentions.current(transaction, command.ticketId)
      const assignment = await transaction.get<Assignment>('assignment', command.ticketId)
      // A stop, a waiting question or an unfinished Assignment is not an idle state; a status request must not bypass them.
      if (ticket.constraint) throw new CoreError('STATUS_UNAVAILABLE', `A status request cannot run while the Ticket is ${ticket.constraint.kind}.`)
      if (attention?.status === 'waiting') throw new CoreError('STATUS_UNAVAILABLE', 'Resolve the current human question before requesting status.')
      const intent = (await transaction.get<Work['intent']>('intent', command.ticketId))!
      // Only an Assignment that ended its turn without a result is idle; a queued or freshly launched Ticket has nothing to report yet.
      if (assignment?.state !== 'running' || intent.reason !== 'worker-idle') throw new CoreError('STATUS_UNAVAILABLE', 'Only a Worker that ended a turn without a result can be asked for status.')
      await transaction.replace('intent', command.ticketId, { ...intent, state: 'pending', reason: 'followup-pending' })
      await this.effects.enqueue(transaction, { key: `status:${command.commandId}`, stream: 'relay', scope: command.ticketId,
        payload: { ticketId: command.ticketId, status: true } })
      await transaction.insert('work-command', commandKey, { ticketId: command.ticketId })
    })
    return this.conversation(command.ticketId)
  }

  async reconcileRemoteStop(ticketId: string) {
    identifier(ticketId, 'ticketId')
    await this.reconcileRemoteStops(ticketId)
    return this.conversation(ticketId)
  }

  /**
   * Re-reads persisted remote jobs by their original device identity. A live range is reattached,
   * a terminal fact is adopted, and an unobservable one stays unknown with one question.
   */
  async reconcileRemoteWork(ticketId?: string) {
    if (!this.jobs) return ticketId ? this.conversation(ticketId) : { tickets: [] }
    const tickets = ticketId ? [ticketId] : await this.storage.transaction(this.instanceId, async transaction =>
      [...new Set((await this.jobs!.remoteRecords(transaction)).map(record => record.ticketId))])
    for (const id of tickets) {
      identifier(id, 'ticketId')
      try {
        await this.reconcileRemoteStops(id)
        await this.reconcileRemoteTicket(id)
      } catch { /* One Ticket's unreachable device cannot block another Ticket's reconciliation. */ }
    }
    return ticketId ? this.conversation(ticketId) : { tickets }
  }

  /**
   * A new Host epoch may not accept new work until every Assignment left by an earlier runtime is reconciled.
   * Remote ranges are inspected first, then each Ticket either continues with a recovery note, waits for an
   * adopted range, or keeps its stop, human question, revoked authority or unknown effect as a blocker.
   */
  async takeOverHost(acquisition: { epoch: number; previousHostId?: string; previousEpoch?: number; previousToken?: string }): Promise<HostTakeoverRecord> {
    const existing = await this.storage.transaction(this.instanceId, transaction => loadHostTakeover(transaction, this.instanceId, acquisition.epoch))
    if (existing?.state === 'completed') return existing
    const pending: HostTakeoverRecord = existing ?? {
      id: hostTakeoverKey(this.instanceId, acquisition.epoch), instanceId: this.instanceId, epoch: acquisition.epoch,
      ...(acquisition.previousHostId ? { previousHostId: acquisition.previousHostId } : {}),
      ...(acquisition.previousEpoch === undefined ? {} : { previousEpoch: acquisition.previousEpoch }),
      ...(acquisition.previousToken ? { previousToken: acquisition.previousToken } : {}),
      state: 'pending', startedAt: Date.now(), tickets: [],
    }
    await this.saveHostTakeover({ ...pending, state: 'pending' })
    const ticketIds = await this.storage.transaction(this.instanceId, transaction => this.priorRuntimeTicketIds(transaction))
    const tickets: HostTakeoverTicket[] = []
    for (const ticketId of ticketIds) {
      try {
        const ticket = await this.takeOverTicket(ticketId, pending.id)
        if (ticket) tickets.push(ticket)
      } catch (error) {
        await this.failTakeoverTicket(ticketId)
        tickets.push({ ticketId, outcome: 'blocked', blockers: [{ code: 'takeover-failed',
          message: error instanceof CoreError ? error.message : 'The Ticket could not be reconciled during Host replacement.' }] })
      }
    }
    const completed: HostTakeoverRecord = { ...pending, state: 'completed', completedAt: Date.now(), tickets }
    await this.saveHostTakeover(completed)
    return completed
  }

  private async saveHostTakeover(record: HostTakeoverRecord) {
    await this.storage.transaction(this.instanceId, async transaction => {
      if (!await transaction.replace('host-takeover', record.id, record)) await transaction.insert('host-takeover', record.id, record)
    })
  }

  private async failTakeoverTicket(ticketId: string) {
    await this.storage.transaction(this.instanceId, async transaction => {
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      if (assignment && assignment.state !== 'ended' && assignment.runtimeToken !== this.runtimeToken) {
        await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
      }
      const intent = await transaction.get<Work['intent']>('intent', ticketId)
      if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'recovery-blocked' })
    })
  }

  /** New input and new Assignment generations wait until the replacement has reconciled the prior Host. */
  private async assertHostAdmission() {
    await this.storage.transaction(this.instanceId, transaction => this.assertHostAdmissionIn(transaction))
  }

  private async assertHostAdmissionIn(transaction: AsyncTx) {
    if (!this.hostEpoch) return
    await assertHostTakeoverSettled(transaction, this.instanceId, this.hostEpoch())
  }

  private async priorRuntimeTicketIds(transaction: AsyncTx) {
    const ticketIds: string[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<Assignment>('assignment', { limit: 100, ...(cursor ? { after: cursor } : {}) })
      for (const item of page.items) {
        if (item.value.state === 'ended' || item.value.runtimeToken === this.runtimeToken) continue
        ticketIds.push(item.value.ticketId)
      }
      if (!page.cursor) return ticketIds
      cursor = page.cursor
      if (pageCount === 9) throw new CoreError('HOST_TAKEOVER_BUDGET', 'The Host takeover Assignment scan exceeded its 1000-record budget.')
    }
    return ticketIds
  }

  private async takeOverTicket(ticketId: string, takeoverId: string): Promise<HostTakeoverTicket | undefined> {
    // Reconcile a device range by its original identity before any new Assignment can be created. The reconciler
    // records `unknown` and one evidence question when the device cannot prove what happened.
    try { await this.reconcileRemoteStops(ticketId) } catch { /* The snapshot below keeps the stop pending. */ }
    try { await this.reconcileRemoteTicket(ticketId) } catch { /* The snapshot below keeps each unobservable job unknown. */ }
    const snapshot = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      if (!assignment || assignment.state === 'ended' || assignment.runtimeToken === this.runtimeToken) return undefined
      const stop = await this.recoverStaleStop(transaction, ticketId, 'HOST_REPLACED')
      const intent = await transaction.get<Work['intent']>('intent', ticketId)
      const attention = await this.attentions.current(transaction, ticketId)
      const trigger = await this.trigger(transaction, ticketId)
      const jobs = this.jobs ? await this.jobs.listIn(transaction, ticketId) : []
      const subagents = this.subagents ? await this.subagents.listIn(transaction, ticketId) : []
      const unknownEffects = await this.effects.hasUnknownScopeInTransaction(transaction, ticketId)
      const previewPending = await this.previewCleanupPending(transaction, ticketId)
      const handoff = await loadEnvironmentHandoff(transaction, ticketId)
      const pendingInput = await this.inputs.latestPendingInput(transaction, ticketId)
      let revoked: string | undefined
      try { await this.requireCurrentAuthorization(transaction, ticketId, trigger.source.actorId, 'take over') }
      catch (error) { revoked = error instanceof CoreError ? error.message : 'The original authorization is no longer current.' }
      return { ticket, assignment, stop, intent, attention, jobs, subagents, unknownEffects, previewPending, handoff, pendingInput, revoked }
    })
    if (!snapshot) return undefined
    const { ticket, assignment, stop, intent, attention, jobs, subagents, unknownEffects, previewPending, handoff, pendingInput, revoked } = snapshot
    const base = { ticketId, previousAssignmentId: assignment.id, previousGeneration: assignment.generation, sessionId: assignment.sessionId }
    const endAssignment = async () => {
      await this.storage.transaction(this.instanceId, transaction => this.saveAssignment(transaction, { ...assignment, state: 'ended' }))
    }
    if (!ticket || ticket.state !== 'open') {
      await endAssignment()
      return { ...base, outcome: 'ended', blockers: [] }
    }
    if (stop) {
      return { ...base, outcome: 'stopped', blockers: stop.pendingDeviceConfirmation
        ? [{ code: 'device-unconfirmed', message: 'The original device range has not been confirmed quiet.' }] : [] }
    }
    if (revoked) {
      await endAssignment()
      await this.storage.transaction(this.instanceId, async transaction => {
        if (attention?.status === 'waiting') {
          await transaction.replace('attention', attention.id, { ...attention, status: 'superseded', supersededAt: Date.now(),
            supersededBy: `host-takeover:${takeoverId}:revoked` })
        }
        const current = await transaction.get<Work['ticket']>('ticket', ticketId)
        if (current?.constraint?.kind === 'waiting-human') {
          const { constraint: _constraint, ...open } = current
          await transaction.replace('ticket', ticketId, open)
        }
        const currentIntent = await transaction.get<Work['intent']>('intent', ticketId)
        if (currentIntent) await transaction.replace('intent', ticketId, { ...currentIntent, state: 'pending', reason: 'recovery-blocked' })
      })
      return { ...base, outcome: 'revoked', blockers: [{ code: 'authority-revoked', message: revoked }] }
    }
    if (attention?.status === 'waiting' || ticket.constraint?.kind === 'waiting-human') {
      await endAssignment()
      return { ...base, outcome: 'waiting-human', blockers: [{ code: 'waiting-human',
        message: 'A human question is still waiting; it was preserved across the Host replacement.' }] }
    }
    if (handoff && isEnvironmentHandoffActive(handoff)) {
      return { ...base, outcome: 'handoff-pending', blockers: [{ code: 'handoff-pending',
        message: 'An execution Environment handoff is still being reconciled.' }] }
    }
    const blockers: HostTakeoverBlocker[] = []
    if (unknownEffects) blockers.push({ code: 'unknown-effect',
      message: 'An external action has an unknown outcome; reconcile it by its original ID before continuing.' })
    for (const job of jobs) {
      if (job.state !== 'unknown') continue
      blockers.push({ code: 'unknown-job', jobId: job.id,
        message: job.reason ?? 'This background job could not be proven finished.' })
    }
    for (const subagent of subagents) {
      if (!['running', 'cancelling', 'unknown'].includes(subagent.state)) continue
      blockers.push({ code: subagent.state === 'unknown' ? 'unknown-subagent' : 'unconfirmed-subagent', subagentId: subagent.id,
        message: subagent.reason ?? 'This child Agent could not be proven finished.' })
    }
    if (previewPending) blockers.push({ code: 'preview-pending',
      message: 'An acceptance preview must be cancelled or confirmed before the Ticket continues on the new Host.' })
    if (blockers.length) {
      await endAssignment()
      await this.askTakeoverBlocker(ticketId, assignment, blockers, intent)
      return { ...base, outcome: 'blocked', blockers }
    }
    if (pendingInput) {
      await endAssignment()
      if (intent) await this.storage.transaction(this.instanceId, transaction =>
        transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'followup-pending' }))
      return { ...base, outcome: 'input-pending', blockers: [] }
    }
    const live = this.jobs ? jobs.filter(job => job.runtimeToken === this.jobs!.runtimeToken
      && ['starting', 'running', 'cancelling'].includes(job.state)) : []
    if (live.length) {
      const next = this.successorAssignment(assignment, 'running', takeoverId)
      await this.storage.transaction(this.instanceId, async transaction => {
        await this.saveAssignment(transaction, next)
        await this.jobs!.reassign(transaction, { ticketId, fromAssignmentId: assignment.id,
          assignmentId: next.id, generation: next.generation })
        if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'worker-background' })
      })
      return { ...base, outcome: 'waiting-job', assignmentId: next.id, blockers: [] }
    }
    if (!intent || !resumableIntent(intent)) {
      await endAssignment()
      return { ...base, outcome: 'idle', blockers: [] }
    }
    const next = this.successorAssignment(assignment, 'pending', takeoverId)
    await this.storage.transaction(this.instanceId, async transaction => {
      await this.saveAssignment(transaction, next)
      if (intent) await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'recovery-pending' })
      await this.effects.enqueue(transaction, { key: `host-takeover:${takeoverId}:${ticketId}`, stream: 'relay', scope: ticketId,
        payload: { ticketId, assignmentId: next.id, takeover: true } })
    })
    return { ...base, outcome: 'resumed', assignmentId: next.id, blockers: [] }
  }

  /** A continuation keeps the Ticket, Session and Environment but never reuses the previous generation. */
  private successorAssignment(previous: Assignment, state: 'pending' | 'running', takeoverId: string): Assignment {
    return { id: randomUUID(), generation: randomUUID(), ticketId: previous.ticketId, sessionId: previous.sessionId,
      state, createdAt: Date.now(), runtimeToken: this.runtimeToken,
      recovery: { reason: 'HOST_REPLACED', previousAssignmentId: previous.id, takeoverId },
      ...(previous.environment ? { environment: structuredClone(previous.environment) } : {}) }
  }

  private async markTakeoverBlocked(ticketId: string, intent: Work['intent'] | undefined) {
    if (!intent) return
    await this.storage.transaction(this.instanceId, transaction =>
      transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'recovery-blocked' }))
  }

  /**
   * An unreconciled device range or external effect is a local, explicit question, not a dead end: the person
   * can keep it unknown, have the Worker recheck it, or stop the work before a new Assignment is started.
   */
  private async askTakeoverBlocker(ticketId: string, assignment: Assignment, blockers: HostTakeoverBlocker[],
    intent: Work['intent'] | undefined) {
    const evidence = blockers.map(blocker => `- ${blocker.message}`).join('\n')
    const question = `The previous Host could not prove that this Ticket's external work is finished:\n${evidence}\n`
      + 'Reconcile each item by its original ID, then answer with the evidence before this Ticket continues. '
      + 'Use the separate stop command if this work should not continue.'
    try {
      await this.storage.transaction(this.instanceId, transaction => this.attentions.ask(transaction, {
        ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId, question: question.slice(0, 4096),
        options: ['I reconciled these items', 'Keep them unknown and continue'],
      }))
    } catch {
      await this.markTakeoverBlocked(ticketId, intent)
    }
  }

  private async reconcileRemoteTicket(ticketId: string) {
    if (!this.jobs) return
    const snapshot = await this.storage.transaction(this.instanceId, async transaction => {
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      if (!ticket || ticket.state !== 'open' || ticket.constraint) return undefined
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      const trigger = await this.trigger(transaction, ticketId)
      const jobs = (await this.jobs!.remoteRecords(transaction)).filter(record => record.ticketId === ticketId)
      return { assignment, trigger, jobs }
    })
    if (!snapshot) return
    for (const job of snapshot.jobs) {
      if (this.jobs.hasLiveRange(job.id)) continue
      const authorized = await this.storage.transaction(this.instanceId, transaction =>
        this.requireCurrentAuthorization(transaction, ticketId, snapshot.trigger.source.actorId, 'reconcile its remote job')
          .then(() => true, () => false))
      if (!authorized) {
        const unknown = await this.markRemoteUnobservable(ticketId, job, 'The original source authorization is no longer current for this remote job.')
        await this.raiseRemoteUnknown(unknown)
        continue
      }
      const environment = this.environments.find(candidate => candidate.config.id === job.environmentId)
      if (!environment || environment.kind !== 'remote' || !environment.deviceId || !environment.deviceIncarnation
        || !sameEnvironment(snapshot.assignment?.environment, environment)) {
        const unknown = await this.markRemoteUnobservable(ticketId, job, 'The original device Environment is no longer configured with the same identity.')
        await this.raiseRemoteUnknown(unknown)
        continue
      }
      try {
        environment.authorize({ instanceId: this.instanceId, actorId: snapshot.trigger.source.actorId })
        const bound = await environment.prepare({ instanceId: this.instanceId, actorId: snapshot.trigger.source.actorId })
        if (!bound.inspectRange || !bound.attachCommand) throw new CoreError('UNSUPPORTED_CAPABILITY', 'This device cannot reconcile its original job.')
        const range = await bound.inspectRange(job.id)
        if (range.jobId !== job.id) throw new CoreError('DEVICE_FAILED', 'The device answered for a different job.')
        if (range.ownerId !== null && range.ownerId !== snapshot.trigger.source.actorId) {
          const unknown = await this.markRemoteUnobservable(ticketId, job, 'The original device job belongs to a different actor.')
          await this.raiseRemoteUnknown(unknown)
          continue
        }
        if (range.ownerId === null && range.state !== 'exited' && range.state !== 'cancelled') {
          const unknown = await this.markRemoteUnobservable(ticketId, job,
            'The device cannot verify the original job owner or process identity.')
          await this.raiseRemoteUnknown(unknown)
          continue
        }
        const observation: RemoteJobObservation = { deviceId: environment.deviceId, deviceIncarnation: environment.deviceIncarnation,
          actorId: snapshot.trigger.source.actorId, ...(range.ownerId ? { ownerId: range.ownerId } : {}),
          ...(range.deadlineAt === null ? {} : { deadlineAt: range.deadlineAt }), deviceState: range.state,
          rangeSettled: range.settled, ...(range.recovery ? { recovery: range.recovery } : {}) }
        if (range.settled && (range.state === 'exited' || range.state === 'cancelled')) {
          const attached = await bound.attachCommand(job.id)
          const read = attached.read()
          const terminal = await this.storage.transaction(this.instanceId, transaction => this.jobs!.applyRemoteTerminal(transaction, {
            ticketId, jobId: job.id, state: range.state as 'exited' | 'cancelled', remote: observation,
            output: { stdout: read.stdout, stderr: read.stderr }, exitCode: range.exitCode }))
          if (terminal) this.wakeForJob(terminal)
          continue
        }
        const unobservable = range.state === 'unknown' && (range.settled
          || range.recovery?.kind === 'identity-changed' || range.recovery?.kind === 'unverifiable')
        if (unobservable) {
          const unknown = await this.storage.transaction(this.instanceId, transaction => this.jobs!.markRemoteUnknown(transaction, {
            ticketId, jobId: job.id, remote: observation,
            reason: range.recovery?.reason ?? 'The device no longer knows this job; its result and process range cannot be observed.' }))
          await this.raiseRemoteUnknown(unknown)
          continue
        }
        const attached = await bound.attachCommand(job.id)
        const state = range.cancelled || range.state === 'stopping' || job.state === 'cancelling' ? 'cancelling' : 'running'
        const adopted = await this.storage.transaction(this.instanceId, transaction => this.jobs!.adoptRemote(transaction, {
          ticketId, jobId: job.id, job: attached, state, remote: observation }))
        if (adopted) this.jobs.attach(adopted)
        if (state === 'cancelling') attached.terminate()
      } catch (error) {
        if (error instanceof CoreError && error.code === 'DEVICE_UNAVAILABLE') {
          const unknown = await this.markRemoteUnobservable(ticketId, job,
            'The paired device was unavailable, so the original range could not be inspected after the Host restarted.')
          await this.raiseRemoteUnknown(unknown)
          continue
        }
        const reason = error instanceof CoreError ? error.message : 'The original device range could not be inspected.'
        const unknown = await this.markRemoteUnobservable(ticketId, job, reason)
        await this.raiseRemoteUnknown(unknown)
      }
    }
  }

  private async markRemoteUnobservable(ticketId: string, job: JobRecord, reason: string) {
    const observed = await this.storage.transaction(this.instanceId, async transaction => ({
      current: await this.jobs!.getRaw(transaction, ticketId, job.id),
      trigger: await this.trigger(transaction, ticketId),
    }))
    const environment = this.environments.find(candidate => candidate.config.id === job.environmentId)
    const observation: RemoteJobObservation = {
      deviceId: observed.current?.remote?.deviceId ?? environment?.deviceId ?? '',
      deviceIncarnation: observed.current?.remote?.deviceIncarnation ?? environment?.deviceIncarnation ?? '',
      actorId: observed.current?.remote?.actorId ?? observed.trigger.source.actorId,
      deviceState: 'unknown', rangeSettled: false,
      recovery: { observedAt: Date.now(), kind: 'unverifiable', processAlive: 'unknown', rangeAlive: 'unknown',
        rangeEvidence: 'none', reason } }
    return this.storage.transaction(this.instanceId, transaction => this.jobs!.markRemoteUnknown(transaction, {
      ticketId, jobId: job.id, remote: observation, reason }))
  }

  /**
   * An offline stop leaves the device ranges unknown. Reconciliation inspects and cancels each
   * original job by its stable ID and only clears pending-device-confirmation after the device
   * reports the range quiet.
   */
  private async reconcileRemoteStops(ticketId: string) {
    const snapshot = await this.storage.transaction(this.instanceId, async transaction => {
      const stop = await this.activeStop(transaction, ticketId)
      if (!stop?.pendingDeviceConfirmation) return undefined
      const trigger = await this.trigger(transaction, ticketId)
      const jobs = this.jobs ? (await this.jobs.listIn(transaction, ticketId))
        .filter(job => job.environmentKind === 'remote' && ['starting', 'running', 'cancelling', 'unknown'].includes(job.state)) : []
      return { stop, trigger, jobs }
    })
    if (!snapshot) return
    if (!snapshot.jobs.length) return
    let terminal = true
    for (const job of snapshot.jobs) {
      const environment = this.environments.find(candidate => candidate.config.id === job.environmentId)
      if (!environment) { terminal = false; continue }
      try {
        environment.authorize({ instanceId: this.instanceId, actorId: snapshot.trigger.source.actorId })
        const bound = await environment.prepare({ instanceId: this.instanceId, actorId: snapshot.trigger.source.actorId })
        if (!bound.inspectRange || !bound.cancelRange) { terminal = false; continue }
        const range = await bound.inspectRange(job.id)
        const quiet = range.settled && (range.state === 'exited' || range.state === 'cancelled'
          || range.recovery?.rangeAlive === 'gone')
        if (!quiet) {
          await bound.cancelRange(job.id)
          terminal = false
          continue
        }
        await this.storage.transaction(this.instanceId, transaction =>
          this.jobs!.confirmRemoteCancelled(transaction, { ticketId, jobId: job.id }))
      } catch {
        terminal = false
      }
    }
    if (!terminal) return
    const remaining = await this.storage.transaction(this.instanceId, async transaction => ({
      live: await this.hasBackgroundWork(transaction, ticketId),
      preview: await this.previewCleanupPending(transaction, ticketId),
    }))
    if (!remaining.live && !remaining.preview) {
      await this.storage.transaction(this.instanceId, transaction => this.confirmStop(undefined, ticketId, transaction, true))
    }
  }

  async listJobs(ticketId: string): Promise<JobView[]> {
    identifier(ticketId, 'ticketId')
    if (!this.jobs) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    await this.settleJobHold(ticketId)
    return this.jobs.listViews(ticketId)
  }

  async getJob(ticketId: string, jobId: string): Promise<JobView> {
    identifier(ticketId, 'ticketId'); identifier(jobId, 'jobId')
    if (!this.jobs) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    return this.jobs.read(ticketId, jobId)
  }

  async listPreviews(ticketId: string): Promise<PreviewView[]> {
    identifier(ticketId, 'ticketId')
    if (!this.previews) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const records = await this.previews!.list(transaction, ticketId)
      return records.map(record => this.previews!.view(record))
    })
  }

  async getPreview(ticketId: string, previewId: string): Promise<PreviewView> {
    identifier(ticketId, 'ticketId'); identifier(previewId, 'previewId')
    if (!this.previews) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.storage.transaction(this.instanceId, async transaction => {
      const record = await this.previews!.get(transaction, ticketId, previewId)
      if (!record) throw new CoreError('NOT_FOUND', 'The preview does not belong to this Ticket.')
      return this.previews!.view(record)
    })
  }

  /** Ends one retained preview by ownership; only a confirmed managed range becomes `cancelled`. */
  async cancelPreview(command: { commandId: string; ticketId: string; previewId: string; reason: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Cancelling a preview needs a bounded reason.')
    if (!this.previews || !this.jobs) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    const commandKey = createHash('sha256').update(JSON.stringify(['cancel-preview', this.instanceId, command.ticketId, command.previewId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['cancel-preview-v1', this.instanceId, command.ticketId, command.previewId, command.reason])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('preview-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The preview cancellation was reused with a different reason.')
        return { preview: undefined }
      }
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== command.actorId
        || !this.allowedRequesterIds.includes(command.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may cancel this preview.')
      const record = await this.previews!.get(transaction, command.ticketId, command.previewId)
      if (!record) throw new CoreError('NOT_FOUND', 'The preview does not belong to this Ticket.')
      const job = await this.jobs!.get(transaction, command.ticketId, record.jobId)
      const owned = record.runtimeToken === this.jobs!.runtimeToken && job?.runtimeToken === record.runtimeToken
      const active = owned && (job.state === 'running' || job.state === 'cancelling')
      if ((record.state === 'running' || record.state === 'cancelling') && !active) {
        await this.previews!.markUnconfirmed(transaction, command.ticketId, command.previewId)
        await transaction.insert('preview-command', commandKey, { fingerprint, ticketId: command.ticketId, previewId: command.previewId })
        return { preview: undefined }
      }
      if (job?.state === 'running') await this.jobs!.requestCancel(transaction, { ticketId: command.ticketId, jobId: record.jobId, reason: 'human' })
      await transaction.insert('preview-command', commandKey, { fingerprint, ticketId: command.ticketId, previewId: command.previewId })
      return { preview: active ? record : undefined }
    })
    const { preview } = outcome
    if (preview) {
      const [confirmed] = await this.jobs.stopRanges([preview.jobId])
      await this.storage.transaction(this.instanceId, async transaction => {
        if (confirmed) await this.jobs!.confirmCancelled(transaction, { ticketId: command.ticketId, jobId: preview.jobId, ...(confirmed.output ? { output: confirmed.output } : {}) })
        else await this.jobs!.markUnconfirmed(transaction, { ticketId: command.ticketId, jobId: preview.jobId })
        await this.previews!.get(transaction, command.ticketId, command.previewId)
      })
      this.jobs.finishStopped([preview.jobId])
    }
    return this.listPreviews(command.ticketId)
  }

  /** A person resolves a preview whose cleanup could not be confirmed after a Host restart. */
  async resolvePreview(command: { commandId: string; ticketId: string; previewId: string; reason: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Resolving a preview needs a bounded reason.')
    if (!this.previews) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    const commandKey = createHash('sha256').update(JSON.stringify(['resolve-preview', this.instanceId, command.ticketId, command.previewId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['resolve-preview-v1', this.instanceId, command.ticketId, command.previewId, command.reason])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('preview-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The preview resolution was reused with a different reason.')
        return
      }
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== command.actorId
        || !this.allowedRequesterIds.includes(command.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may resolve this preview.')
      await this.previews!.resolve(transaction, command.ticketId, command.previewId, command.reason)
      await transaction.insert('preview-command', commandKey, { fingerprint, ticketId: command.ticketId, previewId: command.previewId })
    })
    await this.storage.transaction(this.instanceId, async transaction => {
      const stop = await this.activeStop(transaction, command.ticketId)
      if (stop?.runtimeToken === this.runtimeToken && !stop.pendingDeviceConfirmation && !stop.cancellationConfirmedAt && !this.workerControllers.has(command.ticketId)
        && !await this.hasBackgroundWork(transaction, command.ticketId) && !await this.previewCleanupPending(transaction, command.ticketId)) {
        await this.confirmStop(undefined, command.ticketId, transaction)
      }
    })
    return this.listPreviews(command.ticketId)
  }

  async cancelJob(command: { commandId: string; ticketId: string; jobId: string; reason: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.jobId, 'jobId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Cancelling a job needs a bounded reason.')
    if (!this.jobs) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    const commandKey = createHash('sha256').update(JSON.stringify(['cancel-job', this.instanceId, command.ticketId, command.jobId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['cancel-job-v1', this.instanceId, command.ticketId, command.jobId, command.reason])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('job-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The job cancellation was reused with a different reason.')
        return
      }
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== command.actorId
        || !this.allowedRequesterIds.includes(command.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may cancel this background job.')
      if (await this.jobs!.isPreview(transaction, command.ticketId, command.jobId)) {
        throw new CoreError('PREVIEW_REQUIRES_CANCEL_PREVIEW', 'Use cancelPreview or stopTicket to end an acceptance preview.')
      }
      await this.jobs!.requestCancel(transaction, { ticketId: command.ticketId, jobId: command.jobId, reason: 'human' })
      await transaction.insert('job-command', commandKey, { fingerprint, ticketId: command.ticketId, jobId: command.jobId })
    })
    // The durable cancellation decision is committed before the process range is terminated, so a rejected
    // command never kills work; `cancelled` is written only once the range is observed empty.
    await this.stopJobs(command.ticketId, [command.jobId])
    await this.settleJobHold(command.ticketId)
    return this.listJobs(command.ticketId)
  }

  async listSubagents(ticketId: string): Promise<SubagentView[]> {
    identifier(ticketId, 'ticketId')
    if (!this.subagents) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    await this.settleJobHold(ticketId)
    return this.subagents.list(ticketId)
  }

  async getSubagent(ticketId: string, subagentId: string) {
    identifier(ticketId, 'ticketId'); identifier(subagentId, 'subagentId')
    if (!this.subagents) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    return this.subagents.view(ticketId, subagentId)
  }

  /** Cancels one child Agent; like a job cancel the durable decision precedes stopping the child. */
  async cancelSubagent(command: { commandId: string; ticketId: string; subagentId: string; reason: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.subagentId, 'subagentId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Cancelling a subagent needs a bounded reason.')
    if (!this.subagents) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    const commandKey = createHash('sha256').update(JSON.stringify(['cancel-subagent', this.instanceId, command.ticketId, command.subagentId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['cancel-subagent-v1', this.instanceId, command.ticketId, command.subagentId, command.reason])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('subagent-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The subagent cancellation was reused with a different reason.')
        return
      }
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== command.actorId
        || !this.allowedRequesterIds.includes(command.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may cancel this subagent.')
      await this.subagents!.requestCancel(transaction, { ticketId: command.ticketId, id: command.subagentId, reason: 'human' })
      await transaction.insert('subagent-command', commandKey, { fingerprint, ticketId: command.ticketId, subagentId: command.subagentId })
    })
    await this.stopSubagents(command.ticketId, [command.subagentId])
    await this.settleJobHold(command.ticketId)
    return this.listSubagents(command.ticketId)
  }

  /**
   * A Ticket that ended its turn with background work keeps its slot until that work is gone. Once the last job
   * settles by a human cancel, the Ticket is idle again and the slot is freed; a completion that still warrants a
   * turn is woken separately by the job handler.
   */
  private async settleJobHold(ticketId: string) {
    if (!this.jobs && !this.subagents) return
    const released = await commandTransaction(this.storage, this.instanceId, transaction => this.reconcileJobHold(transaction, ticketId))
    if (released) await this.wakeForFreedSlot()
  }

  /**
   * Clearing a spent job hold is idempotent and safe to run on any read: a Ticket only reads as holding background
   * work while this process has a live turn or a live job for it. A record from an earlier runtime cannot be proven
   * live, so it becomes `unknown` and stops holding the slot instead of blocking the budget forever.
   */
  private async reconcileJobHold(transaction: AsyncTx, ticketId: string): Promise<string | undefined> {
    if (!this.jobs && !this.subagents) return undefined
    const intent = await transaction.get<Work['intent']>('intent', ticketId)
    if (intent?.reason !== 'worker-background') return undefined
    if (this.workerControllers.has(ticketId) || await this.hasBackgroundWork(transaction, ticketId)) return undefined
    // A completion or cancel wake that is already queued still warrants this slot: freeing it here would let
    // another Ticket take it before the waiting turn runs.
    if (await this.effects.hasPendingInTransaction(transaction, { ticketId, stream: 'relay' })) return undefined
    const assignment = await transaction.get<Assignment>('assignment', ticketId)
    await transaction.replace('intent', ticketId, { ...intent, state: 'running', reason: 'worker-idle' })
    if (assignment) await this.slots?.release(transaction, { ticketId, assignmentId: assignment.id })
    return assignment?.id ?? ''
  }

  async resumeTicket(command: { commandId: string; ticketId: string; actorId: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.actorId, 'actorId')
    const commandKey = createHash('sha256').update(JSON.stringify(['resume', this.instanceId, command.ticketId, command.actorId, command.commandId])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get('work-command', commandKey)
      if (prior) return
      await this.assertHostAdmissionIn(transaction)
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The resumed Ticket belongs to a different source instance.')
      if (trigger.source.actorId !== command.actorId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may resume this Ticket.')
      const waitingIntent = await transaction.get<Work['intent']>('intent', command.ticketId)
      if (waitingIntent?.reason === 'environment-waiting') {
        throw new CoreError('ENVIRONMENT_WAITING', 'The Ticket is waiting for an eligible execution Environment; retry the target first.')
      }
      const stop = await this.recoverStaleStop(transaction, command.ticketId)
      if (!stop || stop.state === 'stopping') throw new CoreError('STOPPING', 'The previous execution has not confirmed cancellation.')
      if (stop.state !== 'stopped') throw new CoreError('STOP_REQUIRED', 'The Ticket is not stopped.')
      if (stop.pendingDeviceConfirmation) throw new CoreError('CANCELLATION_UNCONFIRMED', 'The original device range has not been confirmed quiet.')
      if (!stop.cancellationConfirmedAt) throw new CoreError('CANCELLATION_UNCONFIRMED', 'The previous local execution has not been confirmed stopped.')
      if (await this.effects.hasUnknownScopeInTransaction(transaction, command.ticketId)) throw new CoreError('UNKNOWN_OUTCOME', 'Unknown external work must be reconciled before resume.')
      const attention = await this.attentions.current(transaction, command.ticketId)
      if (attention?.status === 'waiting') throw new CoreError('WAITING_HUMAN', 'Resolve the current human question before resume.')
      await this.requireCurrentAuthorization(transaction, command.ticketId, command.actorId, 'resume')
      const ticket = (await transaction.get<Work['ticket']>('ticket', command.ticketId))!
      const previous = await transaction.get<Assignment>('assignment', command.ticketId)
      if (await this.previewCleanupPending(transaction, command.ticketId)) {
        throw new CoreError('PREVIEW_ACTIVE', 'Cancel or confirm the acceptance preview cleanup before resuming or replacing this work.')
      }
      const environment = previous?.environment ? this.environments.find(candidate => candidate.config.id === previous.environment!.id) : undefined
      if (previous?.environment && (!environment || !sameEnvironment(previous.environment, environment))) throw new CoreError('ENVIRONMENT_CHANGED', 'The retained working directory is no longer available.')
      const assignment: Assignment = { id: randomUUID(), generation: randomUUID(), ticketId: command.ticketId, createdAt: Date.now(),
        sessionId: previous?.sessionId ?? `worker-${randomUUID()}`, state: 'pending', runtimeToken: this.runtimeToken,
        ...(previous?.environment ? { environment: structuredClone(previous.environment) } : {}) }
      await this.saveAssignment(transaction, assignment)
      const { constraint: _constraint, ...openTicket } = ticket
      await transaction.replace('ticket', command.ticketId, { ...openTicket, state: 'open' })
      const intent = (await transaction.get<Work['intent']>('intent', command.ticketId))!
      await transaction.replace('intent', command.ticketId, { ...intent, state: 'pending', reason: 'router-pending' })
      await transaction.replace('stop-state', stop.id, { ...stop, resumedAt: Date.now(), resumeCommandId: command.commandId })
      const resumeKey = `${JSON.stringify(['resume-decision', command.ticketId])}:${commandKey}`
      await transaction.insert('resume-decision', resumeKey, { ticketId: command.ticketId, stopId: stop.id, assignmentId: assignment.id, actorId: command.actorId, resumedAt: Date.now() })
      const pendingInput = await this.inputs.latestPendingInput(transaction, command.ticketId)
      await this.effects.enqueue(transaction, { key: `resume:${command.commandId}`, stream: 'relay', scope: command.ticketId,
        payload: { ticketId: command.ticketId, assignmentId: assignment.id, resume: !pendingInput, ...(pendingInput ? { inputId: pendingInput.id } : {}) } })
      await transaction.insert('work-command', commandKey, { assignmentId: assignment.id })
    })
    return this.conversation(command.ticketId)
  }

  /** A retry keeps the Ticket, Session and directory but starts a fresh Assignment generation. */
  async retryTicket(command: { commandId: string; ticketId: string; actorId: string; reason: string }) {
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.actorId, 'actorId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Retrying work needs a bounded reason.')
    const waiting = await this.storage.transaction(this.instanceId, async transaction =>
      (await transaction.get<Work['intent']>('intent', command.ticketId))?.reason === 'environment-waiting')
    if (waiting) throw new CoreError('ENVIRONMENT_WAITING', 'Retry the execution target before creating an Assignment.')
    const commandKey = createHash('sha256').update(JSON.stringify(['retry', this.instanceId, command.ticketId, command.actorId, command.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify(['retry-v1', command.reason])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; blocked?: boolean }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The retry command was reused with a different reason.')
        return { blocked: prior.blocked === true }
      }
      await this.assertHostAdmissionIn(transaction)
      const trigger = await this.trigger(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== command.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the trusted source actor may retry this Ticket.')
      }
      await this.requireCurrentAuthorization(transaction, command.ticketId, command.actorId, 'retry')
      const ticket = (await transaction.get<Work['ticket']>('ticket', command.ticketId))!
      if (ticket.constraint) throw new CoreError(ticket.constraint.kind === 'stopped' ? 'TICKET_STOPPED' : 'TICKET_BLOCKED',
        'A stopped or waiting-human Ticket must be resolved before a new Assignment generation.')
      if (this.workerControllers.has(command.ticketId)) throw new CoreError('TURN_ACTIVE', 'The current Assignment still has an active turn.')
      if (await this.effects.hasUnknownScopeInTransaction(transaction, command.ticketId)) {
        throw new CoreError('UNKNOWN_OUTCOME', 'Unknown external work must be reconciled by its original ID before retry.')
      }
      if (await this.previewCleanupPending(transaction, command.ticketId)) {
        throw new CoreError('PREVIEW_ACTIVE', 'Cancel or confirm the acceptance preview cleanup before retry.')
      }
      const previous = await transaction.get<Assignment>('assignment', command.ticketId)
      const jobs = this.jobs ? await this.jobs.listIn(transaction, command.ticketId) : []
      const subagents = this.subagents ? await this.subagents.listIn(transaction, command.ticketId) : []
      const blockedWork = [
        ...jobs.filter(job => previous && job.assignmentId === previous.id && ['starting', 'running', 'cancelling', 'unknown'].includes(job.state))
          .map(job => ({ kind: 'job' as const, id: job.id, state: job.state })),
        ...subagents.filter(subagent => previous && subagent.assignmentId === previous.id && ['running', 'cancelling', 'unknown'].includes(subagent.state))
          .map(subagent => ({ kind: 'subagent' as const, id: subagent.id, state: subagent.state })),
      ]
      if (blockedWork.length) {
        const retry: RetryDecision = { id: `${JSON.stringify(['retry-decision', command.ticketId])}:${commandKey}`, instanceId: this.instanceId,
          ticketId: command.ticketId, assignmentId: previous?.id ?? command.ticketId, sessionId: previous?.sessionId ?? '',
          reason: 'RETRY_REQUESTED', requestedBy: command.actorId, requestReason: command.reason, checks: [], blockedWork, createdAt: Date.now() }
        await transaction.insert('retry-decision', retry.id, retry)
        const intent = (await transaction.get<Work['intent']>('intent', command.ticketId))!
        await transaction.replace('intent', command.ticketId, { ...intent, state: 'pending', reason: 'recovery-blocked' })
        await transaction.insert('work-command', commandKey, { fingerprint, blocked: true })
        return { blocked: true }
      }
      const environment = previous?.environment ? this.environments.find(candidate => candidate.config.id === previous.environment!.id) : undefined
      if (previous?.environment && (!environment || !sameEnvironment(previous.environment, environment))) throw new CoreError('ENVIRONMENT_CHANGED', 'The retained working directory is no longer available.')
      const previousReport = await transaction.get<ReadyReport>('report', command.ticketId)
      if (previous && previousReport?.assignmentId === previous.id) await transaction.remove('report', command.ticketId)
      if (previous && previous.state !== 'ended') {
        await this.saveAssignment(transaction, { ...previous, state: 'ended' })
        await this.endAssignmentJobs(transaction, command.ticketId, previous.id)
        await this.endAssignmentSubagents(transaction, command.ticketId, previous.id)
      }
      const assignment: Assignment = { id: randomUUID(), generation: randomUUID(), ticketId: command.ticketId, createdAt: Date.now(),
        sessionId: previous?.sessionId ?? `worker-${randomUUID()}`, state: 'pending', runtimeToken: this.runtimeToken,
        ...(previous?.environment ? { environment: structuredClone(previous.environment) } : {}) }
      const { constraint: _constraint, ...openTicket } = ticket
      await transaction.replace('ticket', command.ticketId, { ...openTicket, state: 'open' })
      await this.saveAssignment(transaction, assignment)
      const intent = (await transaction.get<Work['intent']>('intent', command.ticketId))!
      await transaction.replace('intent', command.ticketId, { ...intent, state: 'pending', reason: 'recovery-pending' })
      const retry: RetryDecision = { id: `${JSON.stringify(['retry-decision', command.ticketId])}:${commandKey}`, instanceId: this.instanceId,
        ticketId: command.ticketId, ...(previous ? { previousAssignmentId: previous.id, previousGeneration: previous.generation } : {}),
        assignmentId: assignment.id, sessionId: assignment.sessionId, ...(assignment.environment ? { environment: assignment.environment } : {}),
        reason: 'RETRY_REQUESTED', requestedBy: command.actorId, requestReason: command.reason, createdAt: Date.now(),
        checks: ['Inspect the retained Session and working directory before changing files.',
          'Compare version-control state with the last recorded result; do not revert unrelated user changes.',
          'Reconcile each external action by its original platform ID, job ID or marker before repeating it.',
          'Keep stops, waiting-human constraints and revoked authority in force.'] }
      await transaction.insert('retry-decision', retry.id, retry)
      await this.effects.enqueue(transaction, { key: `retry:${command.commandId}`, stream: 'relay', scope: command.ticketId,
        payload: { ticketId: command.ticketId, assignmentId: assignment.id, resume: true } })
      await transaction.insert('work-command', commandKey, { fingerprint, assignmentId: assignment.id })
      return { blocked: false }
    })
    if (outcome.blocked) throw new CoreError('WORK_UNCONFIRMED', 'The previous Assignment still has unconfirmed jobs or subagents; reconcile them by their original IDs first.')
    return this.conversation(command.ticketId)
  }

  private async requireCurrentAuthorization(transaction: AsyncTx, ticketId: string, actorId: string, action: string) {
    const trigger = await this.trigger(transaction, ticketId)
    if (trigger.threadId) {
      const current = await this.sourceEvents.candidate(transaction, { threadId: trigger.threadId, objectId: trigger.eventId })
      if (!current) throw new CoreError('SOURCE_NOT_CURRENT', `The original source authorization is no longer current for ${action}.`)
      if (current.authorKind !== 'human' || !current.authorId) throw new CoreError('SOURCE_NOT_AUTHORIZED', `Current human authorization is required to ${action}.`)
      if (!this.allowedRequesterIds.includes(current.authorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', `The original source actor is no longer allowed to ${action}.`)
    } else if (!this.allowedRequesterIds.includes(actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', `The local actor is no longer allowed to ${action}.`)
  }

  private async verifyEnvironmentLocation(location: EnvironmentLocation, environment: ExecutionEnvironment, actorId: string) {
    if (!sameEnvironment(location, environment)) {
      throw new CoreError('ENVIRONMENT_CHANGED', 'The retained Environment identity no longer matches its assignment.')
    }
    if (!location.fingerprint && !location.version) return
    if (!environment.probe) throw new CoreError('ENVIRONMENT_CHANGED', 'The retained Environment cannot prove its fingerprint.')
    const probe = await environment.probe({ instanceId: this.instanceId, actorId }).catch(() => undefined)
    if (!probe || probe.root !== location.root || location.fingerprint && probe.fingerprint !== location.fingerprint
      || location.version && probe.version !== location.version) {
      throw new CoreError('ENVIRONMENT_CHANGED', 'The retained Environment directory or fingerprint changed.')
    }
  }

  /** A context-full turn hands off explicitly; only the new Assignment may continue, and old history stays readable. */
  private async rolloverSession(ticketId: string, assignment: Assignment, trigger: Work['trigger'], forkedSessionId?: string): Promise<boolean> {
    const direction = await this.inputs.direction(ticketId)
    if (!direction) return false
    const pendingInputs = direction.inputs.filter(input => input.state === 'pending' && !input.delivery?.completedAt)
      .slice(-10).map(input => ({ id: input.id, text: input.text, directionVersion: input.directionVersion }))
    const newSessionId = forkedSessionId ?? `worker-${randomUUID()}`
    const forked = forkedSessionId !== undefined
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<Assignment>('assignment', ticketId)
      if (!current || current.id !== assignment.id || current.state !== 'running') return false
      const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
      if (!ticket) return false
      await this.saveAssignment(transaction, { ...assignment, state: 'ended' })
      const next: Assignment = { id: randomUUID(), generation: randomUUID(), ticketId, sessionId: newSessionId, state: 'pending',
        createdAt: Date.now(), runtimeToken: this.runtimeToken, ...(assignment.environment ? { environment: structuredClone(assignment.environment) } : {}) }
      await this.saveAssignment(transaction, next)
      const report = await transaction.get<ReadyReport>('report', ticketId)
      const attention = await this.attentions.current(transaction, ticketId)
      const rollover: SessionRollover = { id: `${JSON.stringify(['session-rollover', ticketId])}:${newSessionId}`, instanceId: this.instanceId,
        ticketId, previousAssignmentId: assignment.id, previousSessionId: assignment.sessionId, assignmentId: next.id, sessionId: newSessionId,
        forked, goal: trigger.text, mandateId: ticket.mandateId, ...(ticket.constraint ? { constraint: ticket.constraint } : {}), pendingInputs,
        evidence: { triggerId: trigger.id, ...(report ? { reportId: report.id } : {}), ...(attention ? { attentionId: attention.id } : {}) },
        reason: 'CONTEXT_WINDOW', createdAt: Date.now() }
      await transaction.insert('session-rollover', rollover.id, rollover)
      const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
      await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'context-rollover' })
      await this.effects.enqueue(transaction, { key: `rollover:${newSessionId}`, stream: 'relay', scope: ticketId,
        payload: { ticketId, assignmentId: next.id, handoff: true } })
      return true
    })
  }

  private async handoffPrompt(ticketId: string) {
    const rollover = await this.storage.transaction(this.instanceId, async transaction => {
      const history = await this.history<SessionRollover>(transaction, 'session-rollover', `${JSON.stringify(['session-rollover', ticketId])}:`)
      return history.at(-1)
    })
    if (!rollover) return 'Continue in a new Session after a context handoff. Preserve the original goal, Mandate and constraints; do not widen scope.'
    const pending = rollover.pendingInputs.map(input => `- ${input.text}`).join('\n') || '- none'
    return `Continue in a new Session after a context handoff. Previous Session: ${rollover.previousSessionId}. Preserve the original goal and Mandate; do not widen scope. `
      + `Goal:\n${rollover.goal}\n\nConstraints: ${JSON.stringify(rollover.constraint ?? null)}\n\nUnread inputs:\n${pending}\n\n`
      + 'Read the original request and evidence with read_context. Inspect retained files, version control and external state before changing anything.'
  }

  private async turnTextFor(cause: TurnCause, ticketId: string, trigger: Work['trigger'], input: WorkInput | undefined,
    job: JobRecord | undefined, subagent: SubagentRecord | undefined) {
    switch (cause) {
      case 'status': return 'Report the current status of this Ticket in one short turn. Do not continue the work, do not report ready, and do not ask a question unless the current blocker genuinely needs a human.'
      case 'background': return job ? jobEventText(job) : subagentEventText(subagent!)
      case 'environment-handoff':
        return environmentHandoffPrompt(await this.storage.transaction(this.instanceId, transaction => loadEnvironmentHandoff(transaction, ticketId)))
      case 'context-handoff': return this.handoffPrompt(ticketId)
      case 'host-takeover':
        return 'Continue after the Host was replaced. Inspect the retained Session, files, version control and external state before making changes. '
          + 'Do not assume an interrupted turn, command or device job completed; reconcile each external action by its original ID, job ID or marker first.'
      case 'resume': return 'Continue after resume. Inspect the retained Session, files, version control and external state before making changes.'
      case 'followup': return input?.text ?? trigger.text
      case 'launch': return trigger.text
    }
  }

  async retrySetup(commandId: string, ticketId: string, actorId: string) {
    identifier(commandId, 'commandId')
    identifier(ticketId, 'ticketId')
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const fingerprint = JSON.stringify(['setup-retry-v1', ticketId, actorId])
      const previous = await transaction.get<{ fingerprint: string; ticketId: string }>('setup-retry', commandId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The setup retry command was used for different work.')
        return { ticketId: previous.ticketId }
      }
      const trigger = await this.trigger(transaction, ticketId)
      if (trigger.source.actorId !== actorId) throw new CoreError('ENVIRONMENT_DENIED', 'Only the original authorized actor may retry this setup.')
      const assignment = await transaction.get<Assignment>('assignment', ticketId)
      const setup = await transaction.get<SetupState>('setup', ticketId)
      if (!assignment?.environment || setup?.state !== 'failed' || setup.assignmentId !== assignment.id) throw new CoreError('SETUP_NOT_RETRYABLE', 'Only failed setup on the original Assignment may be retried.')
      const environment = this.environments.find(candidate => candidate.config.id === assignment.environment!.id)
      if (!environment || !sameEnvironment(assignment.environment, environment)) throw new CoreError('ENVIRONMENT_CHANGED', 'The original Environment must remain configured with the same device and directory.')
      environment.authorize({ instanceId: this.instanceId, actorId })
      const intent = (await transaction.get<Work['intent']>('intent', ticketId))!
      const handoff = await loadEnvironmentHandoff(transaction, ticketId)
      const handoffPrompt = isHandoffPromptPending(handoff, assignment.id)
      await transaction.replace('setup', ticketId, { assignmentId: assignment.id, state: 'pending' })
      await transaction.replace('intent', ticketId, { ...intent, state: 'pending', reason: 'setup-pending' })
      await this.effects.enqueue(transaction, { key: `setup:${commandId}`, stream: 'relay', scope: ticketId,
        payload: { ticketId, assignmentId: assignment.id, ...(handoffPrompt ? { environmentHandoff: handoff!.id } : {}) } })
      await transaction.insert('setup-retry', commandId, { fingerprint, ticketId })
      return { ticketId }
    })
  }
}

function activeBackgroundBlockers(jobs: { state: string }[], subagents: { state: string }[], previews: { state: string }[]) {
  const blockers: HandoffBlocker[] = []
  if (jobs.some(job => ['starting', 'running', 'cancelling', 'unknown'].includes(job.state))) {
    blockers.push({ code: 'active-job', message: 'A background job is still active or unconfirmed.' })
  }
  if (subagents.some(subagent => ['running', 'cancelling', 'unknown'].includes(subagent.state))) {
    blockers.push({ code: 'active-subagent', message: 'A child Agent is still active or unconfirmed.' })
  }
  if (previews.some(preview => ['running', 'cancelling', 'unknown'].includes(preview.state))) {
    blockers.push({ code: 'active-preview', message: 'A retained preview still owns a process range.' })
  }
  return blockers
}
