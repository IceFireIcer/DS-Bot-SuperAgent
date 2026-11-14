import { createHash, randomUUID } from 'node:crypto'
import { CoreError, identifier, type CommandRecord, type DesktopSource, type EventRecord, type IntakePolicy, type Receipt, type Source, type SubmitRequest, type Work } from './model.js'
import { capabilityLocations, validateHostCapabilities, validateRequiredCapabilities,
  type CapabilityPlanView, type HostCapabilities } from './capability-locations.js'
import type { AsyncTx, Storage } from './storage.js'
import { canonicalJson, commandTransaction } from './commands.js'
import { Effects, type EffectsOptions } from './effects.js'
import { Execution, type Assignment } from './execution.js'
import type { EnvironmentHandoffRevalidation, EnvironmentHandoffView, HandoffBlocker } from './environment-handoff.js'
import type { NativeSessions } from './native-sessions.js'
import { environmentLocation, type EnvironmentLocation, type EnvironmentProbe, type ExecutionEnvironment } from './environment.js'
import { unsupportedAssetCapabilities, assertReferenceShape, attachmentBytes, UnsupportedEnvironmentCombination,
  type EnvironmentAssetCapabilities, type EnvironmentAssetReference } from './environment-assets.js'
import { SourceEvents, isCurrentSourceEvent, type AcceptSourceRequest, type ReceiveSourceEvent, type SourceEvent, type SourceObjectRef } from './source-events.js'
import { SourceEvaluations, validateIntakePolicy, type SourceEvaluation } from './source-evaluations.js'
import { associatedInput, WorkInputs, type TicketDirection, type WorkInput, type WorkNote } from './work-inputs.js'
import { Attentions, type Attention } from './attention.js'
import { Slots, type SlotOptions, type SlotSnapshot } from './slots.js'
import { Jobs, type JobsOptions, type JobView } from './jobs.js'
import type { Previews, PreviewView } from './previews.js'
import { Subagents, type SubagentsOptions, type SubagentView } from './subagents.js'
import { Deliveries, type Delivery, type DeliveryOptions, type DeliveryView } from './deliveries.js'
import { Outbox } from './outbox.js'
import { HostLease, type HostOptions } from './host.js'
import { ClientAccess } from './client-access.js'
import { listSupervisorProposals, Supervisor, type SupervisorOptions, type SupervisorProposal } from './supervisor.js'
import { assertHostTakeoverSettled, loadHostTakeover, type HostTakeoverRecord, type HostTakeoverTicket } from './host-takeover.js'
import { ContextReader, type ContextCandidate, type ContextCard, type ContextRequest } from './context.js'
import { RoleConfigStore, validateRoleConfig, type RoleConfig, type RoleConfigUse, type RoleConfigView } from './config.js'
import { draftKey, instructionKey, validateBehaviorChange, type BehaviorChange, type BehaviorInterpreter,
  type BehaviorInstructionRecord, type ConfigDraft } from './config-instructions.js'
import { DeliveryState, type DeliveryCondition, type DeliveryTarget } from './delivery-state.js'
import { Proactive, type ProactiveCandidate, type ProactiveOptions, type ProactiveRule, type ProactiveRun } from './proactive.js'
import { SourceMembership, type MembershipSnapshot, type SourceMember } from './membership.js'
import { ExecutionPolicyStore, loadExecutionSelection, selectExecutionTarget, targetMatches,
  type ExecutionPolicyConfig, type ExecutionPolicyView, type ExecutionTarget } from './execution-target.js'
import { compareWorkCopy, WorkCopyUnsupported, workCopyGaps,
  uniqueBlockers, type HandoffCopyView, type WorkCopyBlocker, type WorkCopyComparison, type WorkCopyFile, type WorkCopySnapshot } from './work-copy.js'
import type { ActivationGate } from './activation.js'
import { MainConversation, type MainAddress, type MainSend } from './main-conversation.js'
import { WorkDelegation, type MainWorkCard, type MainWorkItem } from './work-delegation.js'

interface StoredPolicy { revision: number; configuration: Omit<IntakePolicy, 'assess'>; origin: 'bootstrap' | 'manual' | 'sync'; sourceRevision?: string; updatedAt: number }
interface ProcessingState { paused: boolean; revision: number; updatedAt: number }
interface StoredPolicyNotice { key: string; ticketId: string; revision: number; reason: string }

export class Engine {
  readonly effects: Effects
  private readonly main: MainConversation
  private readonly workDelegation?: WorkDelegation
  private readonly slots: Slots | undefined
  private readonly jobs: Jobs | undefined
  private readonly previews: Previews | undefined
  private readonly subagents: Subagents | undefined
  private readonly execution: Execution | undefined
  private readonly authoringActorIds: string[] | undefined
  private readonly sourceEvents: SourceEvents
  private readonly evaluations: SourceEvaluations | undefined
  private readonly inputs: WorkInputs
  private readonly attentions: Attentions
  private readonly deliveries: Deliveries
  private readonly outbox: Outbox
  private readonly storage: Storage
  private readonly host: HostLease
  private readonly context: ContextReader
  private readonly sessions: NativeSessions | undefined
  private readonly roleConfig: RoleConfigStore
  private readonly executionPolicy: ExecutionPolicyStore
  private readonly hostCapabilities: HostCapabilities
  private readonly deliveryState: DeliveryState
  private readonly proactive: Proactive | undefined
  private readonly membership: SourceMembership
  private activationGate: ActivationGate | undefined
  private roleConfigRevision = 1
  private policyRevision = 1
  private processingPaused = false
  private policyReady: Promise<void> | undefined
  private configuredIntake: IntakePolicy | undefined
  private readonly configuredAssessor: IntakePolicy['assess'] | undefined
  private readonly defaultAssessor: IntakePolicy['assess'] | undefined
  private readonly initialIntake: IntakePolicy | undefined
  private initialPolicyRevision = 1
  private hasPersistedPolicy = false
  private avoidPolicyPersistence = false
  private readonly ticketCursors = new Map<string, { after: string; sourceInstanceId: string; actorId: string; expiresAt: number }>()
  private commandKey(commandId: string) { return createHash('sha256').update(JSON.stringify([this.source.sourceInstanceId, this.source.actorId, commandId])).digest('hex') }
  private policyKey() { return JSON.stringify(['policy-state', this.source.sourceInstanceId]) }
  private processingKey() { return JSON.stringify(['processing-state', this.source.sourceInstanceId]) }
  private async triggerFor(transaction: AsyncTx, ticketId: string) {
    const ticket = await transaction.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket ? await transaction.get<Work['trigger']>('trigger', ticket.triggerId) : undefined
    if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The Ticket does not exist.')
    return trigger
  }

  private async ensurePolicy() {
    if (this.avoidPolicyPersistence) {
      if (this.configuredIntake) this.evaluations?.replacePolicy(this.configuredIntake, 1, this.configuredAssessor)
      return
    }

    if (this.policyReady) {
      try { await this.policyReady }
      catch (error) { this.policyReady = undefined; throw error }
      return
    }
    this.policyReady = commandTransaction(this.storage, this.instanceId, async tx => {
      const stored = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      const currentAssessor = this.configuredAssessor
      const configured = this.initialIntake
      if (stored && stored.origin !== 'bootstrap') {
        this.hasPersistedPolicy = true
        this.applyPolicy(stored.configuration, stored.revision, currentAssessor)
      } else if (configured) {
        const { assess: _assess, ...configuration } = configured
        const persistedConfiguration = structuredClone(configuration)
        const initial: StoredPolicy = { revision: this.initialPolicyRevision, configuration: persistedConfiguration, origin: 'bootstrap', updatedAt: Date.now() }
        if (!await tx.replace('policy-state', this.policyKey(), initial)) await tx.insert('policy-state', this.policyKey(), initial)
      }
      const processing = await tx.get<ProcessingState>('processing-state', this.processingKey())
      if (processing) this.processingPaused = processing.paused
      this.effects.setPaused(this.processingPaused)
      this.evaluations?.setPaused(this.processingPaused)
    })
    try { await this.policyReady }
    catch (error) { this.policyReady = undefined; throw error }
    await this.getRoleConfig()
    if (this.configuredIntake && !this.hasPersistedPolicy) await this.syncConfiguredPolicy()
  }

  private async syncConfiguredPolicy() {
    if (!this.configuredIntake) return
    const configured = this.initialIntake!
    const { assess: _assess, ...configuration } = configured
    const fingerprint = createHash('sha256').update(canonicalJson(configuration)).digest('hex')
    const key = JSON.stringify(['policy-bootstrap', this.source.sourceInstanceId])
    await this.storage.transaction(this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string }>('policy-state', key)
      if (prior?.fingerprint === fingerprint) return
      const revision = Math.max(this.initialPolicyRevision, ((await tx.get<StoredPolicy>('policy-state', this.policyKey()))?.revision ?? 0) + 1)
      const stored: StoredPolicy = { revision, configuration: structuredClone(configuration), origin: 'bootstrap', updatedAt: Date.now() }
      if (!await tx.replace('policy-state', this.policyKey(), stored)) await tx.insert('policy-state', this.policyKey(), stored)
      if (!await tx.replace('policy-state', key, { fingerprint })) await tx.insert('policy-state', key, { fingerprint })
      this.hasPersistedPolicy = true
      this.applyPolicy(this.initialIntake!, revision, this.configuredAssessor)
    })
  }

  private applyPolicy(policy: IntakePolicy | undefined, revision: number, assessor: IntakePolicy['assess'] | undefined = undefined) {
    if (!policy) return
    this.source.intake = policy
    this.policyRevision = revision
    this.evaluations?.replacePolicy(policy, revision, assessor ?? this.defaultAssessor)
    this.inputs.setPolicy(policy)
    this.execution?.setAllowedRequesterIds(policy.allowedRequesterIds)
  }

  private async drainPolicyReevaluations() {
    if (this.processingPaused) return
      const prefix = JSON.stringify(['policy-reevaluation', this.source.sourceInstanceId])
    const pending = await commandTransaction(this.storage, this.instanceId, async tx => {
      let cursor = prefix
      const items: StoredPolicyNotice[] = []
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<StoredPolicyNotice>('policy-reevaluation', { limit: 100, after: cursor })
        items.push(...page.items.map(item => item.value))
        if (!page.cursor || !page.cursor.startsWith(prefix)) return items
        cursor = page.cursor
        if (pageCount === 9) {
          const confirmation = await tx.scan<StoredPolicyNotice>('policy-reevaluation', { limit: 1, after: cursor })
          if (!confirmation.items[0]?.id.startsWith(prefix)) return items
          throw new CoreError('EVAL_BUDGET', 'The pending Policy reevaluation scan exceeded its 1000-record budget.')
        }
      }
      return items
    })
    if (!this.evaluations) return
    for (const item of pending) {
      await commandTransaction(this.storage, this.instanceId, tx => this.evaluations!.requeueInterrupted(tx, { evaluationId: item.ticketId, candidateEventIds: [] }, item.reason))
    }
    const threads = new Set<string>()
    for (const item of pending) {
      const detail = await this.storage.transaction(this.instanceId, tx => tx.get<SourceEvaluation>('eval', item.ticketId))
      if (detail) threads.add(detail.threadId)
    }
    await commandTransaction(this.storage, this.instanceId, async tx => {
      for (const item of pending) await tx.remove('policy-reevaluation', item.key)
    })
    for (const threadId of threads) await this.evaluations.runAll(threadId)
  }

  private assertAuthoringActor() {
    if (this.authoringActorIds !== undefined && !this.authoringActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot change versioned behavior configuration.')
    }
  }
  constructor(rawStorage: Storage, private readonly instanceId: string, private readonly source: DesktopSource, effectsOptions: EffectsOptions = {}, sessions?: NativeSessions, private readonly environments: ExecutionEnvironment[] = [], slotOptions: SlotOptions = {}, jobOptions: JobsOptions = {}, subagentOptions: SubagentsOptions = {}, deliveryOptions: DeliveryOptions = {}, hostOptions: HostOptions = {}, proactiveOptions?: ProactiveOptions) {
    identifier(instanceId, 'instanceId')
    identifier(source.sourceInstanceId, 'sourceInstanceId')
    identifier(source.actorId, 'actorId')
    this.hostCapabilities = validateHostCapabilities(source.hostCapabilities)
    this.host = new HostLease(rawStorage, instanceId, hostOptions)
    const storage = this.host.guard(rawStorage)
    this.storage = storage
    this.sessions = sessions
    this.main = new MainConversation(storage, instanceId, source, sessions, async sessionId => {
      const config = await this.getRoleConfig()
      if (!config.roles.main) throw new CoreError('ROLE_NOT_CONFIGURED', 'Main needs its own role profile.')
      await storage.transaction(instanceId, tx => this.roleConfig.recordUse(tx, { sessionId, role: 'main', revision: config.revision,
        main: config.roles.main!.model, router: config.roles.router.model, worker: config.roles.worker.model }))
      return { profile: structuredClone(config.roles.main), revision: config.revision }
    }, () => this.workDelegation)
    this.roleConfig = new RoleConfigStore(storage, instanceId, {
      ...(sessions?.mainRoute ? { main: { name: 'Main', model: sessions.mainRoute, instructions: '', skills: [] } } : {}),
      router: { name: 'Router', model: sessions?.routerRoute ?? { provider: 'unconfigured', model: 'unconfigured' }, instructions: '', skills: [] },
      worker: { name: 'Worker', model: sessions?.workerRoute ?? { provider: 'unconfigured', model: 'unconfigured' }, instructions: '', skills: [] },
    }, Date.now)
    this.executionPolicy = new ExecutionPolicyStore(storage, instanceId, Date.now)
    if (!Array.isArray(source.allowedActorIds)) throw new CoreError('INVALID_CONFIG', 'allowedActorIds must be explicitly configured.')
    for (const actor of source.allowedActorIds) identifier(actor, 'allowedActorId')
    if (source.authoringActorIds !== undefined) {
      if (!Array.isArray(source.authoringActorIds) || source.authoringActorIds.some(actor => typeof actor !== 'string')) throw new CoreError('INVALID_CONFIG', 'authoringActorIds must be an explicit actor list.')
      for (const actor of source.authoringActorIds) identifier(actor, 'authoringActorId')
      if (!source.authoringActorIds.every(actor => source.allowedActorIds.includes(actor))) throw new CoreError('INVALID_CONFIG', 'authoringActorIds must be allowed actors.')
    }
    this.authoringActorIds = source.authoringActorIds === undefined ? undefined : [...source.authoringActorIds]
    const { intake, hostCapabilities: _hostCapabilities, authoringActorIds: _authoringActorIds, ...serializableSource } = source
    this.avoidPolicyPersistence = typeof storage.transaction !== 'function'
    this.defaultAssessor = intake?.assess ?? (sessions ? ((events: Record<string, unknown>[], signal: AbortSignal, onDelivered: () => Promise<void>) => sessions.assessSourceBatch(events, signal, onDelivered)) : undefined)
    this.configuredAssessor = this.defaultAssessor
    this.configuredIntake = intake
    if (intake) {
      const { assess: _assess, ...configuration } = intake
      const clonedConfiguration = structuredClone(configuration)
      this.initialIntake = intake.assess ? { ...clonedConfiguration, assess: intake.assess } : clonedConfiguration
    }
    const clonedSource = structuredClone(serializableSource)
    this.source = intake ? { ...clonedSource, intake } : clonedSource
    const sourceBinding = { ...this.source }
    delete sourceBinding.intake
    this.sourceEvents = new SourceEvents(storage, instanceId, sourceBinding)
    this.membership = new SourceMembership(storage, instanceId, this.source.sourceInstanceId, Date.now)
    this.deliveryState = new DeliveryState(storage, instanceId, this.sourceEvents, Date.now)
    this.proactive = proactiveOptions ? new Proactive(storage, instanceId, proactiveOptions) : undefined
    if (sessions && (effectsOptions.operationTimeoutMs ?? 60000) <= sessions.timeoutMs) throw new CoreError('INVALID_CONFIG', 'The effect deadline must exceed the native Session turn budget.')
    this.effects = new Effects(storage, instanceId, sessions ? { ...effectsOptions, operationTimeoutMs: effectsOptions.operationTimeoutMs ?? 60000 } : effectsOptions)
    this.configureEffectsGate()
    this.deliveries = new Deliveries(storage, instanceId, this.effects, Date.now)
    this.inputs = new WorkInputs(storage, instanceId, this.source, this.sourceEvents, (tx, request) => this.effects.enqueue(tx, request), Date.now)
    this.outbox = new Outbox(storage, instanceId, this.deliveries, this.sourceEvents, this.deliveryState, this.inputs, deliveryOptions.channel)
    this.attentions = new Attentions(storage, instanceId, this.sourceEvents, this.inputs, this.effects, this.deliveries, Date.now)
    this.context = new ContextReader(storage, instanceId, this.sourceEvents, this.attentions, this.deliveries)
    const assessor = intake?.assess ?? (sessions ? ((events: Record<string, unknown>[], signal: AbortSignal, onDelivered: () => Promise<void>) => sessions.assessSourceBatch(events, signal, onDelivered)) : undefined)
    this.evaluations = intake ? new SourceEvaluations(storage, instanceId, intake, this.sourceEvents,
      (tx, event, strength, commandId, policyVersion, newDecision, capabilities) => this.accept(tx, commandId, {
        id: newDecision ? JSON.stringify([event.id, 'manual-requeue', commandId]) : event.id,
        instanceId, source: event.source, eventId: event.objectId, threadId: event.threadId, nativeVersion: event.version, text: event.text!,
        ...(capabilities?.length ? { capabilities } : {}),
      }, `intake:${strength}:${policyVersion}:${event.id}`, { strength, policyVersion }), Date.now, assessor,
      (tx, event) => this.inputs.owns(tx, event), (tx, eventId) => this.inputs.hasPendingRequeue(tx, eventId),
      (tx, eventId, evaluationId) => this.inputs.claimRequeue(tx, eventId, evaluationId),
      (tx, eventId, evaluationId) => this.inputs.consumeRequeue(tx, eventId, evaluationId),
      (tx, eventId, evaluationId) => this.inputs.releaseRequeue(tx, eventId, evaluationId)) : undefined
    this.environments = [...environments]
    if (new Set(environments.map(environment => environment.config.id)).size !== environments.length) throw new CoreError('INVALID_CONFIG', 'Local Environment IDs must be unique within an Engine.')
    this.slots = sessions ? new Slots(storage, instanceId, randomUUID(), slotOptions, Date.now) : undefined
    const jobRuntimeToken = randomUUID()
    this.jobs = sessions ? new Jobs(storage, instanceId, jobRuntimeToken, jobOptions, Date.now) : undefined
    this.previews = this.jobs?.previews
    this.subagents = sessions ? new Subagents(sessions.context, storage, instanceId, randomUUID(), subagentOptions, Date.now) : undefined
    if (sessions) {
      this.execution = new Execution(storage, instanceId, this.effects, sessions, this.inputs, this.attentions, this.sourceEvents,
        this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds, environments, this.slots, this.jobs, this.subagents, this.previews,
        this.deliveries, this.context, this.roleConfig, this.deliveryState, this.host.hostId, this.hostCapabilities,
        () => this.host.epoch())
      this.effects.setStartup(async () => {
        try { await this.execution!.reconcileRemoteWork() }
        catch { /* Keep the independent Input recovery scan running when the remote recovery budget is exhausted. */ }
        try { await this.recoverInterruptedHandoffs() }
        catch { /* Keep ordinary Input recovery available when the handoff reconciliation is blocked. */ }
        await this.execution!.recoverInputs()
      })
    }
    const environment = environments.find(candidate => candidate.kind === 'local' && candidate.config.instanceId === instanceId
      && candidate.config.allowedActorIds.includes(source.actorId) && candidate.config.permissions.includes('read') && candidate.config.permissions.includes('write'))
    if (sessions?.mainRoute && this.execution && environment) {
      this.workDelegation = new WorkDelegation({ storage, instanceId, source, sessions, effects: this.effects, environmentId: environment.config.id,
        createTicket: (brief, item) => this.createDelegatedWorkItem(brief, item),
        readTicket: async ticketId => {
          const conversation = await this.conversation(ticketId)
          const report = conversation.reports[0]
          const status = conversation.status
          if (status !== 'pending' && status !== 'running' && status !== 'ready' && status !== 'waiting-human' && status !== 'stopping' && status !== 'stopped') {
            throw new CoreError('INCOMPLETE_STATE', 'The work state is not recognized.')
          }
          return { ticketId, status, reason: conversation.reason, lifecycle: conversation.lifecycle,
            ...(conversation.setup?.state === 'failed' ? { setupCode: conversation.setup.code ?? 'SETUP_FAILED' } : {}),
            ...(report ? { report: { id: report.id, result: report.result, evidence: report.evidence, artifacts: report.artifacts } } : {}) }
        },
        routerProfile: async () => {
          const config = await this.getRoleConfig()
          this.sessions!.setRoutes(config.roles.router.model, config.roles.worker.model)
          this.sessions!.setRoleInstructions(config.roles.router, config.roles.worker)
          return { revision: config.revision, profile: structuredClone(config.roles.router) }
        },
        recordRouterUse: async (sessionId, revision, profile) => {
          const config = await this.roleConfig.currentView()
          await storage.transaction(instanceId, tx => this.roleConfig.recordUse(tx, { sessionId, role: 'router', revision,
            ...(config.roles.main ? { main: config.roles.main.model } : {}), router: profile.model, worker: config.roles.worker.model }))
        },
        notifyMain: (notification, signal, isCurrent) => this.main.notify(notification, signal, isCurrent),
      })
    }
    const handlers = this.execution?.handlers()
    this.effects.configure({ ...(handlers && this.workDelegation ? this.workDelegation.handlers(handlers) : handlers), outbox: this.outbox.handler() })
  }

  async receiveSource(event: ReceiveSourceEvent) {
    await this.ensurePolicy()
    await this.assertActivationCurrent()
    await this.assertHostAdmission()
    if (this.processingPaused) this.evaluations?.setPaused(true)
    const receipt = await this.sourceEvents.receive(event, async (tx, sourceEvent) => {
      await this.inputs.recordFanout(tx, sourceEvent)
      await this.answerFromSourceEvent(tx, sourceEvent)
    })
    if (this.proactive && receipt.status === 'recorded' && event.type !== 'deleted' && !this.processingPaused) {
      void this.proactive.evaluate({ sourceInstanceId: this.source.sourceInstanceId, eventId: receipt.eventId!, threadId: event.threadId,
        objectId: event.objectId, text: event.text ?? '', authorId: event.authorId ?? this.source.actorId,
        authorKind: event.authorKind ?? 'human', addressing: event.addressing ?? 'direct' }).catch(() => {})
    }
    return receipt
  }

  /** A trusted human reply in a waiting question's Thread answers that question and resumes the work. */
  private async answerFromSourceEvent(tx: AsyncTx, event: SourceEvent) {
    if (event.type === 'deleted' || event.text === undefined || !event.text.trim() || event.authorKind !== 'human') return
    // Only a Feishu reply addressed to the bot is an in-place answer; ordinary discussion stays a follow-up.
    if (this.source.kind !== 'feishu' || (event.addressing !== 'mention' && event.addressing !== 'direct')) return
    const answerers = this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
    if (!answerers.includes(event.authorId)) return
    const currentEvent = await this.sourceEvents.candidate(tx, event)
    if (currentEvent?.id !== event.id) return
    const heads: { attentionId: string }[] = []
    let cursor = ''
    for (let page = 0; page < 10; page++) {
      const batch = await tx.scan<{ attentionId: string }>('attention-head', { limit: 100, after: cursor })
      heads.push(...batch.items.map(item => item.value))
      if (!batch.cursor) break
      cursor = batch.cursor
    }
    const matches: Attention[] = []
    for (const head of heads) {
      const attention = await tx.get<Attention>('attention', head.attentionId)
      if (!attention || attention.status !== 'waiting') continue
      if (attention.destination.threadId !== event.threadId || attention.destination.actorId !== event.authorId) continue
      if (attention.destination.eventId === event.objectId) continue
      matches.push(attention)
    }
    // More than one waiting question in one Thread has no verifiable recipient; leave it to the explicit answer entry.
    if (matches.length !== 1) return
    const match = matches[0]!
    try {
      await this.attentions.answer(tx, { ticketId: match.ticketId, attentionId: match.id, text: event.text,
        commandId: `source-answer:${event.id}`, actorId: event.authorId, sourceEventId: event.id })
    } catch (error) {
      if (!(error instanceof CoreError)) throw error
    }
  }
  getSourceObject(ref: SourceObjectRef) { return this.sourceEvents.get(ref) }
  getSourceHistory(ref: SourceObjectRef, options?: { limit?: number; after?: string }) { return this.sourceEvents.history(ref, options) }
  getSourceReceipt(commandId: string) { return this.sourceEvents.receipt(commandId) }
  getSourceCandidate(ref: SourceObjectRef) { return this.sourceEvents.getCandidate(ref) }

  /** Trusted adapters preserve unversioned observations without treating them as actionable native versions. */
  async receiveUnverifiedSource(event: ReceiveSourceEvent) {
    await this.ensurePolicy()
    await this.assertActivationCurrent()
    await this.assertHostAdmission()
    return this.sourceEvents.receiveUnverified(event)
  }

  async acceptSource(command: AcceptSourceRequest): Promise<Receipt> {
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    if (this.evaluations) throw new CoreError('INTAKE_REQUIRED', 'This source has an Intake Policy; submit candidates through assessSourceBatch.')
    if (!command || Object.keys(command).some(key => !['commandId', 'threadId', 'objectId', 'expectedEventId', 'environmentId', 'target', 'capabilities'].includes(key))) throw new CoreError('INVALID_INPUT', 'Accept a checked source reference, event identity, an optional Environment, execution target and capabilities only.')
    command = { ...command }
    identifier(command.commandId, 'commandId'); identifier(command.threadId, 'threadId'); identifier(command.objectId, 'objectId')
    if (typeof command.expectedEventId !== 'string' || command.expectedEventId.length > 8192) throw new CoreError('INVALID_INPUT', 'A checked current event ID is required.')
    if (command.target !== undefined && !['local-only', 'remote-only', 'auto'].includes(command.target)) {
      throw new CoreError('INVALID_INPUT', 'A Ticket execution target is local-only, remote-only or auto.')
    }
    const capabilities = validateRequiredCapabilities(command.capabilities)
    if (command.environmentId !== undefined) {
      identifier(command.environmentId, 'environmentId')
      const environment = this.environments.find(environment => environment.config.id === command.environmentId)
      if (!environment || !this.execution) throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment and native runtime must be configured.')
      environment.authorize({ instanceId: this.instanceId, actorId: this.source.actorId })
      if (command.target && (command.target === 'local-only' && environment.kind !== 'local'
        || command.target === 'remote-only' && environment.kind !== 'remote')) {
        throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment does not match the Ticket execution target.')
      }
    }
    const fingerprint = capabilities.length
      ? `source-accept:v4:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
        command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null, command.target ?? null, capabilities])).digest('hex')}`
      : command.target
        ? `source-accept:v3:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
          command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null, command.target])).digest('hex')}`
        : `source-accept:v2:${createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId,
          command.threadId, command.objectId, command.expectedEventId, command.environmentId ?? null])).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<CommandRecord>('command', command.commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(tx)
      const event = await this.sourceEvents.candidate(tx, command)
      if (!event || event.id !== command.expectedEventId) throw new CoreError('SOURCE_NOT_CURRENT', 'This source reference is deleted, conflicted, unknown or no longer current; no new work is authorized.')
      if (event.source.actorId !== this.source.actorId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source event cannot borrow another actor’s explicit authorization.')
      return this.accept(tx, command.commandId, { id: event.id, instanceId: this.instanceId, source: event.source, eventId: event.objectId,
        threadId: event.threadId, nativeVersion: event.version, text: event.text!,
        ...(command.environmentId ? { environmentId: command.environmentId } : {}), ...(command.target ? { target: command.target } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(command.environmentId ? { targetSource: 'explicit' as const } : command.target ? { targetSource: 'ticket' as const } : {}) }, fingerprint)
    })
  }

  async assessSourceBatch(command: { commandId: string; threadId: string; eventIds: string[] }): Promise<SourceEvaluation> {
    await this.ensurePolicy()
    await this.assertActivationCurrent()
    await this.assertHostAdmission()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before evaluating source candidates.')
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'Source events remain recorded while new evaluations are paused.')
    return this.evaluations.assess(command)
  }

  async listEvaluations(threadId: string) {
    await this.ensurePolicy()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before querying source evaluations.')
    return this.evaluations.list(threadId)
  }

  dismissEvaluation(command: { commandId: string; evaluationId: string; reason: string }) {
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before dismissing an Eval.')
    if (!command || Object.keys(command).some(key => !['commandId', 'evaluationId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Dismissing an Eval accepts commandId, evaluationId and reason only.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to dismiss evaluations.')
    return this.evaluations.dismiss({ ...command, actorId: this.source.actorId })
  }

  async submit(command: SubmitRequest): Promise<Receipt> {
    const submitted = command ? structuredClone(command) : command
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    command = submitted
    if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).some(key => !['commandId', 'eventId', 'text', 'mode', 'execution', 'environmentId', 'target', 'capabilities'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Only commandId, eventId, text, mode, execution, environmentId, target and capabilities are accepted from request data.')
    }
    if (this.source.allowedThreadIds !== undefined || this.source.allowedThreadPrefixes !== undefined || this.source.versionOrder !== undefined) throw new CoreError('UNSUPPORTED_CAPABILITY', 'A versioned source must use receiveSource and acceptSource so native scope, conflicts and tombstones remain authoritative.')
    command = { ...command }
    identifier(command.commandId, 'commandId')
    identifier(command.eventId, 'eventId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) throw new CoreError('INVALID_INPUT', 'Request text must contain 1 to 65536 bytes.')
    if (command.mode !== undefined && command.mode !== 'explicit' || command.execution !== undefined && command.execution !== 'local') throw new CoreError('UNSUPPORTED_CAPABILITY', 'Only explicit requests in the local environment are enabled.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This desktop actor is not authorized by its source instance.')
    if (command.target !== undefined && !['local-only', 'remote-only', 'auto'].includes(command.target)) {
      throw new CoreError('INVALID_INPUT', 'A Ticket execution target is local-only, remote-only or auto.')
    }
    const capabilities = validateRequiredCapabilities(command.capabilities)
    const source: Source = { kind: this.source.kind ?? 'desktop', sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId }
    const triggerId = JSON.stringify([this.instanceId, source.kind, source.sourceInstanceId, command.eventId, 'created', '1'])
    if (command.environmentId !== undefined) identifier(command.environmentId, 'environmentId')
    if (command.environmentId !== undefined) {
      const environment = this.environments.find(environment => environment.config.id === command.environmentId)
      if (!environment || !this.execution) throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment and native runtime must be configured.')
      environment.authorize({ instanceId: this.instanceId, actorId: source.actorId })
      if (command.target && (command.target === 'local-only' && environment.kind !== 'local'
        || command.target === 'remote-only' && environment.kind !== 'remote')) {
        throw new CoreError('ENVIRONMENT_DENIED', 'The requested Environment does not match the Ticket execution target.')
      }
    }
    const input = capabilities.length ? ['desktop-submit-v4', source, command.eventId, command.text, 'explicit', 'local',
      command.environmentId ?? null, command.target ?? null, capabilities]
      : command.target ? ['desktop-submit-v3', source, command.eventId, command.text, 'explicit', 'local', command.environmentId ?? null, command.target]
        : command.environmentId === undefined ? ['desktop-submit-v1', source, command.eventId, command.text, 'explicit', 'local']
          : ['desktop-submit-v2', source, command.eventId, command.text, 'explicit', 'local', command.environmentId]
    const fingerprint = `sha256:${capabilities.length ? 'v4' : command.target ? 'v3' : command.environmentId === undefined ? 'v1' : 'v2'}:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.sourceEvents.requireDirectMode(tx)
      const existing = await tx.get<CommandRecord>('command', command.commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(tx)
      return this.accept(tx, command.commandId, { id: triggerId, instanceId: this.instanceId, source, eventId: command.eventId, text: command.text,
        ...(command.environmentId ? { environmentId: command.environmentId } : {}), ...(command.target ? { target: command.target } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(command.environmentId ? { targetSource: 'explicit' as const } : command.target ? { targetSource: 'ticket' as const } : {}) }, fingerprint)
    })
  }

  private async createDelegatedWorkItem(brief: import('./work-delegation.js').MainWorkBrief, item: MainWorkItem): Promise<Receipt> {
    await this.ensurePolicy()
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'New work cannot be accepted while processing is paused.')
    await this.assertActivationCurrent()
    await this.assertHostAdmission()
    if (!brief.sourceEventId) throw new CoreError('INCOMPLETE_STATE', 'The Main WorkBrief source event is missing.')
    identifier(brief.id, 'workBriefId'); identifier(item.id, 'workItemId'); identifier(brief.sourceEventId, 'sourceEventId')
    if (brief.instanceId !== this.instanceId || item.workBriefId !== brief.id) throw new CoreError('INSTANCE_MISMATCH', 'The delegated item does not belong to this Main WorkBrief.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This desktop actor cannot establish delegated work.')
    const source: Source = { kind: this.source.kind ?? 'desktop', sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId }
    const triggerId = JSON.stringify([this.instanceId, source.kind, source.sourceInstanceId, brief.sourceEventId, item.id, 'main-work-item'])
    const text = `Original Main request:\n${brief.originalUserText}\n\nGoal:\n${item.goal}\n\nConstraints:\n${item.constraints}\n\nAcceptance criteria:\n${item.acceptanceCriteria}`
    const trigger: Work['trigger'] = { id: triggerId, instanceId: this.instanceId, source, eventId: brief.sourceEventId,
      text, environmentId: brief.environmentId, target: 'local-only', targetSource: 'ticket' }
    const commandId = `main-work-ticket:${brief.id}:${item.id}`
    const fingerprint = `sha256:main-work-item-v1:${createHash('sha256').update(canonicalJson([
      this.instanceId, source, brief.sourceEventId, item.id, item.goal, item.constraints, item.acceptanceCriteria, brief.environmentId,
    ])).digest('hex')}`
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      await this.sourceEvents.requireDirectMode(transaction)
      const existing = await transaction.get<CommandRecord>('command', commandId)
      if (existing) return this.replay(existing, fingerprint, 'command')
      await this.assertHostAdmissionIn(transaction)
      return this.accept(transaction, commandId, trigger, fingerprint, { mandateScope: item.goal,
        linkTicket: async (tx, receipt) => {
          await tx.insert('work-ticket', receipt.ticketId, { workBriefId: brief.id, workItemId: item.id, ticketId: receipt.ticketId })
          await tx.insert('work-item-ticket', item.id, { workBriefId: brief.id, workItemId: item.id, ticketId: receipt.ticketId })
        } })
    })
  }


  private async accept(tx: AsyncTx, commandId: string, trigger: Work['trigger'], fingerprint: string,
    options: { strength?: 'explicit' | 'inferred'; policyVersion?: string; mandateScope?: string; linkTicket?: (tx: AsyncTx, receipt: Receipt) => Promise<void> } = {}): Promise<Receipt> {
    const triggerId = trigger.id
    const source = trigger.source
    await this.assertActivationIn(tx)
    const event = await tx.get<EventRecord>('event', triggerId)
    if (event) {
      const receipt = this.replay(event, fingerprint, 'event')
      await tx.insert('command', commandId, { fingerprint, receipt })
      return receipt
    }
    await this.assertHostAdmissionIn(tx)
    const environment = trigger.environmentId ? this.environments.find(candidate => candidate.config.id === trigger.environmentId) : undefined
    const policy = await this.executionPolicy.currentIn(tx)
    const target: ExecutionTarget = trigger.target ?? (environment ? environment.kind === 'remote' ? 'remote-only' : 'local-only'
      : policy.defaultTarget === 'local' ? 'local-only' : policy.defaultTarget)
    const targetSource = trigger.targetSource ?? (environment ? 'explicit' : trigger.target ? 'ticket' : 'default')
    const capabilities = validateRequiredCapabilities(trigger.capabilities)
    const persistedTrigger: Work['trigger'] = { ...trigger, target, targetSource, ...(capabilities.length ? { capabilities } : {}) }
    const environmentKind = target === 'auto' ? 'auto' : target === 'remote-only' ? 'remote' : 'local'
    const ticketId = randomUUID()
    const decisionId = randomUUID()
    const mandateId = randomUUID()
    const work: Work = {
      trigger: persistedTrigger,
      decision: { id: decisionId, instanceId: this.instanceId, triggerId, outcome: 'accept', policyVersion: options.policyVersion ?? 'desktop-explicit-v1' },
      mandate: { id: mandateId, instanceId: this.instanceId, decisionId, scope: options.mandateScope ?? trigger.text, strength: options.strength ?? 'explicit', environment: environmentKind,
        ...(persistedTrigger.capabilities?.length ? { capabilities: [...persistedTrigger.capabilities] } : {}) },
      ticket: { id: ticketId, instanceId: this.instanceId, mandateId, triggerId, state: 'open', directionVersion: 1 },
      intent: { id: randomUUID(), instanceId: this.instanceId, ticketId, state: 'pending', reason: this.execution ? 'router-pending' : 'worker-not-enabled', environment: environmentKind },
    }
    const receipt: Receipt = { instanceId: this.instanceId, ticketId, triggerId, acceptedCommandId: commandId, status: 'pending' }
    await tx.insert('trigger', triggerId, work.trigger)
    await tx.insert('decision', decisionId, work.decision)
    await tx.insert('mandate', mandateId, work.mandate)
    await tx.insert('ticket', ticketId, work.ticket)
    await tx.insert('intent', ticketId, work.intent)
    await this.inputs.subscribe(tx, ticketId, persistedTrigger)
    await tx.insert('event', triggerId, { fingerprint, receipt })
    await tx.insert('command', commandId, { fingerprint, receipt })
    await options.linkTicket?.(tx, receipt)
    await this.effects.enqueue(tx, { key: ticketId, stream: 'notice', scope: 'router', payload: { type: 'request-accepted', ticketId, triggerId } })
    const deliveryId = `${ticketId}:acknowledgement`
    const destination = { ...source, eventId: trigger.eventId, ...(trigger.threadId ? { threadId: trigger.threadId } : {}) }
    const effect = await this.effects.enqueue(tx, { key: ticketId, stream: 'outbox', scope: ticketId, payload: {
      purpose: 'acknowledgement', text: 'Request accepted.', ticketId, deliveryId, destination,
    } })
    await this.deliveries.record(tx, { id: deliveryId, ticketId, purpose: 'acknowledgement', text: 'Request accepted.', destination,
      basis: { kind: 'accepted-request', triggerId }, effectId: effect.id, effectGeneration: effect.generation }, effect)
    return receipt
  }

  private replay(record: CommandRecord | EventRecord, fingerprint: string, kind: string): Receipt {
    if (record.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', `The ${kind} ID was already used with different input.`)
    return record.receipt
  }

  async conversation(ticketId: string) {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'No native Session adapter is configured.')
    const conversation = await this.execution.conversation(ticketId)
    const delivery = await this.storage.transaction(this.instanceId, async tx => ({
      conditions: await this.deliveryState.list(tx, ticketId),
      resultTarget: await this.deliveryState.target(tx, ticketId, 'result'),
    }))
    return { ...conversation, globalPaused: this.processingPaused, policyRevision: this.policyRevision,
      roleConfigRevision: this.roleConfigRevision, deliveryConditions: delivery.conditions,
      resultDeliveryTarget: delivery.resultTarget, deliveryPending: delivery.conditions.some(condition => condition.state === 'open' || condition.state === 'draft') }
  }

  async retrySetup(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution || !this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A configured authorized native runtime is required.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Setup retry accepts commandId and ticketId only.')
    return this.execution.retrySetup(command.commandId, command.ticketId, this.source.actorId)
  }

  listEnvironments() {
    return this.environments.filter(environment => environment.config.instanceId === this.instanceId && environment.config.allowedActorIds.includes(this.source.actorId))
      .map(environment => ({ id: environment.config.id, kind: environment.kind, root: environment.config.root,
        permissions: [...environment.config.permissions],
        ...(environment.kind === 'remote' ? { deviceId: environment.deviceId, online: environment.online ?? false } : {}) }))
  }

  /**
   * Reports the native asset combinations this Environment can actually serve. Skills are
   * named as an explicit gap because the installed harness exposes no public discovery seam.
   */
  async getEnvironmentCapabilities(environmentId: string): Promise<EnvironmentAssetCapabilities> {
    await this.ensurePolicy()
    identifier(environmentId, 'environmentId')
    const environment = this.environments.find(candidate => candidate.config.id === environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    if (!environment.assetCapabilities) {
      return unsupportedAssetCapabilities([environment.kind === 'local' ? 'local-asset-store-unconfigured' : 'device-asset-store-unconfigured'])
    }
    return environment.assetCapabilities({ instanceId: this.instanceId, actorId: this.source.actorId })
  }

  /**
   * Re-reads a retained asset through its original Environment identity. A disconnected device
   * is contacted again by its stable reference; a changed root or incarnation is a stale
   * reference, never a same-named Host substitute.
   */
  async readEnvironmentAsset(request: { environmentId: string; reference: EnvironmentAssetReference; offset?: number; maxBytes?: number }) {
    await this.ensurePolicy()
    if (!request || Object.keys(request).some(key => !['environmentId', 'reference', 'offset', 'maxBytes'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An asset read accepts environmentId, reference, offset and maxBytes only.')
    }
    identifier(request.environmentId, 'environmentId')
    assertReferenceShape(request.reference)
    const environment = this.environments.find(candidate => candidate.config.id === request.environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    if (request.reference.environmentId !== environment.config.id || request.reference.environmentKind !== environment.kind) {
      throw new CoreError('REFERENCE_STALE', 'The reference belongs to a different Execution Environment.')
    }
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    const bound = await environment.prepare(identity)
    const capabilities = await this.getEnvironmentCapabilities(request.environmentId)
    const gaps = request.reference.kind === 'attachment' && !capabilities.attachments.supported ? capabilities.attachments.gaps
      : request.reference.kind === 'spill' && !capabilities.spill.supported ? capabilities.spill.gaps
        : request.reference.kind === 'skill' && !capabilities.skills.supported ? capabilities.skills.gaps : []
    if (gaps.length) throw new UnsupportedEnvironmentCombination(`This Environment cannot serve a ${request.reference.kind} reference.`, gaps)
    if (!bound.readAsset) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment implements no public asset read seam.')
    return bound.readAsset(request.reference, {
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  /** Durably saves exact attachment bytes into one authorized Environment. */
  async saveEnvironmentAttachment(command: { commandId: string; environmentId: string; name: string; data: string; encoding?: 'utf8' | 'base64'; mediaType?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'environmentId', 'name', 'data', 'encoding', 'mediaType'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An attachment save accepts commandId, environmentId, name, data, encoding and mediaType only.')
    }
    identifier(command.commandId, 'commandId')
    identifier(command.environmentId, 'environmentId')
    if (command.encoding !== undefined && command.encoding !== 'utf8' && command.encoding !== 'base64') {
      throw new CoreError('INVALID_INPUT', 'Attachment encoding is utf8 or base64.')
    }
    if (typeof command.data !== 'string') throw new CoreError('INVALID_INPUT', 'Attachment data must be text.')
    const data = attachmentBytes(command.data, command.encoding)
    const environment = this.environments.find(candidate => candidate.config.id === command.environmentId
      && candidate.config.instanceId === this.instanceId && candidate.config.allowedActorIds.includes(this.source.actorId))
    if (!environment) throw new CoreError('ENVIRONMENT_DENIED', 'This Environment is not configured and authorized for this actor.')
    environment.authorize({ instanceId: this.instanceId, actorId: this.source.actorId })
    const fingerprint = createHash('sha256').update(canonicalJson(['environment-attachment-v1', this.instanceId,
      this.source.sourceInstanceId, this.source.actorId, command.environmentId, command.name, data.toString('base64'),
      command.mediaType ?? null])).digest('hex')
    const key = this.commandKey(command.commandId)
    const prior = await this.storage.transaction(this.instanceId, transaction =>
      transaction.get<{ fingerprint: string; reference: EnvironmentAssetReference }>('work-command', key))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attachment command was reused with different input.')
      return prior.reference
    }
    const bound = await environment.prepare({ instanceId: this.instanceId, actorId: this.source.actorId })
    if (!bound.saveAttachment) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment implements no public attachment write seam.')
    const reference = await bound.saveAttachment({ name: command.name, data,
      ...(command.mediaType ? { mediaType: command.mediaType } : {}) })
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<{ fingerprint: string; reference: EnvironmentAssetReference }>('work-command', key)
      if (current) {
        if (current.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attachment command was reused with different input.')
        return current.reference
      }
      await transaction.insert('work-command', key, { fingerprint, reference })
      return reference
    })
  }

  getExecutionPolicy() {
    return this.executionPolicy.get()
  }

  async updateExecutionPolicy(command: { commandId: string; expectedRevision: number; policy: Partial<ExecutionPolicyConfig> }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'policy'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An execution policy update accepts commandId, expectedRevision and policy only.')
    }
    identifier(command.commandId, 'commandId')
    if (!command.policy || typeof command.policy !== 'object' || Array.isArray(command.policy)) {
      throw new CoreError('INVALID_INPUT', 'An execution policy update needs an explicit policy object.')
    }
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot change the execution policy.')
    }
    if (command.policy.preferredEnvironmentId !== undefined) {
      const preferred = this.environments.find(environment => environment.config.id === command.policy.preferredEnvironmentId
        && environment.config.instanceId === this.instanceId && environment.config.allowedActorIds.includes(this.source.actorId))
      if (!preferred) throw new CoreError('ENVIRONMENT_DENIED', 'The preferred Environment is not configured and authorized for this actor.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['execution-policy-update', this.instanceId,
      command.expectedRevision, command.policy])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; policy: ExecutionPolicyView }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The execution policy command was reused with different input.')
        return prior.policy
      }
      const policy = await this.executionPolicy.write(transaction, command.expectedRevision, command.policy)
      await transaction.insert('work-command', key, { fingerprint, policy })
      return policy
    })
  }

  getExecutionSelection(ticketId: string) {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The execution selection belongs to a different source instance.')
      }
      return loadExecutionSelection(transaction, ticketId)
    })
  }

  getCapabilityLocations() {
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot inspect capability locations.')
    }
    return capabilityLocations(this.hostCapabilities)
  }

  async getCapabilityPlan(ticketId: string): Promise<CapabilityPlanView> {
    identifier(ticketId, 'ticketId')
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
        || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The capability plan belongs to a different source instance or actor.')
      }
    })
    return (await this.conversation(ticketId)).capabilityPlan
  }

  async prepareHandoffCopy(command: { commandId: string; ticketId: string; targetEnvironmentId: string }): Promise<HandoffCopyView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'targetEnvironmentId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Preparing a work copy accepts commandId, ticketId and targetEnvironmentId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.targetEnvironmentId, 'targetEnvironmentId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot prepare a work copy.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['prepare-handoff-copy', this.instanceId, command.ticketId, command.targetEnvironmentId])).digest('hex')
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', command.ticketId),
      assignment: await transaction.get<{ id: string; environment?: EnvironmentLocation }>('assignment', command.ticketId),
      trigger: await this.triggerFor(transaction, command.ticketId),
      prior: await transaction.get<{ fingerprint: string; record: HandoffCopyView }>('work-command', key),
    }))
    if (initial.prior) {
      if (initial.prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The work-copy command was reused for different input.')
      return initial.prior.record
    }
    if (!initial.ticket || initial.ticket.state !== 'open') throw new CoreError('NOT_FOUND', 'The Ticket is not open.')
    if (initial.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || initial.trigger.source.actorId !== this.source.actorId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may prepare this work copy.')
    }
    const assignment = initial.assignment
    if (!assignment?.environment) throw new CoreError('ENVIRONMENT_NOT_BOUND', 'The Ticket has no fixed source Environment to inspect.')
    const source = this.environments.find(environment => environment.config.id === assignment.environment!.id)
    const target = this.environments.find(environment => environment.config.id === command.targetEnvironmentId)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The source or target Environment is not configured.')
    if (source.config.id === target.config.id) throw new CoreError('ENVIRONMENT_DENIED', 'A work copy needs a different target Environment.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    const blockers: WorkCopyBlocker[] = []
    let sourceProbe: EnvironmentProbe | undefined
    let targetProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    try { targetProbe = target.probe ? await target.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    const sourceLocation: EnvironmentLocation = { ...assignment.environment,
      ...(sourceProbe && !assignment.environment.version ? { version: sourceProbe.version } : {}),
      ...(sourceProbe && !assignment.environment.fingerprint ? { fingerprint: sourceProbe.fingerprint } : {}) }
    const targetLocation: EnvironmentLocation = { ...environmentLocation(target),
      ...(targetProbe ? { version: targetProbe.version, fingerprint: targetProbe.fingerprint } : {}) }
    let sourceSnapshot: WorkCopySnapshot | undefined
    let targetSnapshot: WorkCopySnapshot | undefined
    const sourceInspection = await inspectEnvironmentWorkCopy(source, identity)
    if (sourceInspection.snapshot) sourceSnapshot = sourceInspection.snapshot
    else blockers.push(sourceInspection.blocker!)
    const targetInspection = await inspectEnvironmentWorkCopy(target, identity)
    if (targetInspection.snapshot) targetSnapshot = targetInspection.snapshot
    else blockers.push(targetInspection.blocker!)
    let comparison: WorkCopyComparison | undefined
    if (sourceSnapshot && targetSnapshot) {
      comparison = compareWorkCopy(sourceSnapshot, targetSnapshot, 'prepare')
      blockers.push(...comparison.blockers)
    }
    const unique = uniqueBlockers(blockers)
    const record: HandoffCopyView = {
      id: randomUUID(), instanceId: this.instanceId, ticketId: command.ticketId, assignmentId: assignment.id,
      source: sourceLocation, target: targetLocation,
      baseCommit: sourceSnapshot?.git.commit ?? '', ...(sourceSnapshot?.git.branch ? { branch: sourceSnapshot.git.branch } : {}),
      files: comparison?.filesToCopy ?? sourceSnapshot?.changes ?? [], patch: sourceSnapshot?.patch ?? { bytes: 0, sha256: '' },
      totalBytes: comparison?.totalBytes ?? sourceSnapshot?.totalBytes ?? 0,
      status: unique.length || !sourceSnapshot || !targetSnapshot || comparison?.status === 'handoff-blocked' ? 'handoff-blocked' : 'prepared',
      blockers: unique, preparedAt: Date.now(),
    }
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; record: HandoffCopyView }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The work-copy command was reused for different input.')
        return prior.record
      }
      await saveHandoffCopy(transaction, record)
      await transaction.insert('work-command', key, { fingerprint, record })
      return record
    })
  }

  async verifyHandoffCopy(command: { commandId: string; ticketId: string }): Promise<HandoffCopyView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Verifying a work copy accepts commandId and ticketId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot verify a work copy.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['verify-handoff-copy', this.instanceId, command.ticketId])).digest('hex')
    const prior = await this.storage.transaction(this.instanceId, transaction => transaction.get<{ fingerprint: string; recordId: string }>('work-command', key))
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The work-copy verification command was reused for different input.')
      const existing = await this.storage.transaction(this.instanceId, transaction => loadHandoffCopy(transaction, command.ticketId))
      if (!existing) throw new CoreError('NOT_FOUND', 'The work-copy preparation no longer exists.')
      return existing
    }
    const record = await this.storage.transaction(this.instanceId, async transaction => {
      const current = await loadHandoffCopy(transaction, command.ticketId)
      if (!current) throw new CoreError('NOT_FOUND', 'Prepare a work copy before verifying it.')
      const trigger = await this.triggerFor(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may verify this work copy.')
      }
      return current
    })
    const source = this.environments.find(environment => environment.config.id === record.source.id)
    const target = this.environments.find(environment => environment.config.id === record.target.id)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The prepared source or target Environment is no longer configured.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    const blockers: WorkCopyBlocker[] = []
    if (source.kind !== record.source.kind || source.config.root !== record.source.root) {
      blockers.push({ code: 'source-environment-changed', message: 'The source Environment identity changed after preparation.' })
    }
    if (target.kind !== record.target.kind || target.config.root !== record.target.root
      || target.deviceId !== record.target.deviceId || target.deviceIncarnation !== record.target.deviceIncarnation) {
      blockers.push({ code: 'target-environment-changed', message: 'The target Environment identity changed after preparation.' })
    }
    let sourceProbe: EnvironmentProbe | undefined
    let targetProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    try { targetProbe = target.probe ? await target.probe(identity) : undefined }
    catch (error) { blockers.push(...workCopyBlockers(error)) }
    if (sourceProbe && record.source.version && sourceProbe.version !== record.source.version
      || sourceProbe && record.source.fingerprint && sourceProbe.fingerprint !== record.source.fingerprint) {
      blockers.push({ code: 'source-environment-changed', message: 'The source Environment version or fingerprint changed after preparation.' })
    }
    if (targetProbe && record.target.version && targetProbe.version !== record.target.version
      || targetProbe && record.target.fingerprint && targetProbe.fingerprint !== record.target.fingerprint) {
      blockers.push({ code: 'target-environment-changed', message: 'The target Environment version or fingerprint changed after preparation.' })
    }
    let sourceSnapshot: WorkCopySnapshot | undefined
    let targetSnapshot: WorkCopySnapshot | undefined
    const sourceInspection = await inspectEnvironmentWorkCopy(source, identity)
    if (sourceInspection.snapshot) sourceSnapshot = sourceInspection.snapshot
    else blockers.push(sourceInspection.blocker!)
    const targetInspection = await inspectEnvironmentWorkCopy(target, identity)
    if (targetInspection.snapshot) targetSnapshot = targetInspection.snapshot
    else blockers.push(targetInspection.blocker!)
    if (!sourceSnapshot || sourceSnapshot.git.commit !== record.baseCommit || sourceSnapshot.patch.sha256 !== record.patch.sha256
      || !sameWorkCopyFiles(sourceSnapshot.changes, record.files)) {
      blockers.push({ code: 'source-changed', message: 'The source work copy changed after preparation.' })
    }
    if (sourceSnapshot && targetSnapshot) {
      const comparison = compareWorkCopy(sourceSnapshot, targetSnapshot, 'verify')
      blockers.push(...comparison.blockers)
    }
    const unique = uniqueBlockers(blockers)
    const next: HandoffCopyView = { ...record, status: unique.length || !sourceSnapshot || !targetSnapshot ? 'handoff-blocked' : 'verified',
      blockers: unique, ...(unique.length || !sourceSnapshot || !targetSnapshot ? {} : { verifiedAt: Date.now() }) }
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await loadHandoffCopy(transaction, command.ticketId)
      if (!current || current.id !== record.id) throw new CoreError('COMMIT_UNKNOWN', 'The work-copy preparation changed during verification.')
      await saveHandoffCopy(transaction, next)
      await transaction.insert('work-command', key, { fingerprint, recordId: next.id })
      return next
    })
  }

  async getHandoffCopy(ticketId: string): Promise<HandoffCopyView | undefined> {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The work copy belongs to a different source instance or actor.')
      }
      return loadHandoffCopy(transaction, ticketId)
    })
  }

  async requestHandoff(command: { commandId: string; ticketId: string; targetEnvironmentId: string; reason: string }): Promise<EnvironmentHandoffView> {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'targetEnvironmentId', 'reason'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A handoff accepts commandId, ticketId, targetEnvironmentId and reason only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.targetEnvironmentId, 'targetEnvironmentId')
    if (!command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'A handoff needs a bounded reason.')
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'A handoff requires a configured native runtime.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot hand off work.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['request-handoff', this.instanceId, command.ticketId,
      command.targetEnvironmentId, command.reason])).digest('hex')
    const initial = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', command.ticketId),
      assignment: await transaction.get<{ id: string; generation: string; environment?: EnvironmentLocation }>('assignment', command.ticketId),
      trigger: await this.triggerFor(transaction, command.ticketId),
      prior: await transaction.get<{ fingerprint: string; record: EnvironmentHandoffView }>('work-command', key),
    }))
    if (initial.prior) {
      if (initial.prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The handoff command was reused for different input.')
      return initial.prior.record
    }
    if (this.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'A handoff cannot start while processing is paused.')
    if (!initial.ticket || initial.ticket.state !== 'open') throw new CoreError('NOT_FOUND', 'The Ticket is not open.')
    if (initial.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || initial.trigger.source.actorId !== this.source.actorId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may request this handoff.')
    }
    if (!initial.assignment?.environment) throw new CoreError('ENVIRONMENT_NOT_BOUND', 'The Ticket has no fixed source Environment.')
    const source = this.environments.find(environment => environment.config.id === initial.assignment!.environment!.id)
    const target = this.environments.find(environment => environment.config.id === command.targetEnvironmentId)
    if (!source || !target) throw new CoreError('ENVIRONMENT_DENIED', 'The source or target Environment is not configured.')
    const identity = { instanceId: this.instanceId, actorId: this.source.actorId }
    source.authorize(identity); target.authorize(identity)
    let sourceProbe: EnvironmentProbe | undefined
    try { sourceProbe = source.probe ? await source.probe(identity) : undefined } catch { sourceProbe = undefined }
    const targetCheck = await this.handoffTarget({ ticketId: command.ticketId, targetEnvironmentId: command.targetEnvironmentId,
      trigger: initial.trigger, target })
    const sourceLocation: EnvironmentLocation = { ...initial.assignment.environment,
      ...(sourceProbe && !initial.assignment.environment.version ? { version: sourceProbe.version } : {}),
      ...(sourceProbe && !initial.assignment.environment.fingerprint ? { fingerprint: sourceProbe.fingerprint } : {}) }
    const copy = await this.getHandoffCopy(command.ticketId)
    return this.execution.requestEnvironmentHandoff({ ticketId: command.ticketId, source: sourceLocation,
      target: targetCheck.target, ...(copy ? { copy } : {}), ...(targetCheck.blockers.length ? { targetBlockers: targetCheck.blockers } : {}),
      revalidate: () => this.revalidateHandoff(command.commandId, command.ticketId, command.targetEnvironmentId),
      command: { key, fingerprint }, actorId: this.source.actorId, reason: command.reason })
  }

  private async handoffTarget(request: { ticketId: string; targetEnvironmentId: string; trigger: Work['trigger'];
    target: ExecutionEnvironment; actorId?: string }) {
    const { ticketId, targetEnvironmentId, trigger, target, actorId = this.source.actorId } = request
    if (trigger.target && !targetMatches(target.kind, trigger.target)) {
      return { target: environmentLocation(target), blockers: [{ code: 'target-ineligible',
        message: `The ${target.kind} Environment is excluded by the Ticket execution target ${trigger.target}.` }] }
    }
    const policy = await this.executionPolicy.get()
    const selection = await selectExecutionTarget({ ticketId, instanceId: this.instanceId,
      actorId, hostId: this.host.hostId, environments: this.environments, policy,
      ...(trigger.target ? { ticketTarget: trigger.target } : {}),
      explicitEnvironmentId: targetEnvironmentId, source: 'explicit',
      ...(trigger.capabilities?.length ? { requiredCapabilities: trigger.capabilities } : {}),
      hostCapabilities: this.hostCapabilities })
    if (selection.status !== 'selected' || !selection.selected) {
      return { target: environmentLocation(target), blockers: [{ code: 'target-ineligible',
        message: selection.reason ?? 'The target Environment is not eligible for this Ticket.' }] }
    }
    return { target: structuredClone(selection.selected), blockers: [] as HandoffBlocker[] }
  }

  private async revalidateHandoff(commandId: string, ticketId: string,
    targetEnvironmentId: string): Promise<EnvironmentHandoffRevalidation> {
    return this.revalidateHandoffTarget({ ticketId, targetEnvironmentId, actorId: this.source.actorId,
      verifyCommandId: `handoff-verify:${commandId}` })
  }

  private async revalidateHandoffTarget(request: { ticketId: string; targetEnvironmentId: string; actorId: string;
    verifyCommandId: string; expectedSource?: EnvironmentLocation }): Promise<EnvironmentHandoffRevalidation> {
    const blockers: HandoffBlocker[] = []
    const loaded = await this.storage.transaction(this.instanceId, async transaction => ({
      ticket: await transaction.get<Work['ticket']>('ticket', request.ticketId),
      trigger: await this.triggerFor(transaction, request.ticketId),
    }))
    if (!loaded.ticket || loaded.ticket.state !== 'open') {
      return { blockers: [{ code: 'ticket-ended', message: 'The Ticket is not open.' }] }
    }
    if (!request.expectedSource && (loaded.trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
      || loaded.trigger.source.actorId !== this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source actor may revalidate this handoff.')
    }
    if (request.expectedSource) {
      const source = this.environments.find(environment => environment.config.id === request.expectedSource!.id)
      if (!source || source.kind !== request.expectedSource.kind || source.config.root !== request.expectedSource.root) {
        blockers.push({ code: 'source-environment-changed', message: 'The recorded source Environment is no longer configured with the same identity.' })
      } else {
        try { source.authorize({ instanceId: this.instanceId, actorId: request.actorId }) }
        catch { blockers.push({ code: 'source-environment-changed', message: 'The recorded source Environment no longer authorizes the requesting actor.' }) }
      }
    }
    const target = this.environments.find(environment => environment.config.id === request.targetEnvironmentId)
    if (!target) return { blockers: uniqueBlockers([...blockers,
      { code: 'target-ineligible', message: 'The target Environment is no longer configured.' }]) }
    try { target.authorize({ instanceId: this.instanceId, actorId: request.actorId }) }
    catch { return { blockers: uniqueBlockers([...blockers,
      { code: 'target-ineligible', message: 'The target Environment no longer authorizes the requesting actor.' }]) } }
    const targetCheck = await this.handoffTarget({ ticketId: request.ticketId, targetEnvironmentId: request.targetEnvironmentId,
      trigger: loaded.trigger, target, actorId: request.actorId })
    const copyCheck = await this.verifiedHandoffCopy(request.verifyCommandId, request.ticketId)
    return { target: targetCheck.target, ...(copyCheck.copy ? { copy: copyCheck.copy } : {}),
      blockers: uniqueBlockers([...blockers, ...targetCheck.blockers, ...copyCheck.blockers]) }
  }

  private async verifiedHandoffCopy(commandId: string, ticketId: string) {
    const current = await this.getHandoffCopy(ticketId)
    if (!current) {
      return { blockers: [{ code: 'handoff-copy-missing', message: 'No prepared work copy exists for this handoff.' }] as HandoffBlocker[] }
    }
    try {
      const copy = await this.verifyHandoffCopy({ commandId: `handoff-verify:${commandId}`, ticketId })
      return { copy, blockers: copy.blockers as HandoffBlocker[] }
    } catch (error) {
      const blockers = workCopyBlockers(error)
      return { copy: { ...current, status: 'handoff-blocked' as const, blockers }, blockers: blockers as HandoffBlocker[] }
    }
  }

  /**
   * Reconcile unfinished handoffs before ordinary Inputs resume. At most 25 are continued per start so a large
   * backlog cannot hold startup; the remaining active records stay durable and are retried on the next start.
   */
  private async recoverInterruptedHandoffs() {
    if (!this.execution || this.processingPaused) return
    const active = await this.execution.activeEnvironmentHandoffs()
    let recovered = 0
    for (const record of active) {
      if (this.processingPaused || recovered >= 25) return
      try {
        const trigger = await this.storage.transaction(this.instanceId, transaction => this.triggerFor(transaction, record.ticketId))
        if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) continue
        await this.execution.recoverEnvironmentHandoff(record, () => this.revalidateHandoffRecord(record))
        recovered++
      } catch (error) {
        await this.execution.failInterruptedHandoff(record, error).catch(() => {})
      }
    }
  }

  private async revalidateHandoffRecord(record: EnvironmentHandoffView): Promise<EnvironmentHandoffRevalidation> {
    return this.revalidateHandoffTarget({ ticketId: record.ticketId, targetEnvironmentId: record.target.id,
      actorId: record.requestedBy, verifyCommandId: `recover:${record.id}`, expectedSource: record.source })
  }

  async getEnvironmentHandoff(ticketId: string): Promise<EnvironmentHandoffView | undefined> {
    identifier(ticketId, 'ticketId')
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'A handoff query requires a configured native runtime.')
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The handoff belongs to a different source instance or actor.')
      }
    })
    return this.execution.getEnvironmentHandoff(ticketId)
  }

  async retryExecutionTarget(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Choosing an execution target requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Retrying an execution target accepts commandId and ticketId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot retry an execution target.')
    }
    await this.storage.transaction(this.instanceId, async transaction => {
      const trigger = await this.triggerFor(transaction, command.ticketId)
      if (trigger.source.sourceInstanceId !== this.sourceEvents.sourceInstanceId
        || trigger.source.actorId !== this.source.actorId) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original source instance and actor may retry this execution target.')
      }
    })
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['execution-target-retry', this.instanceId, command.ticketId])).digest('hex')
    const claim = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; state?: 'pending' | 'done' }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The execution target command was reused for different work.')
        return { claimed: prior.state !== 'done', pending: prior.state !== 'done' }
      }
      await transaction.insert('work-command', key, { fingerprint, state: 'pending' })
      return { claimed: true, pending: false }
    })
    if (!claim.claimed) return this.execution.conversation(command.ticketId)
    const result = await this.execution.retryExecutionTarget(command.ticketId, { replay: claim.pending })
    await this.storage.transaction(this.instanceId, async transaction => {
      await transaction.replace('work-command', key, { fingerprint, state: 'done' })
    })
    return result
  }

  getReceipt(commandId: string): Promise<Receipt | undefined> {
    identifier(commandId, 'commandId')
    return this.storage.transaction(this.instanceId, async tx => (await tx.get<CommandRecord>('command', commandId))?.receipt)
  }

  /**
   * Explicitly acquires or renews the instance lease. Taking over another Host advances the epoch, then
   * reconciles every Assignment left by the previous runtime before new input is accepted.
   */
  async acquireHost() {
    const acquired = await this.host.acquireWithPrevious()
    if (!acquired.previous && !await this.storage.transaction(this.instanceId, transaction => this.hostTakeoverPending(transaction))) {
      return acquired.lease
    }
    if (!this.execution) {
      await this.completeTakeoverWithoutRuntime()
      return acquired.lease
    }
    await this.execution.takeOverHost({ epoch: acquired.lease.epoch,
      ...(acquired.previous ? { previousHostId: acquired.previous.hostId, previousEpoch: acquired.previous.epoch,
        previousToken: acquired.previous.token } : {}) })
    if (!this.processingPaused) {
      try { await this.recoverInterruptedHandoffs() }
      catch { /* A blocked handoff stays visible without holding ordinary Input recovery. */ }
      try { await this.execution.recoverInputs() }
      catch { /* The next start retries the durable Input scan. */ }
    }
    return acquired.lease
  }

  getHostLease() {
    return this.host.currentLease()
  }

  /** The durable reconciliation record for the current Host epoch, once a replacement has occurred. */
  async getHostTakeover(): Promise<HostTakeoverRecord | undefined> {
    const epoch = this.host.epoch() ?? (await this.host.currentLease())?.epoch
    if (!epoch) return undefined
    return this.storage.transaction(this.instanceId, transaction => loadHostTakeover(transaction, this.instanceId, epoch))
  }

  private async hostTakeoverPending(transaction: AsyncTx): Promise<boolean> {
    const epoch = this.host.epoch()
    if (!epoch) return false
    return (await loadHostTakeover(transaction, this.instanceId, epoch))?.state === 'pending'
  }

  private async assertHostAdmission() {
    await this.storage.transaction(this.instanceId, transaction => this.assertHostAdmissionIn(transaction))
  }

  /**
   * New work must be checked inside the transaction that would create it: a probe on its own connection would
   * turn a lost commit into a lost command identity instead of letting the original command reconcile.
   */
  private async assertHostAdmissionIn(transaction: AsyncTx) {
    await assertHostTakeoverSettled(transaction, this.instanceId, this.host.epoch())
  }

  setActivationGate(gate: ActivationGate | undefined) {
    this.activationGate = gate
    this.configureEffectsGate()
  }

  private configureEffectsGate() {
    this.effects.setGate({
      paused: async tx => (await tx.get<ProcessingState>('processing-state', this.processingKey()))?.paused === true
        || (this.activationGate ? !(await this.activationGate.active(tx)) : false),
      blocked: async tx => this.activationGate ? !(await this.activationGate.active(tx)) : false,
    })
  }

  private async assertActivationIn(transaction: AsyncTx) {
    if (!this.activationGate) return
    if (!await this.activationGate.active(transaction)) throw new CoreError('CORE_NOT_ACTIVE', 'Only the active core entry may write an acceptance or an Effect intent.')
  }

  private async assertActivationCurrent() {
    if (!this.activationGate) return
    await this.storage.transaction(this.instanceId, transaction => this.assertActivationIn(transaction))
  }

  private async completeTakeoverWithoutRuntime() {
    const epoch = this.host.epoch()
    if (!epoch) return
    const record = await this.storage.transaction(this.instanceId, transaction => loadHostTakeover(transaction, this.instanceId, epoch))
    if (!record || record.state === 'completed') return
    const tickets = await this.storage.transaction(this.instanceId, async transaction => {
      const blocked: HostTakeoverTicket[] = []
      let cursor: string | undefined
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await transaction.scan<Assignment>('assignment', { limit: 100, ...(cursor ? { after: cursor } : {}) })
        for (const item of page.items) {
          const assignment = item.value
          if (assignment.state === 'ended') continue
          const ended = { ...assignment, state: 'ended' as const }
          const historyKey = `${JSON.stringify(['assignment-history', assignment.ticketId])}:${assignment.id}`
          if (!await transaction.replace('assignment-history', historyKey, ended)) await transaction.insert('assignment-history', historyKey, ended)
          await transaction.replace('assignment', assignment.ticketId, ended)
          const ticket = await transaction.get<Work['ticket']>('ticket', assignment.ticketId)
          if (ticket && !ticket.constraint) {
            const intent = await transaction.get<Work['intent']>('intent', assignment.ticketId)
            if (intent) await transaction.replace('intent', assignment.ticketId, { ...intent, state: 'pending', reason: 'recovery-blocked' })
          }
          blocked.push({ ticketId: assignment.ticketId, outcome: 'blocked', previousAssignmentId: assignment.id,
            previousGeneration: assignment.generation, sessionId: assignment.sessionId,
            blockers: [{ code: 'takeover-failed', message: 'This Host has no native runtime; attach one and reconcile the Ticket before it continues.' }] })
        }
        if (!page.cursor) break
        cursor = page.cursor
        if (pageCount === 9) throw new CoreError('HOST_TAKEOVER_BUDGET', 'The Host takeover Assignment scan exceeded its 1000-record budget.')
      }
      return blocked
    })
    await this.storage.transaction(this.instanceId, transaction =>
      transaction.replace('host-takeover', record.id, { ...record, state: 'completed', completedAt: Date.now(), tickets }))
  }

  async getSessionHistory(sessionId: string, options: { limit?: number; after?: number } = {}) {
    if (!this.sessions) throw new CoreError('RUNTIME_NOT_ENABLED', 'Session history requires a configured native runtime.')
    return this.sessions.readSession(sessionId, options)
  }

  async openMain(request: MainAddress) {
    const binding = await this.main.open(request)
    if (this.sessions) this.sessions.routerSessionId = binding.routerSessionId
    return binding
  }
  sendMainMessage(request: MainSend) { return this.main.send(request) }
  async getMainConversation(request: MainAddress & { limit?: number; after?: number }) {
    const page = await this.main.page(request)
    return { ...page, works: this.workDelegation ? await this.workDelegation.list(page.mainId) : [] as MainWorkCard[] }
  }

  async getMainWorkPlan(request: MainAddress & { workBriefId: string }) {
    if (!this.workDelegation) throw new CoreError('DELEGATION_UNAVAILABLE', 'No authorized local workspace is configured.')
    if (request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This WorkBrief is outside the authorized Main Instance.')
    }
    const binding = await this.main.open({ instanceId: request.instanceId })
    return this.workDelegation.plan(binding.mainId, request.workBriefId)
  }
  async getRoleConfig(): Promise<RoleConfigView> {
    const config = await this.roleConfig.ensure()
    this.roleConfigRevision = config.revision
    this.applyRoleRoutes(config)
    return config
  }

  async updateRoleConfig(command: { commandId: string; expectedRevision: number; roles: RoleConfig }, options: { verify?: (roles: RoleConfig, signal: AbortSignal) => Promise<void> } = {}): Promise<RoleConfigView> {
    await this.getRoleConfig()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'roles'].includes(key))) throw new CoreError('INVALID_INPUT', 'A role configuration update accepts commandId, expectedRevision and roles only.')
    identifier(command.commandId, 'commandId')
    this.assertAuthoringActor()
    validateRoleConfig(command.roles)
    if (options.verify) {
      const controller = new AbortController()
      await options.verify(structuredClone(command.roles), controller.signal)
      controller.abort()
    }
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['role-config-v1', command.expectedRevision, command.roles])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string; revision: number }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The role configuration command was reused with different input.')
        return { revision: prior.revision, replayed: true }
      }
      const view = await this.roleConfig.write(transaction, command.expectedRevision, command.roles)
      await transaction.insert('work-command', commandKey, { fingerprint, revision: view.revision })
      return { revision: view.revision, replayed: false, view }
    })
    const view = 'view' in result ? result.view : await this.roleConfig.currentView()
    this.roleConfigRevision = view.revision
    this.applyRoleRoutes(view)
    return view
  }

  getRoleConfigUses(sessionId: string): Promise<RoleConfigUse[]> {
    return this.roleConfig.uses(sessionId)
  }

  async getIntakePolicy(): Promise<{ revision: number; policy: Omit<IntakePolicy, 'assess'>; processingPaused: boolean }> {
    await this.ensurePolicy()
    const stored = await this.storage.transaction(this.instanceId, transaction => transaction.get<StoredPolicy>('policy-state', this.policyKey()))
    if (!stored) throw new CoreError('INCOMPLETE_STATE', 'The current Policy snapshot is missing.')
    return { revision: stored.revision, policy: structuredClone(stored.configuration), processingPaused: this.processingPaused }
  }

  /** Bind one tracked P/R delivery condition to a Ticket; a ready report does not finish while it is open. */
  async bindDeliveryCondition(command: { commandId: string; ticketId: string; kind: 'pr'; sourceInstanceId: string; repo: string; number: number; basis: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'kind', 'sourceInstanceId', 'repo', 'number', 'basis'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Binding a delivery condition accepts commandId, ticketId, kind, sourceInstanceId, repo, number and basis only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId) && !this.source.intake?.allowedRequesterIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot bind a delivery condition.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['bind-delivery-condition-v1', command.ticketId, command.sourceInstanceId, command.repo, command.number, command.basis])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; conditionId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The delivery-condition command was reused for different input.')
        return tx.get<DeliveryCondition>('delivery-condition', existing.conditionId)
      }
      const work = await this.readWork(tx, command.ticketId)
      if (!work) throw new CoreError('NOT_FOUND', 'The delivery-condition Ticket does not exist.')
      if (work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The delivery-condition Ticket belongs to another source instance.')
      const condition = await this.deliveryState.bindCondition(tx, { ...command, createdBy: this.source.actorId, basis: command.basis })
      await tx.insert('work-command', commandKey, { fingerprint, conditionId: condition.id })
      return condition
    })
  }

  async getDeliveryConditions(ticketId: string): Promise<DeliveryCondition[]> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, tx => this.deliveryState.list(tx, ticketId))
  }

  /** Reconcile a P/R delivery condition from an already received source event. */
  async reconcileDeliveryCondition(command: { commandId: string; ticketId: string; sourceInstanceId: string; text: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'sourceInstanceId', 'text'].includes(key))) throw new CoreError('INVALID_INPUT', 'Reconciling accepts commandId, ticketId, sourceInstanceId and text only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile delivery conditions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['reconcile-delivery-condition-v1', command.ticketId, command.sourceInstanceId, command.text])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The reconcile command was reused for different input.')
        return this.deliveryState.list(tx, command.ticketId)
      }
      const conditions = await this.deliveryState.reconcileFromSource(tx, command.ticketId, { sourceInstanceId: command.sourceInstanceId, text: command.text })
      if (conditions && !conditions.some(condition => condition.state === 'open' || condition.state === 'draft')) {
        const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
        const result = await tx.get<Delivery>('delivery', `${command.ticketId}:result`)
        const delivered = result ? await this.deliveries.view(tx, result) : undefined
        const pendingInputs = await this.inputs.pendingInputsForTicket(tx, command.ticketId)
        // A resolved delivery condition ends a ready Ticket only after its result reached the channel.
        if (ticket?.state === 'open' && !ticket.constraint && delivered?.state === 'sent' && pendingInputs.length === 0) {
          await tx.replace('ticket', command.ticketId, { ...ticket, state: 'ended' })
        }
      }
      await tx.insert('work-command', commandKey, { fingerprint })
      return conditions
    })
  }

  /** Record an authorized result destination change, with its evidence, for one Ticket. */
  async setDeliveryTarget(command: { commandId: string; ticketId: string; purpose: 'result' | 'answer'; sourceInstanceId: string; threadId: string; objectId: string; evidence: string; evidenceEventId?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'purpose', 'sourceInstanceId', 'threadId', 'objectId', 'evidence', 'evidenceEventId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'A delivery-target change accepts commandId, ticketId, purpose, sourceInstanceId, threadId, objectId, evidence and optional evidenceEventId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds?.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only a trusted actor may change a delivery destination.')
    const commandKey = this.commandKey(command.commandId)
    if (command.evidenceEventId !== undefined) identifier(command.evidenceEventId, 'evidenceEventId')
    const fingerprint = createHash('sha256').update(canonicalJson(['delivery-target-v1', command.ticketId, command.purpose, command.sourceInstanceId, command.threadId, command.objectId, command.evidence, command.evidenceEventId ?? null])).digest('hex')
    const target = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The delivery-target command was reused for different input.')
        return this.deliveryState.target(tx, command.ticketId, command.purpose)
      }
      const work = await this.readWork(tx, command.ticketId)
      if (!work) throw new CoreError('NOT_FOUND', 'The delivery-target Ticket does not exist.')
      if (work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The delivery-target Ticket belongs to another source instance.')
      const foreign = command.sourceInstanceId !== work.trigger.source.sourceInstanceId
      const requiresEvidence = foreign || this.source.versionOrder !== undefined
      if (requiresEvidence && !command.evidenceEventId) {
        throw new CoreError('ASSOCIATION_REQUIRED', 'A result target change requires a current authorized native follow-up event.')
      }
      if (command.evidenceEventId) {
        const evidence = await tx.get<SourceEvent>('source-event', command.evidenceEventId)
        if (!evidence) throw new CoreError('INVALID_INPUT', 'The named delivery-target evidence event does not exist.')
        if (evidence.source.sourceInstanceId !== command.sourceInstanceId || evidence.threadId !== command.threadId || evidence.objectId !== command.objectId) {
          throw new CoreError('DESTINATION_MISMATCH', 'The evidence event does not belong to the named delivery target.')
        }
        if (!await isCurrentSourceEvent(tx, evidence)) throw new CoreError('SOURCE_NOT_CURRENT', 'The target follow-up is no longer current.')
        const evidencePolicy = await tx.get<StoredPolicy>('policy-state', JSON.stringify(['policy-state', evidence.source.sourceInstanceId]))
        if (evidencePolicy && !evidencePolicy.configuration.allowedRequesterIds.includes(evidence.authorId)) {
          throw new CoreError('ACTOR_NOT_ALLOWED', 'The target follow-up actor is no longer authorized.')
        }
        if (foreign) {
          const input = await associatedInput(tx, command.ticketId, evidence)
          if (!input || input.association?.ownerSourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('ASSOCIATION_REQUIRED', 'The external event has not been legally associated with this Ticket.')
        }
      }
      const target = await this.deliveryState.setTarget(tx, { ...command, authorizedBy: this.source.actorId })
      await tx.insert('work-command', commandKey, { fingerprint })
      return target
    })
    return target
  }

  async getDeliveryTarget(ticketId: string, purpose: 'result' | 'answer'): Promise<DeliveryTarget | undefined> {
    await this.ensurePolicy()
    identifier(ticketId, 'ticketId')
    await this.assertTicketReadable(ticketId)
    return this.storage.transaction(this.instanceId, tx => this.deliveryState.target(tx, ticketId, purpose))
  }

  async getProactiveRules(): Promise<{ revision: number; rules: ProactiveRule[] }> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading rules.')
    return this.proactive.rules()
  }

  async updateProactiveRules(command: { commandId: string; expectedRevision: number; rules: ProactiveRule[] }): Promise<{ revision: number; rules: ProactiveRule[] }> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before saving rules.')
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'rules'].includes(key))) throw new CoreError('INVALID_INPUT', 'A proactive rule update accepts commandId, expectedRevision and rules only.')
    identifier(command.commandId, 'commandId')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['proactive-rules-v1', command.expectedRevision, command.rules])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; revision: number }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The proactive rule command was reused with different input.')
        return { revision: prior.revision, replayed: true }
      }
      const rules = await this.proactive!.setRules(tx, command.expectedRevision, command.rules)
      await tx.insert('work-command', commandKey, { fingerprint, revision: rules.revision })
      return { revision: rules.revision, replayed: false }
    })
    return this.proactive.rules()
  }

  async evaluateProactive(candidate: ProactiveCandidate): Promise<ProactiveRun[]> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before evaluating candidates.')
    if (this.processingPaused) return []
    const verified = await this.storage.transaction(this.instanceId, async tx => {
      const event = await tx.get<SourceEvent>('source-event', candidate.eventId)
      if (!event || event.type === 'deleted' || event.text === undefined) return false
      if (event.source.sourceInstanceId !== candidate.sourceInstanceId || event.threadId !== candidate.threadId
        || event.objectId !== candidate.objectId || event.text !== candidate.text || event.authorId !== candidate.authorId
        || event.authorKind !== candidate.authorKind || event.addressing !== candidate.addressing) return false
      const current = await this.sourceEvents.candidate(tx, { threadId: candidate.threadId, objectId: candidate.objectId })
      return current?.id === candidate.eventId
    })
    if (!verified) throw new CoreError('SOURCE_NOT_CURRENT', 'A proactive candidate must be the current recorded source event.')
    return this.proactive.evaluate(candidate)
  }

  async listProactiveRuns(ruleId?: string): Promise<ProactiveRun[]> {
    if (!this.proactive) throw new CoreError('PROACTIVE_NOT_CONFIGURED', 'Configure a proactive root directory before reading runs.')
    return this.proactive.listRuns(ruleId)
  }

  async getSourceMembers(): Promise<MembershipSnapshot | undefined> {
    return this.membership.get()
  }

  async syncSourceMembers(command: { commandId: string; revision: number; members: SourceMember[]; origin: 'startup' | 'manual' }): Promise<MembershipSnapshot> {
    if (!command || Object.keys(command).some(key => !['commandId', 'revision', 'members', 'origin'].includes(key))) throw new CoreError('INVALID_INPUT', 'A member sync accepts commandId, revision, members and origin only.')
    identifier(command.commandId, 'commandId')
    if (command.origin !== 'startup' && command.origin !== 'manual') throw new CoreError('INVALID_INPUT', 'A member sync origin is startup or manual.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['membership-sync-v1', command.revision, command.origin, command.members])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The member-sync command was reused with different input.')
        const snapshot = await tx.get<MembershipSnapshot>('source-members', JSON.stringify(['source-members', this.source.sourceInstanceId]))
        if (!snapshot) throw new CoreError('INCOMPLETE_STATE', 'The member snapshot is missing.')
        return snapshot
      }
      await this.membership.sync(tx, command)
      const snapshot = await tx.get<MembershipSnapshot>('source-members', JSON.stringify(['source-members', this.source.sourceInstanceId]))
      if (!snapshot) throw new CoreError('INCOMPLETE_STATE', 'The member snapshot was not stored.')
      await tx.insert('work-command', commandKey, { fingerprint, revision: snapshot.revision })
      return snapshot
    })
  }

  async getSupervision(options: { includeHistory?: boolean } = {}) {
    const tickets = await this.listTickets()
    const proposedSupervision = (await listSupervisorProposals(this.storage, this.instanceId)).filter(proposal => proposal.status === 'proposed')
    const proposalsByTicket = new Map<string, SupervisorProposal[]>()
    for (const proposal of proposedSupervision) proposalsByTicket.set(proposal.ticketId, [...(proposalsByTicket.get(proposal.ticketId) ?? []), proposal])
    const items = [] as Record<string, unknown>[]
    const counts = { needsHuman: 0, blocked: 0, stopped: 0, ready: 0, running: 0, ended: 0, pending: 0 }
    for (const work of tickets.items) {
      const conversation = this.execution ? await this.execution.conversation(work.ticket.id) : undefined
      const unknownEffects = (await this.effects.listByScope(work.ticket.id)).filter(effect => effect.state === 'unknown')
      const unknownJobs = (conversation?.jobs ?? []).filter(job => job.state === 'unknown')
      const waiting = conversation?.attention?.status === 'waiting'
      const stop = conversation?.stop
      const setup = conversation?.setup
      let bucket: keyof typeof counts = 'pending'
      let priority = 8
      let nextAction = 'Review the accepted request and wait for a Worker assignment.'
      if (waiting) { bucket = 'needsHuman'; priority = 0; nextAction = 'Answer the current question. Other Tickets can continue while this one waits.' }
      else if (unknownEffects.length || unknownJobs.length) {
        bucket = 'blocked'; priority = 1
        nextAction = 'Reconcile the affected external action or job by its original ID before retrying; unrelated work can continue.'
      } else if (setup?.state === 'failed') { bucket = 'blocked'; priority = 2; nextAction = 'Recheck the original working directory and retry setup.' }
      else if (stop?.state === 'stopping') {
        bucket = 'stopped'; priority = 3; nextAction = 'Wait for confirmed cancellation of the original execution range; resume is blocked.'
      } else if (stop) { bucket = 'stopped'; priority = 4; nextAction = 'The Ticket is stopped. Resume only with an explicit authorized command after cancellation is confirmed.' }
      else if (conversation?.status === 'ready') { bucket = 'ready'; priority = 5; nextAction = 'Review the current report and its evidence.' }
      else if (conversation?.status === 'running' || conversation?.status === 'pending') {
        bucket = conversation.status === 'running' ? 'running' : 'pending'
        priority = conversation.status === 'running' ? 6 : 8
        nextAction = conversation.status === 'running' ? 'Inspect the active Assignment or wait for its next evidence event.' : 'The Ticket is queued; inspect its slot and intent reason.'
      } else if (work.ticket.state === 'ended') { bucket = 'ended'; priority = 7; nextAction = 'The Ticket is closed. An authorized human follow-up can reopen it.' }
      if (bucket in counts) counts[bucket]++
      items.push({ ticketId: work.ticket.id, request: work.trigger.text, bucket, priority,
        state: conversation?.status ?? work.intent.state, reason: conversation?.reason ?? work.intent.reason,
        lifecycle: work.ticket.state, nextAction,
        why: { triggerId: work.trigger.id, decisionId: work.decision.id, mandateId: work.mandate.id,
          ...(conversation?.assignments[0] ? { assignmentId: conversation.assignments[0].id, generation: conversation.assignments[0].generation } : {}),
          ...(conversation?.reports[0] ? { reportId: conversation.reports[0].id } : {}),
          ...(conversation?.attention ? { attentionId: conversation.attention.id } : {}),
          ...(conversation?.stop ? { stopId: conversation.stop.id } : {}) },
        health: { source: 'nominal', effectsUnknown: unknownEffects.length, jobsUnknown: unknownJobs.length,
          ...(setup ? { setup: setup.state } : {}), ...(conversation?.slot ? { slot: conversation.slot } : {}),
          attention: conversation?.attention?.status ?? 'none', stop: conversation?.stop?.state ?? 'none' },
        ...(conversation?.attention ? { attention: conversation.attention } : {}),
        ...(conversation?.stop ? { stop: conversation.stop } : {}),
        ...(setup ? { setup } : {}),
        ...(conversation?.assignments[0] ? { assignment: conversation.assignments[0] } : {}),
        messages: conversation?.messages ?? [],
        reports: conversation?.reports ?? [],
        ...(options.includeHistory ? { attentionHistory: conversation?.attentionHistory ?? [], reportHistory: conversation?.reportHistory ?? [] } : {}),
        ...(proposalsByTicket.has(work.ticket.id) ? { supervisorProposals: proposalsByTicket.get(work.ticket.id) } : {}),
        jobs: conversation?.jobs ?? [], subagents: conversation?.subagents ?? [] })
    }
    items.sort((left, right) => Number(left.priority) - Number(right.priority) || String(left.ticketId).localeCompare(String(right.ticketId)))
    return { items, counts, hasMore: tickets.hasMore, roleConfigRevision: this.roleConfigRevision, processingPaused: this.processingPaused }
  }

  private applyRoleRoutes(config: RoleConfigView) {
    if (config.roles.main) this.sessions?.setMainProfile(config.roles.main)
    this.sessions?.setRoutes(config.roles.router.model, config.roles.worker.model)
    this.sessions?.setRoleInstructions(config.roles.router, config.roles.worker)
  }

  getTicket(ticketId: string): Promise<Work | undefined> {
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async tx => {
      await this.assertTicketReadableIn(tx, ticketId)
      return this.readWork(tx, ticketId)
    })
  }

  getInstanceId() { return this.instanceId }

  /** Client access shares this Engine's Host-fenced storage and Instance identity. */
  createClientAccess(now: () => number = Date.now) { return ClientAccess.forEngine(this, this.storage, this.instanceId, now) }

  /** The semantic supervisor reads the same Host-fenced facts and only writes proposals; decisions run separately. */
  createSupervisor(options: Omit<SupervisorOptions, 'engine' | 'storage' | 'instanceId' | 'actorId'> = {}) {
    const { assess, stallMs, stallObservations, loopObservations, proposalWindowMs, maxProposals, historyLimit, version, now } = options
    return new Supervisor({
      engine: this, storage: this.storage, instanceId: this.instanceId, actorId: this.source.actorId,
      ...(assess === undefined ? {} : { assess }), ...(stallMs === undefined ? {} : { stallMs }),
      ...(stallObservations === undefined ? {} : { stallObservations }), ...(loopObservations === undefined ? {} : { loopObservations }),
      ...(proposalWindowMs === undefined ? {} : { proposalWindowMs }), ...(maxProposals === undefined ? {} : { maxProposals }),
      ...(historyLimit === undefined ? {} : { historyLimit }), version: version ?? `supervisor-r${String(this.roleConfigRevision)}`,
      ...(now === undefined ? {} : { now }),
    })
  }

  getSupervisorProposals(ticketId?: string) { return listSupervisorProposals(this.storage, this.instanceId, ticketId) }

  getSupervisorState(ticketId: string) { return this.createSupervisor().getState(ticketId) }

  async getTicketDirection(ticketId: string): Promise<TicketDirection | undefined> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    return this.inputs.direction(ticketId)
  }

  /** Stops every managed background process range and releases this Host's lease. */
  async shutdown() {
    try { await this.main.close(); await this.execution?.shutdown() }
    finally { await this.host.release().catch(() => {}) }
  }

  async listSlots(): Promise<SlotSnapshot> {
    await this.ensurePolicy()
    if (!this.slots) throw new CoreError('WORKER_NOT_ENABLED', 'Slot budgets require a configured native runtime.')
    return this.slots.list()
  }

  /** Background jobs of one Ticket: start facts, confirmed exit and bounded retained output. */
  async listJobs(ticketId: string): Promise<JobView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    return this.execution.listJobs(ticketId)
  }

  /** Subtasks one Ticket delegated, with their state and bounded result. */
  async listSubagents(ticketId: string): Promise<SubagentView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    return this.execution.listSubagents(ticketId)
  }

  async getSubagent(ticketId: string, subagentId: string) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Subagents require a configured native runtime.')
    return this.execution.getSubagent(ticketId, subagentId)
  }

  async cancelSubagent(command: { commandId: string; ticketId: string; subagentId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a subagent requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'subagentId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a subagent accepts commandId, ticketId, subagentId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.subagentId, 'subagentId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a subagent.')
    return this.execution.cancelSubagent({ ...command, actorId: this.source.actorId })
  }

  async getJob(ticketId: string, jobId: string): Promise<JobView> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Background jobs require a configured native runtime.')
    return this.execution.getJob(ticketId, jobId)
  }

  async listPreviews(ticketId: string): Promise<PreviewView[]> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.execution.listPreviews(ticketId)
  }

  async getPreview(ticketId: string, previewId: string): Promise<PreviewView> {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Previews require a configured native runtime.')
    return this.execution.getPreview(ticketId, previewId)
  }

  async cancelPreview(command: { commandId: string; ticketId: string; previewId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a preview requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'previewId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a preview accepts commandId, ticketId, previewId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a preview.')
    return this.execution.cancelPreview({ ...command, actorId: this.source.actorId })
  }

  async resolvePreview(command: { commandId: string; ticketId: string; previewId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Resolving a preview requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'previewId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Resolving a preview accepts commandId, ticketId, previewId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.previewId, 'previewId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot resolve a preview.')
    return this.execution.resolvePreview({ ...command, actorId: this.source.actorId })
  }

  async cancelJob(command: { commandId: string; ticketId: string; jobId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Cancelling a background job requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'jobId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Cancelling a background job accepts commandId, ticketId, jobId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.jobId, 'jobId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot cancel a background job.')
    return this.execution.cancelJob({ ...command, actorId: this.source.actorId })
  }

  /**
   * Asks a Worker that is merely idle (no ready report, no question, no stop) to state its status.
   * It is a bounded command: it only queues for an idle Ticket, and it never clears a stop or a waiting question.
   */
  async requestStatus(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Requesting status requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'A status request accepts commandId and ticketId only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot request status.')
    return this.execution.requestStatus({ ...command, actorId: this.source.actorId })
  }

  async getTicketAttention(ticketId: string) {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, async tx => {
      const current = await this.attentions.current(tx, ticketId)
      const history = await this.attentions.history(tx, ticketId)
      return { current, history }
    })
  }

  async getTicketDeliveries(ticketId: string): Promise<DeliveryView[]> {
    await this.ensurePolicy()
    await this.assertTicketReadable(ticketId)
    identifier(ticketId, 'ticketId')
    return this.storage.transaction(this.instanceId, tx => this.deliveries.list(tx, ticketId))
  }

  async readContext(request: ContextRequest): Promise<ContextCard> {
    await this.storage.transaction(this.instanceId, async tx => {
      const trigger = await this.triggerFor(tx, request.ticketId)
      if (!this.canReadTicket(trigger)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source reference does not grant access to private Ticket context.')
      }
      if (request.ref?.kind === 'source-event' && request.ref.id) {
        const event = await tx.get<SourceEvent>('source-event', request.ref.id)
        if (event && event.source.sourceInstanceId !== trigger.source.sourceInstanceId) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Cross-source event ownership supplies its Input only; it does not grant Thread history access.')
        }
      }
    })
    return this.context.read(request)
  }

  async findContextCandidates(ticketId: string, text: string, limit?: number): Promise<ContextCandidate[]> {
    const source = await this.storage.transaction(this.instanceId, async tx => {
      const trigger = await this.triggerFor(tx, ticketId)
      if (!this.canReadTicket(trigger)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source reference does not grant private context search.')
      }
      return trigger.source
    })
    const candidates = await this.context.candidates(ticketId, text, limit)
    return this.storage.transaction(this.instanceId, async tx => {
      const permitted: ContextCandidate[] = []
      for (const candidate of candidates) {
        const event = candidate.ref.id ? await tx.get<SourceEvent>('source-event', candidate.ref.id) : undefined
        if (event?.source.sourceInstanceId === source.sourceInstanceId && event.source.kind === source.kind) permitted.push(candidate)
      }
      return permitted
    })
  }

  /** Queues an answer only when it names a current human question and an explicit Worker fact. */
  async queueAnswer(command: { commandId: string; ticketId: string; questionEventId: string; text: string; fact: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'questionEventId', 'text', 'fact'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'An answer accepts commandId, ticketId, questionEventId, text and fact only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.questionEventId, 'questionEventId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) throw new CoreError('INVALID_INPUT', 'An answer needs bounded nonempty text.')
    if (typeof command.fact !== 'string' || !command.fact.trim() || Buffer.byteLength(command.fact) > 4096) throw new CoreError('INVALID_INPUT', 'An answer needs an explicit bounded fact.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot answer a source question.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['answer-v1', this.source.sourceInstanceId, this.source.actorId,
      command.ticketId, command.questionEventId, command.text, command.fact])).digest('hex')
    const deliveryId = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; deliveryId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The answer command was reused for different input.')
        return existing.deliveryId
      }
      const question = await tx.get<SourceEvent>('source-event', command.questionEventId)
      if (!question) throw new CoreError('NOT_FOUND', 'The named question does not exist.')
      const association = await associatedInput(tx, command.ticketId, question)
      const foreign = !this.sourceEvents.belongsToSource(question)
      if (foreign) await this.associationOwner(tx, command.ticketId)
      if ((foreign && !association || question.authorKind !== 'human')) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'An answer must name a trusted human question or an exact owner-authorized input.')
      if (!await isCurrentSourceEvent(tx, question)) throw new CoreError('SOURCE_NOT_CURRENT', 'The named question is no longer current.')
      const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
      const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
      if (!ticket || !trigger) throw new CoreError('NOT_FOUND', 'The answer Ticket does not exist.')
      if (!association && (trigger.source.sourceInstanceId !== question.source.sourceInstanceId || question.threadId !== trigger.threadId)) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The question is outside this Ticket’s reachable source scope.')
      }
      const id = `${command.ticketId}:answer:${createHash('sha256').update(question.id).digest('hex')}`
      const destination = { sourceInstanceId: question.source.sourceInstanceId, actorId: question.authorId,
        eventId: question.objectId, ...(question.threadId ? { threadId: question.threadId } : {}) }
      const effect = await this.effects.enqueue(tx, { key: `answer:${question.id}`, stream: 'outbox', scope: command.ticketId,
        payload: { purpose: 'answer', ticketId: command.ticketId, deliveryId: id } })
      await this.deliveries.record(tx, { id, ticketId: command.ticketId, purpose: 'answer', text: command.text, destination,
        basis: { kind: 'human-question', questionEventId: question.id, questionText: question.text ?? '', fact: command.fact },
        effectId: effect.id, effectGeneration: effect.generation }, effect)
      await tx.insert('work-command', commandKey, { fingerprint, deliveryId: id })
      return id
    })
    const delivery = await this.storage.transaction(this.instanceId, tx => this.deliveries.get(tx, deliveryId))
    if (!delivery) throw new CoreError('INCOMPLETE_STATE', 'The queued answer is missing its delivery record.')
    return this.storage.transaction(this.instanceId, tx => this.deliveries.view(tx, delivery))
  }

  async answerAttention(command: { commandId: string; attentionId: string; text: string; sourceEventId?: string }, receiver?: Engine) {
    await this.ensurePolicy()
    if (receiver) {
      if (!(receiver instanceof Engine) || receiver.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The answer receiver must be a trusted Engine in this Instance.')
      await receiver.ensurePolicy()
    }
    if (!command || Object.keys(command).some(key => !['commandId', 'attentionId', 'text', 'sourceEventId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Answering Attention accepts commandId, attentionId, text and sourceEventId only.')
    identifier(command.commandId, 'commandId'); identifier(command.attentionId, 'attentionId')
    if (command.sourceEventId !== undefined) identifier(command.sourceEventId, 'sourceEventId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65536) throw new CoreError('INVALID_INPUT', 'An Attention answer needs bounded nonempty text.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['attention-answer-v2', this.source.sourceInstanceId, this.source.actorId,
      command.attentionId, command.text, command.sourceEventId ?? null, ...(receiver ? [receiver.source.sourceInstanceId, receiver.source.actorId] : [])])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; attentionId: string; inputId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Attention answer command was reused for different input.')
        const answered = await tx.get<Attention>('attention', existing.attentionId)
        const input = await this.inputs.getInput(tx, existing.inputId)
        if (!answered || !input) throw new CoreError('INCOMPLETE_STATE', 'The answered Attention is missing its Input.')
        return { attention: answered, input }
      }
      await this.assertHostAdmissionIn(tx)
      const attention = await tx.get<Attention>('attention', command.attentionId)
      if (!attention) throw new CoreError('NOT_FOUND', 'The Attention does not exist.')
      const foreign = attention.destination.sourceInstanceId !== this.source.sourceInstanceId
      let crossQuestionInput: WorkInput | undefined
      if (foreign) {
        await this.associationOwner(tx, attention.ticketId)
        const question = attention.questionSourceEventId ? await tx.get<SourceEvent>('source-event', attention.questionSourceEventId) : undefined
        const input = question ? await associatedInput(tx, attention.ticketId, question) : undefined
        if (!input || !question || input.association?.ownerSourceInstanceId !== this.source.sourceInstanceId
          || attention.destination.sourceInstanceId !== question.source.sourceInstanceId || attention.destination.actorId !== question.authorId
          || attention.destination.threadId !== question.threadId || attention.destination.eventId !== question.objectId) {
          throw new CoreError('SOURCE_NOT_AUTHORIZED', 'A cross-source Attention answer needs its exact owner-authorized question provenance.')
        }
        crossQuestionInput = input
      }
      const ticket = await tx.get<Work['ticket']>('ticket', attention.ticketId)
      const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
      if (!ticket || !trigger || trigger.source.sourceInstanceId !== this.source.sourceInstanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The Attention Ticket belongs to a different source instance.')
      const answerers = this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
      let actorId = this.source.actorId
      let answerText = command.text
      if (command.sourceEventId) {
        const inputSource = receiver ?? this
        const policy = await tx.get<StoredPolicy>('policy-state', inputSource.policyKey())
        if (!receiver && !foreign) {
          const candidate = await tx.get<SourceEvent>('source-event', command.sourceEventId)
          if (candidate && !answerers.includes(candidate.authorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This source actor cannot answer work questions.')
        }
        const event = await inputSource.sourceEvents.associationCandidate(tx, command.sourceEventId,
          policy?.configuration.allowedRequesterIds ?? inputSource.source.intake?.allowedRequesterIds ?? inputSource.source.allowedActorIds)
        if (event.source.sourceInstanceId !== attention.destination.sourceInstanceId || event.threadId !== attention.destination.threadId) throw new CoreError('ANSWER_THREAD_MISMATCH', 'The answer event is outside the question source and Thread.')
        if (event.authorId !== attention.destination.actorId) throw new CoreError('ANSWER_ACTOR_MISMATCH', 'The native answer must come from the actual question recipient.')
        actorId = event.authorId
        answerText = event.text!
      }
      if (!command.sourceEventId && !answerers.includes(actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot answer work questions.')
      if (!foreign && actorId !== attention.destination.actorId) throw new CoreError('ANSWER_ACTOR_MISMATCH', 'The current actor does not match the question recipient.')
      const result = await this.attentions.answer(tx, { ticketId: attention.ticketId, attentionId: attention.id, text: answerText,
        commandId: command.commandId, actorId, ...(command.sourceEventId ? { sourceEventId: command.sourceEventId } : {}) })
      if (command.sourceEventId && crossQuestionInput?.association) {
        result.input = { ...result.input, association: { ...crossQuestionInput.association, sourceActorId: actorId,
          reason: `Authorized native answer to ${attention.id}`, checkedAt: Date.now() } }
        await tx.replace('work-input', result.input.id, result.input)
      }
      await tx.insert('work-command', commandKey, { fingerprint, attentionId: result.attention.id, inputId: result.input.id })
      return result
    })
  }

  async stopTicket(command: { commandId: string; ticketId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Stopping work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Stopping work accepts commandId, ticketId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Stopping work needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot stop work.')
    return this.execution.stopTicket({ ...command, actorId: this.source.actorId })
  }

  /** Inspects and cancels a remote stop's original jobs; confirms only ranges the device reports quiet. */
  async reconcileStop(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Reconciling a stop requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Reconciling a stop accepts commandId and ticketId only.')
    }
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile a stop.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['reconcile-stop', this.instanceId, command.ticketId])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The reconcile command was reused for different work.')
        return
      }
      await transaction.insert('work-command', key, { fingerprint })
    })
    return this.execution.reconcileRemoteStop(command.ticketId)
  }

  /** Reconciles persisted remote jobs by their original device identity, optionally for one Ticket. */
  async reconcileRemoteWork(command: { commandId: string; ticketId?: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Reconciling remote work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Reconciling remote work accepts commandId and an optional ticketId only.')
    }
    identifier(command.commandId, 'commandId')
    if (command.ticketId !== undefined) identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This actor cannot reconcile remote work.')
    }
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(JSON.stringify(['reconcile-remote-work', this.instanceId, command.ticketId ?? null])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<{ fingerprint: string }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The remote reconciliation command was reused for different work.')
        return
      }
      await transaction.insert('work-command', key, { fingerprint })
    })
    return this.execution.reconcileRemoteWork(command.ticketId)
  }

  async resumeTicket(command: { commandId: string; ticketId: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Resuming work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Resuming work accepts commandId and ticketId only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot resume work.')
    return this.execution.resumeTicket({ ...command, actorId: this.source.actorId })
  }

  async retryTicket(command: { commandId: string; ticketId: string; reason: string }) {
    await this.ensurePolicy()
    if (!this.execution) throw new CoreError('WORKER_NOT_ENABLED', 'Retrying work requires a configured native runtime.')
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Retrying work accepts commandId, ticketId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Retrying work needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot retry work.')
    return this.execution.retryTicket({ ...command, actorId: this.source.actorId })
  }

  async updateIntakePolicy(command: { commandId: string; expectedRevision: number; policy: IntakePolicy; origin?: 'manual' | 'sync'; sourceRevision?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'expectedRevision', 'policy', 'origin', 'sourceRevision'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Policy update accepts commandId, expectedRevision, policy, origin and sourceRevision only.')
    if (command.origin !== 'sync') this.assertAuthoringActor()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Configure an Intake Policy before changing it.')
    identifier(command.commandId, 'commandId')
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) throw new CoreError('INVALID_INPUT', 'Policy expectedRevision must be a positive integer.')
    if (command.origin !== undefined && command.origin !== 'manual' && command.origin !== 'sync') throw new CoreError('INVALID_INPUT', 'Policy origin is manual or sync.')
    if (command.origin === 'sync' && (typeof command.sourceRevision !== 'string' || !command.sourceRevision.trim() || Buffer.byteLength(command.sourceRevision) > 512)) throw new CoreError('INVALID_INPUT', 'A synchronised Policy update needs a bounded sourceRevision.')
    const assessor = command.policy.assess ?? this.defaultAssessor
    const { assess: _providedAssess, ...commandConfiguration } = command.policy
    const configurationSnapshot = structuredClone(commandConfiguration)
    const policy: IntakePolicy = assessor ? { ...configurationSnapshot, assess: assessor } : configurationSnapshot
    validateIntakePolicy(policy)
    const { assess: _assess, ...configuration } = policy
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['policy-update-v1', command.expectedRevision, command.origin ?? 'manual', command.sourceRevision ?? null, configuration])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; revision: number }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The Policy command was reused with different input.')
        return { revision: prior.revision, replayed: true }
      }
      const current = await tx.get<StoredPolicy>('policy-state', this.policyKey())
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The current Policy snapshot is missing.')
      if (current.revision !== command.expectedRevision) throw new CoreError('POLICY_REVISION_CONFLICT', 'The Policy changed after this update was prepared.')
      if (command.origin === 'sync' && current.sourceRevision === command.sourceRevision) throw new CoreError('STALE_POLICY_SYNC', 'This member-sync revision was already applied.')
      const nextRevision = current.revision + 1
      const stored: StoredPolicy = { revision: nextRevision, configuration, origin: command.origin ?? 'manual',
        ...(command.sourceRevision ? { sourceRevision: command.sourceRevision } : {}), updatedAt: Date.now() }
      await tx.replace('policy-state', this.policyKey(), stored)
      await tx.insert('policy-history', `${JSON.stringify(['policy-history', this.source.sourceInstanceId])}:${nextRevision}`, stored)
      const interrupted = await this.evaluations!.invalidateForPolicyChange(tx, 'POLICY_CHANGED')
      const affectedTicketIds = new Set<string>()
      for (const evaluation of interrupted) {
        const requeue: StoredPolicyNotice = { key: `${JSON.stringify(['policy-reevaluation', this.source.sourceInstanceId])}:${evaluation.evaluationId}`,
          ticketId: evaluation.evaluationId, revision: nextRevision, reason: 'POLICY_CHANGED' }
        await tx.insert('policy-reevaluation', requeue.key, requeue)
        for (const eventId of evaluation.candidateEventIds) {
          for (const ownership of await this.inputs.ownershipsForEventInTransaction(tx, eventId)) {
            if (ownership.state === 'owned') affectedTicketIds.add(ownership.ticketId)
          }
        }
      }
      let ticketCursor: string | undefined
      let liveTickets = 0
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const page = await tx.scan<Work['ticket']>('ticket', { limit: 100, ...(ticketCursor ? { after: ticketCursor } : {}) })
        for (const item of page.items) {
          const trigger = await tx.get<Work['trigger']>('trigger', item.value.triggerId)
          if (item.value.state !== 'open' || trigger?.source.sourceInstanceId !== this.source.sourceInstanceId || !affectedTicketIds.has(item.value.id)) continue
          liveTickets++
          if (liveTickets > 1000) throw new CoreError('POLICY_NOTICE_LIMIT', 'Too many live Tickets require a Policy notification.')
          await this.effects.enqueue(tx, { key: `policy:${item.value.id}:${nextRevision}`, stream: 'outbox', scope: item.value.id,
            payload: { purpose: 'policy', ticketId: item.value.id, revision: nextRevision } })
        }
        if (!page.cursor) break
        ticketCursor = page.cursor
        if (pageCount === 9) {
          const confirmation = await tx.scan<Work['ticket']>('ticket', { limit: 1, after: ticketCursor })
          if (!confirmation.items[0]) break
          throw new CoreError('POLICY_NOTICE_LIMIT', 'The live Ticket scan exceeded its 1000-record budget.')
        }
      }
      await tx.insert('work-command', commandKey, { fingerprint, revision: nextRevision })
      return { revision: nextRevision, replayed: false }
    })
    if (outcome.replayed) {
      const current = await this.storage.transaction(this.instanceId, tx => tx.get<StoredPolicy>('policy-state', this.policyKey()))
      return { revision: current?.revision ?? outcome.revision, policy: current ? structuredClone(current.configuration) : { ...configuration }, processingPaused: this.processingPaused }
    }
    this.applyPolicy(policy, outcome.revision)
    void this.drainPolicyReevaluations().catch(() => {})
    return { revision: outcome.revision, policy: { ...configuration }, processingPaused: this.processingPaused }
  }

  /**
   * A trusted maintainer instruction is interpreted into one constrained roles or policy change,
   * then applied with the same revision CAS as the settings surface. A conflict keeps a draft.
   */
  async updateBehaviorFromInstruction(
    command: { commandId: string; instruction: string; expectedRoleRevision?: number; expectedPolicyRevision?: number; signal?: AbortSignal },
    interpreter: BehaviorInterpreter,
  ): Promise<BehaviorInstructionRecord> {
    await this.ensurePolicy()
    this.assertAuthoringActor()
    if (!command || Object.keys(command).some(key => !['commandId', 'instruction', 'expectedRoleRevision', 'expectedPolicyRevision', 'signal'].includes(key))) throw new CoreError('INVALID_INPUT', 'A behavior instruction accepts commandId, instruction, expected revisions and a signal only.')
    identifier(command.commandId, 'commandId')
    if (typeof command.instruction !== 'string' || !command.instruction.trim() || Buffer.byteLength(command.instruction) > 16_384) throw new CoreError('INVALID_INPUT', 'A behavior instruction is bounded and nonempty.')
    for (const value of [command.expectedRoleRevision, command.expectedPolicyRevision]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new CoreError('INVALID_INPUT', 'Expected revisions are positive integers.')
    }
    if (typeof interpreter !== 'function') throw new CoreError('INVALID_CONFIG', 'A behavior interpreter is required.')
    if (command.signal !== undefined && (typeof command.signal !== 'object' || typeof command.signal.aborted !== 'boolean')) throw new CoreError('INVALID_INPUT', 'The behavior instruction signal is invalid.')
    const fingerprint = createHash('sha256').update(canonicalJson(['behavior-instruction-v1', this.instanceId, this.source.actorId,
      command.instruction, command.expectedRoleRevision ?? null, command.expectedPolicyRevision ?? null])).digest('hex')
    const key = instructionKey(command.commandId)
    const now = Date.now()
    const leaseUntil = now + 120_000
    const claimed = await commandTransaction(this.storage, this.instanceId, async transaction => {
      const prior = await transaction.get<BehaviorInstructionRecord>('behavior-instruction', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The behavior instruction command was reused with different input.')
        if (prior.status !== 'interpreting' && prior.status !== 'applying') return prior
        if ((prior.leaseUntil ?? 0) > now) throw new CoreError('INSTRUCTION_IN_PROGRESS', 'Another interpreter is still working on this instruction.')
        const renewed: BehaviorInstructionRecord = { ...prior, leaseUntil, updatedAt: now }
        await transaction.replace('behavior-instruction', key, renewed)
        return renewed
      }
      const next: BehaviorInstructionRecord = {
        id: randomUUID(), instanceId: this.instanceId, commandId: command.commandId, actorId: this.source.actorId,
        instruction: command.instruction, fingerprint, status: 'interpreting', leaseUntil, createdAt: now, updatedAt: now,
        ...(command.expectedRoleRevision === undefined ? {} : { expectedRoleRevision: command.expectedRoleRevision }),
        ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
      }
      await transaction.insert('behavior-instruction', key, next)
      return next
    })
    if (claimed.status !== 'interpreting' && claimed.status !== 'applying') return claimed
    const currentRoles = await this.getRoleConfig()
    const currentPolicy = this.evaluations === undefined ? undefined : await this.getIntakePolicy()
    let change = claimed.change
    if (change === undefined) {
      try {
        change = validateBehaviorChange(await interpreter({
          instruction: command.instruction, roles: currentRoles, ...(currentPolicy === undefined ? {} : { policy: currentPolicy.policy }), signal: command.signal ?? new AbortController().signal,
        }))
      } catch (error) {
        return this.finishBehaviorInstruction({ status: 'failed', error: error instanceof Error ? error.message : String(error) }, key)
      }
      const prepared = await this.prepareBehaviorInstruction(claimed, change, key)
      if (prepared.status !== 'applying') return prepared
      change = prepared.change
    }
    const appliedChange = change!
    const fresh = claimed.change === undefined
    const metadata = { change: appliedChange, summary: appliedChange.summary,
      ...(appliedChange.interpreterVersion === undefined ? {} : { interpreterVersion: appliedChange.interpreterVersion }),
      ...(appliedChange.model === undefined ? {} : { model: appliedChange.model }) }
    try {
      if (appliedChange.target === 'roles') {
        if (fresh && (appliedChange.roles!.router.name !== currentRoles.roles.router.name || appliedChange.roles!.worker.name !== currentRoles.roles.worker.name
          || JSON.stringify(appliedChange.roles!.router.model) !== JSON.stringify(currentRoles.roles.router.model)
          || JSON.stringify(appliedChange.roles!.worker.model) !== JSON.stringify(currentRoles.roles.worker.model))) {
          throw new CoreError('INVALID_CONFIG', 'A behavior instruction cannot change role names or model routes.')
        }
        const expected = command.expectedRoleRevision ?? claimed.expectedRoleRevision
        if (expected === undefined) throw new CoreError('INVALID_INPUT', 'A roles instruction needs expectedRoleRevision.')
        const view = await this.updateRoleConfig({ commandId: `${command.commandId}:roles`, expectedRevision: expected, roles: appliedChange.roles! })
        return this.finishBehaviorInstruction({ ...metadata, status: 'applied', effectiveRoleRevision: view.revision }, key)
      }
      const expected = command.expectedPolicyRevision ?? claimed.expectedPolicyRevision
      if (expected === undefined) throw new CoreError('INVALID_INPUT', 'A policy instruction needs expectedPolicyRevision.')
      const latest = await this.getIntakePolicy()
      const policy = { ...latest.policy, ...appliedChange.policy!, allowedRequesterIds: latest.policy.allowedRequesterIds,
        allowedBotActorIds: latest.policy.allowedBotActorIds,
        ...(latest.policy.selfActorIds === undefined ? {} : { selfActorIds: latest.policy.selfActorIds }) }
      const view = await this.updateIntakePolicy({ commandId: `${command.commandId}:policy`, expectedRevision: expected, policy })
      return this.finishBehaviorInstruction({ ...metadata, status: 'applied', effectivePolicyRevision: view.revision }, key)
    } catch (error) {
      if (error instanceof CoreError && (error.code === 'CONFIG_REVISION_CONFLICT' || error.code === 'POLICY_REVISION_CONFLICT')) {
        const roles = await this.getRoleConfig()
        const policy = this.evaluations === undefined ? undefined : await this.getIntakePolicy()
        const draft: ConfigDraft = {
          id: claimed.id, instanceId: this.instanceId, instructionId: claimed.id, commandId: command.commandId, actorId: this.source.actorId,
          instruction: command.instruction, change: appliedChange, currentRoleRevision: roles.revision, ...(policy === undefined ? {} : { currentPolicyRevision: policy.revision }),
          status: 'conflict', createdAt: Date.now(),
          ...(command.expectedRoleRevision === undefined ? {} : { expectedRoleRevision: command.expectedRoleRevision }),
          ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
        }
        await this.storage.transaction(this.instanceId, async transaction => {
          if (!await transaction.replace('config-draft', draftKey(draft.id), draft)) await transaction.insert('config-draft', draftKey(draft.id), draft)
        })
        return this.finishBehaviorInstruction({ ...metadata, status: 'conflict', draftId: draft.id, error: error.message }, key)
      }
      return this.finishBehaviorInstruction({ ...metadata, status: 'failed', error: error instanceof Error ? error.message : String(error) }, key)
    }
  }

  private async prepareBehaviorInstruction(claimed: BehaviorInstructionRecord, change: BehaviorChange, key: string): Promise<BehaviorInstructionRecord> {
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<BehaviorInstructionRecord>('behavior-instruction', key)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The behavior instruction claim is missing.')
      if (current.status !== 'interpreting' && current.status !== 'applying') return current
      if (current.status === 'applying' && current.change !== undefined) return current
      if (current.id !== claimed.id) throw new CoreError('INSTRUCTION_CHANGED', 'The behavior instruction claim changed while it was interpreted.')
      const next: BehaviorInstructionRecord = { ...current, change, summary: change.summary,
        ...(change.interpreterVersion === undefined ? {} : { interpreterVersion: change.interpreterVersion }),
        ...(change.model === undefined ? {} : { model: change.model }), status: 'applying', leaseUntil: Date.now() + 120_000, updatedAt: Date.now() }
      await transaction.replace('behavior-instruction', key, next)
      return next
    })
  }

  private async finishBehaviorInstruction(fields: Partial<BehaviorInstructionRecord>, key: string): Promise<BehaviorInstructionRecord> {
    return commandTransaction(this.storage, this.instanceId, async transaction => {
      const current = await transaction.get<BehaviorInstructionRecord>('behavior-instruction', key)
      if (!current) throw new CoreError('INCOMPLETE_STATE', 'The behavior instruction claim is missing.')
      if (current.status !== 'interpreting' && current.status !== 'applying') return current
      const next: BehaviorInstructionRecord = { ...current, ...fields, leaseUntil: Date.now(), updatedAt: Date.now() }
      await transaction.replace('behavior-instruction', key, next)
      return next
    })
  }

  async getBehaviorInstructions(): Promise<BehaviorInstructionRecord[]> {
    return this.storage.transaction(this.instanceId, transaction => this.scanBehaviorRecords<BehaviorInstructionRecord>(transaction, 'behavior-instruction'))
  }

  async getBehaviorInstruction(commandId: string): Promise<BehaviorInstructionRecord | undefined> {
    identifier(commandId, 'commandId')
    return this.storage.transaction(this.instanceId, transaction => transaction.get<BehaviorInstructionRecord>('behavior-instruction', instructionKey(commandId)))
  }

  async getConfigDraft(draftId: string): Promise<ConfigDraft | undefined> {
    identifier(draftId, 'draftId')
    return this.storage.transaction(this.instanceId, transaction => transaction.get<ConfigDraft>('config-draft', draftKey(draftId)))
  }

  async listConfigDrafts(): Promise<ConfigDraft[]> {
    return this.storage.transaction(this.instanceId, transaction => this.scanBehaviorRecords<ConfigDraft>(transaction, 'config-draft'))
  }

  private async scanBehaviorRecords<T extends { createdAt: number }>(transaction: AsyncTx, kind: 'behavior-instruction' | 'config-draft'): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await transaction.scan<T>(kind, { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) })
      items.push(...page.items.map(item => item.value))
      if (!page.cursor) break
      cursor = page.cursor
    }
    return items.sort((left, right) => right.createdAt - left.createdAt)
  }

  async setProcessingPaused(command: { commandId: string; paused: boolean }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'paused'].includes(key))) throw new CoreError('INVALID_INPUT', 'Pausing processing accepts commandId and paused only.')
    identifier(command.commandId, 'commandId')
    if (typeof command.paused !== 'boolean') throw new CoreError('INVALID_INPUT', 'paused must be boolean.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['processing-pause-v1', command.paused])).digest('hex')
    const outcome = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; state: ProcessingState }>('work-command', commandKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The pause command was reused with different input.')
        return { state: prior.state, replayed: true }
      }
      const current = await tx.get<ProcessingState>('processing-state', this.processingKey())
      const next: ProcessingState = { paused: command.paused, revision: (current?.revision ?? 0) + 1, updatedAt: Date.now() }
      if (!await tx.replace('processing-state', this.processingKey(), next)) await tx.insert('processing-state', this.processingKey(), next)
      await tx.insert('work-command', commandKey, { fingerprint, state: next })
      return { state: next, replayed: false }
    })
    if (outcome.replayed) return outcome.state
    this.processingPaused = outcome.state.paused
    this.evaluations?.setPaused(this.processingPaused)
    if (outcome.state.paused) this.effects.setPaused(true)
    else {
      await this.effects.resume()
      this.evaluations?.resume()
      try { await this.recoverInterruptedHandoffs() }
      catch { /* The pause itself is committed; a later startup or unpause retries reconciliation. */ }
    }
    return outcome.state
  }

  async addThreadSubscription(command: { commandId: string; ticketId: string; threadId: string; reason: string; mode?: 'worker' | 'context' }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'threadId', 'reason', 'mode'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Thread subscription accepts commandId, ticketId, threadId, reason and mode only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.threadId, 'threadId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'A Thread subscription needs a bounded reason.')
    if (command.mode !== undefined && command.mode !== 'worker' && command.mode !== 'context') throw new CoreError('INVALID_INPUT', 'A Thread subscription mode is worker or context.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to manage subscriptions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['manual-subscription-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.threadId, command.reason, command.mode ?? 'worker'])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The subscription command was reused for different input.')
        return
      }
      await this.inputs.addSubscription(tx, command.ticketId, command.threadId, 'manual', false, command.mode ?? 'worker', command.reason, this.source.actorId)
      await tx.insert('work-command', commandKey, { fingerprint })
    })
    return this.inputs.direction(command.ticketId)
  }

  async attachSourceEvent(command: { commandId: string; eventId: string; ticketId: string; reason: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'eventId', 'ticketId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Explicit attach accepts commandId, eventId, ticketId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.eventId, 'eventId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Explicit attach needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to attach events.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['explicit-attach-v1', this.source.sourceInstanceId, this.source.actorId, command.eventId, command.ticketId, command.reason])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; inputId: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The attach command was reused for different input.')
        return (await this.inputs.getInput(tx, existing.inputId))!
      }
      const event = await tx.get<SourceEvent>('source-event', command.eventId)
      if (!event) throw new CoreError('NOT_FOUND', 'The source event does not exist.')
      const input = await this.inputs.attach(tx, event, command.ticketId, command.reason, this.source.actorId)
      await tx.insert('work-command', commandKey, { fingerprint, inputId: input.id })
      return input
    })
  }

  /** An explicit, Instance-qualified reference; knowing it never grants access to a Ticket. */
  async getTicketReference(ticketId: string): Promise<string> {
    await this.ensurePolicy()
    identifier(ticketId, 'ticketId')
    await this.storage.transaction(this.instanceId, tx => this.associationOwner(tx, ticketId))
    return `superagent://${encodeURIComponent(this.instanceId)}/tickets/${encodeURIComponent(ticketId)}`
  }

  /** Called by the Ticket owner with a trusted receiving Engine, never with source identity from message data. */
  async associateSourceEvent(command: { commandId: string; ticketId: string; eventId: string; reference: string; reason: string; retargetResult?: boolean }, receiver: Engine) {
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'eventId', 'reference', 'reason', 'retargetResult'].includes(key))) {
      throw new CoreError('INVALID_INPUT', 'Association accepts a command, Ticket, event, explicit reference, reason and optional result retarget only.')
    }
    command = structuredClone(command)
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.eventId, 'eventId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048
      || command.retargetResult !== undefined && typeof command.retargetResult !== 'boolean') throw new CoreError('INVALID_INPUT', 'Association needs a bounded reason and a boolean retarget flag.')
    if (!(receiver instanceof Engine) || receiver.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Association requires a trusted receiver in the same Instance.')
    await this.ensurePolicy(); await receiver.ensurePolicy()
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['cross-source-association-v1', command,
      receiver.source.kind ?? 'desktop', receiver.source.sourceInstanceId, receiver.source.actorId])).digest('hex')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      await this.associationOwner(tx, command.ticketId)
      const prior = await tx.get<{ fingerprint: string; result: { input: WorkInput; target?: DeliveryTarget } }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The association command was reused for different input.')
        return prior.result
      }
      await this.assertHostAdmissionIn(tx)
      for (const engine of [this, receiver]) {
        const processing = await tx.get<ProcessingState>('processing-state', engine.processingKey())
        if (processing?.paused || engine.processingPaused) throw new CoreError('PROCESSING_PAUSED', 'Cross-source input cannot be associated while either source is paused.')
      }
      const policy = await tx.get<StoredPolicy>('policy-state', receiver.policyKey())
      const event = await receiver.sourceEvents.associationCandidate(tx, command.eventId,
        policy?.configuration.allowedRequesterIds ?? receiver.source.intake?.allowedRequesterIds ?? receiver.source.allowedActorIds)
      const reference = `superagent://${encodeURIComponent(this.instanceId)}/tickets/${encodeURIComponent(command.ticketId)}`
      const references = [...new Set(event.text?.match(/superagent:\/\/[^\s<>"[\]]+/gu) ?? [])]
      if (command.reference !== reference || references.length !== 1 || references[0] !== reference) {
        throw new CoreError('ASSOCIATION_REFERENCE_INVALID', 'Association requires exactly one matching Instance-qualified Ticket reference in the current native message.')
      }
      const input = await this.inputs.attachAssociated(tx, command.ticketId, event, { reference, source: event.source,
        sourceActorId: event.authorId, authorizedBy: this.source.actorId, ownerSourceInstanceId: this.source.sourceInstanceId,
        reason: command.reason, checkedAt: Date.now() })
      const target = command.retargetResult ? await this.deliveryState.setTarget(tx, {
        ticketId: command.ticketId, purpose: 'result', sourceInstanceId: event.source.sourceInstanceId,
        threadId: event.threadId, objectId: event.objectId, evidence: command.reason, evidenceEventId: event.id, authorizedBy: this.source.actorId,
      }) : undefined
      const result = { input, ...(target ? { target } : {}) }
      await tx.insert('work-command', key, { fingerprint, result })
      return result
    })
  }

  private async associationOwner(tx: AsyncTx, ticketId: string) {
    const work = await this.readWork(tx, ticketId)
    if (!work || work.trigger.source.sourceInstanceId !== this.source.sourceInstanceId || work.trigger.source.kind !== (this.source.kind ?? 'desktop') || work.trigger.source.actorId !== this.source.actorId
      || !this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the original trusted source actor can authorize association to this Ticket.')
    const policy = await tx.get<StoredPolicy>('policy-state', this.policyKey())
    const original = work.trigger.threadId ? await tx.get<SourceEvent>('source-event', work.trigger.id) : undefined
    const allowed = policy?.configuration.allowedRequesterIds ?? this.source.intake?.allowedRequesterIds ?? this.source.allowedActorIds
    if (!allowed.includes(original?.authorId ?? this.source.actorId) || work.decision.outcome !== 'accept') {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The original work authorization is no longer valid for association.')
    }
    return work
  }

  async requeueSourceEvent(command: { commandId: string; eventId: string }) {
    await this.ensurePolicy()
    if (!this.evaluations) throw new CoreError('INTAKE_NOT_CONFIGURED', 'Manual requeue requires an Intake Policy.')
    if (!command || Object.keys(command).some(key => !['commandId', 'eventId'].includes(key))) throw new CoreError('INVALID_INPUT', 'Manual requeue accepts commandId and eventId only.')
    identifier(command.commandId, 'commandId'); identifier(command.eventId, 'eventId')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to requeue work.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['manual-requeue-v1', this.source.sourceInstanceId, this.source.actorId, command.eventId])).digest('hex')
    const event = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing && existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The requeue command was reused for a different event.')
      const sourceEvent = await tx.get<SourceEvent>('source-event', command.eventId)
      if (!sourceEvent) throw new CoreError('NOT_FOUND', 'The requeued source event does not exist.')
      if (!this.sourceEvents.belongsToSource(sourceEvent)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source event belongs to a different source instance.')
      if (!existing) {
        await this.inputs.prepareRequeue(tx, sourceEvent, command.commandId, commandKey, this.source.actorId)
        await tx.insert('work-command', commandKey, { fingerprint })
      }
      return sourceEvent
    })
    return this.evaluations.assess({ commandId: `requeue:${commandKey}`, threadId: event.threadId, eventIds: [event.id] })
  }

  async removeThreadSubscription(command: { commandId: string; ticketId: string; threadId: string; reason: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'threadId', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'Removing a Thread subscription accepts commandId, ticketId, threadId and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId'); identifier(command.threadId, 'threadId')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) throw new CoreError('INVALID_INPUT', 'Removing a Thread subscription needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to manage subscriptions.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['remove-subscription-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.threadId, command.reason])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The unsubscribe command was reused for different input.')
        return
      }
      await this.inputs.removeSubscription(tx, command.ticketId, command.threadId, command.reason, this.source.actorId, commandKey)
      await tx.insert('work-command', commandKey, { fingerprint })
    })
    return this.inputs.direction(command.ticketId)
  }

  async addTicketNote(command: { commandId: string; ticketId: string; text: string; sourceTicketId?: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'text', 'sourceTicketId'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Ticket note accepts commandId, ticketId, text and sourceTicketId only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 4096) throw new CoreError('INVALID_INPUT', 'A Ticket note needs bounded nonempty text.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor is not authorized to add notes.')
    const commandKey = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['ticket-note-v1', this.source.sourceInstanceId, this.source.actorId, command.ticketId, command.text, command.sourceTicketId ?? null])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<{ fingerprint: string; noteId?: string; note?: WorkNote }>('work-command', commandKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The note command was reused for different input.')
        if (existing.note) return existing.note
        return { noteId: existing.noteId }
      }
      const note = await this.inputs.addNote(tx, command.ticketId, command.text, this.source.actorId, command.sourceTicketId)
      await tx.insert('work-command', commandKey, { fingerprint, noteId: note.id, note })
      return note
    })
    if ('text' in result && 'createdAt' in result) return result
    return (await this.inputs.direction(command.ticketId))?.notes.find(note => note.id === result.noteId)!
  }

  /** An approved semantic correction: one direction input for the Worker, never a tool call by the supervisor. */
  async correctTicket(command: { commandId: string; ticketId: string; text: string; reason: string }) {
    await this.ensurePolicy()
    if (!command || Object.keys(command).some(key => !['commandId', 'ticketId', 'text', 'reason'].includes(key))) throw new CoreError('INVALID_INPUT', 'A Ticket correction accepts commandId, ticketId, text and reason only.')
    identifier(command.commandId, 'commandId'); identifier(command.ticketId, 'ticketId')
    if (typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 65_536) throw new CoreError('INVALID_INPUT', 'A correction needs bounded nonempty text.')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2_048) throw new CoreError('INVALID_INPUT', 'A correction needs a bounded reason.')
    if (!this.source.allowedActorIds.includes(this.source.actorId)) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The source actor cannot correct this Ticket.')
    const key = this.commandKey(command.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson(['supervisor-correction-v1', this.instanceId, command.ticketId, command.text, command.reason])).digest('hex')
    const result = await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; inputId: string; input?: WorkInput }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The correction command was reused for different input.')
        return prior.input ?? await tx.get<WorkInput>('work-input', prior.inputId)
      }
      const ticket = await tx.get<Work['ticket']>('ticket', command.ticketId)
      if (!ticket) throw new CoreError('NOT_FOUND', 'The Ticket does not exist.')
      if (ticket.constraint) throw new CoreError('TICKET_BLOCKED', 'The Ticket constraint must be resolved before a correction.')
      const input = await this.inputs.attachSyntheticInput(tx, {
        ticketId: command.ticketId, sourceEventId: JSON.stringify(['supervisor-correction', command.ticketId, command.commandId]),
        threadId: '__supervisor__', text: command.text, authorId: this.source.actorId, reason: command.reason, basis: 'supervisor-correction',
      })
      await tx.insert('work-command', key, { fingerprint, inputId: input.id, input })
      return input
    })
    if (!result) throw new CoreError('INCOMPLETE_STATE', 'The correction input is missing.')
    return result
  }

  listTickets(cursor?: string): Promise<{ items: Work[]; hasMore: boolean; nextCursor?: string }> {
    const sourceAfter = cursor === undefined ? undefined : this.ticketCursorAfter(cursor)
    return this.storage.transaction(this.instanceId, async tx => {
      const items: Work[] = []
      let after = sourceAfter
      let lastIncluded = sourceAfter
      let scanned = 0
      while (scanned < 1000) {
        const tickets = await tx.scan<Work['ticket']>('ticket', { limit: Math.min(101, 1000 - scanned), ...(after ? { after } : {}) })
        for (const { id } of tickets.items) {
          scanned++
          after = id
          const work = await this.readWork(tx, id)
          if (!work || !this.canReadTicket(work.trigger)) continue
          if (items.length === 100) return { items, hasMore: true, nextCursor: this.rememberTicketCursor(lastIncluded!) }
          items.push(work)
          lastIncluded = id
        }
        if (!tickets.cursor) return { items, hasMore: false }
        after = tickets.cursor
      }
      const nextCursor = items.length === 100 ? lastIncluded : after
      return { items, hasMore: true, nextCursor: this.rememberTicketCursor(nextCursor!) }
    })
  }

  private ticketCursorAfter(cursor: string): string {
    identifier(cursor, 'cursor')
    const stored = this.ticketCursors.get(cursor)
    if (!stored || stored.expiresAt <= Date.now() || stored.sourceInstanceId !== this.source.sourceInstanceId || stored.actorId !== this.source.actorId) {
      this.ticketCursors.delete(cursor)
      throw new CoreError('INVALID_INPUT', 'The Ticket list cursor is stale or belongs to another source.')
    }
    stored.expiresAt = Date.now() + 5 * 60 * 1000
    return stored.after
  }

  private rememberTicketCursor(after: string): string {
    const now = Date.now()
    for (const [cursor, stored] of this.ticketCursors) {
      if (stored.expiresAt <= now) this.ticketCursors.delete(cursor)
    }
    while (this.ticketCursors.size >= 100) this.ticketCursors.delete(this.ticketCursors.keys().next().value!)
    const cursor = randomUUID()
    this.ticketCursors.set(cursor, { after, sourceInstanceId: this.source.sourceInstanceId, actorId: this.source.actorId, expiresAt: now + 5 * 60 * 1000 })
    return cursor
  }

  private async readWork(tx: AsyncTx, ticketId: string): Promise<Work | undefined> {
    const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
    if (!ticket) return undefined
    const trigger = await tx.get<Work['trigger']>('trigger', ticket.triggerId)
    const mandate = await tx.get<Work['mandate']>('mandate', ticket.mandateId)
    const decision = mandate && await tx.get<Work['decision']>('decision', mandate.decisionId)
    const intent = await tx.get<Work['intent']>('intent', ticket.id)
    if (!trigger || !mandate || !decision || !intent) throw new CoreError('INCOMPLETE_STATE', 'Accepted work is missing required durable facts.')
    return { trigger, decision, mandate, ticket, intent }
  }

  private canReadTicket(trigger: Work['trigger']) {
    return trigger.source.sourceInstanceId === this.source.sourceInstanceId
      && trigger.source.kind === (this.source.kind ?? 'desktop')
      && trigger.source.actorId === this.source.actorId
  }

  private async assertTicketReadable(ticketId: string) {
    return this.storage.transaction(this.instanceId, tx => this.assertTicketReadableIn(tx, ticketId))
  }

  private async assertTicketReadableIn(tx: AsyncTx, ticketId: string) {
    const ticket = await tx.get<Work['ticket']>('ticket', ticketId)
    const trigger = ticket && await tx.get<Work['trigger']>('trigger', ticket.triggerId)
    if (ticket && (!trigger || !this.canReadTicket(trigger))) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This source cannot read another source instance’s private Ticket.')
  }
}

const handoffCopyKey = (ticketId: string) => JSON.stringify(['handoff-copy', ticketId])
const handoffCopyHistoryPrefix = (ticketId: string) => JSON.stringify(['handoff-copy-history', ticketId])

function workCopyBlockers(error: unknown): WorkCopyBlocker[] {
  if (error instanceof WorkCopyUnsupported) return error.gaps.map(code => ({ code, message: error.message }))
  if (error instanceof CoreError) return [{ code: error.code, message: error.message }]
  return [{ code: 'work-copy-inspection-failed', message: 'The Environment could not inspect its work copy.' }]
}

async function inspectEnvironmentWorkCopy(environment: ExecutionEnvironment,
  identity: { instanceId: string; actorId: string }): Promise<{ snapshot?: WorkCopySnapshot; blocker?: WorkCopyBlocker }> {
  try {
    const bound = await environment.prepare(identity)
    if (!bound.inspectWorkCopy) throw new WorkCopyUnsupported('The Environment has no work-copy inspection.', [workCopyGaps.inspectMissing])
    return { snapshot: await bound.inspectWorkCopy() }
  } catch (error) {
    return { blocker: workCopyBlockers(error)[0]! }
  }
}

function sameWorkCopyFiles(left: WorkCopyFile[], right: WorkCopyFile[]) {
  if (left.length !== right.length) return false
  const expected = new Map(left.map(file => [file.path, file]))
  return right.every(file => {
    const match = expected.get(file.path)
    return Boolean(match) && match!.state === file.state && match!.executable === file.executable
      && match!.bytes === file.bytes && match!.sha256 === file.sha256
  })
}

async function saveHandoffCopy(transaction: AsyncTx, record: HandoffCopyView) {
  const key = handoffCopyKey(record.ticketId)
  if (!await transaction.replace('handoff-copy', key, record)) await transaction.insert('handoff-copy', key, record)
  const historyKey = `${handoffCopyHistoryPrefix(record.ticketId)}:${String(record.preparedAt).padStart(16, '0')}:${record.id}`
  if (!await transaction.replace('handoff-copy-history', historyKey, record)) await transaction.insert('handoff-copy-history', historyKey, record)
  return record
}

function loadHandoffCopy(transaction: AsyncTx, ticketId: string) {
  return transaction.get<HandoffCopyView>('handoff-copy', handoffCopyKey(ticketId))
}
