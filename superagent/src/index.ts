import type { Context } from '@deepseek-ai/cordis'
import { Engine } from './engine.js'
import { SqliteStorage, type Storage } from './storage.js'
import type { DesktopSource } from './model.js'
import type { EffectsOptions } from './effects.js'
import type { NativeSessions } from './native-sessions.js'
import type { ExecutionEnvironment } from './environment.js'
import type { SlotOptions } from './slots.js'
import type { JobsOptions } from './jobs.js'
import type { SubagentsOptions } from './subagents.js'
import type { DeliveryOptions } from './deliveries.js'
import type { HostOptions } from './host.js'
import type { ProactiveOptions } from './proactive.js'

export { Engine } from './engine.js'
export { createProductHost } from './product-host.js'
export type { ProductHost, ProductHostConfig } from './product-host.js'
export type { MainAddress, MainBinding, MainMessage, MainPage, MainSend } from './main-conversation.js'
export { WorkDelegation } from './work-delegation.js'
export type { MainWorkBrief, MainWorkCard, MainWorkCardBrief, MainWorkIntent, MainWorkItem, MainWorkNotification, MainWorkOutcome,
  MainWorkPlan, MainWorkPlanConflict, MainWorkPlanItem, MainWorkReceipt, MainWorkRequest, MainWorkSplit, MainWorkStatus, MainWorkTicketSnapshot, MainWorkUpdate } from './work-delegation.js'
export { LocalEnvironment, BoundLocalEnvironment, LocalSetupError } from './local-environment.js'
export type { LocalEnvironmentConfig, LocalCommand, LocalPermission, LocalToolFact, Artifact, LocalJob, LocalJobResult, LocalJobOutput, RemoteJobObservation } from './local-environment.js'
export type { EnvironmentConfig, EnvironmentKind, EnvironmentLocation, EnvironmentProbe, ExecutionEnvironment, PreparedEnvironment } from './environment.js'
export { assetNamespace, FileAssetStore } from './environment-assets.js'
export type { EnvironmentAssetCapabilities, EnvironmentAssetPage, EnvironmentAssetReference, EnvironmentSkillSummary } from './environment-assets.js'
export type { ExecutionCandidateView, ExecutionDefaultTarget, ExecutionPolicyConfig, ExecutionPolicyView, ExecutionSelectionView, ExecutionTarget } from './execution-target.js'
export { capabilityIds, capabilityLocations, validateHostCapabilities, validateRequiredCapabilities } from './capability-locations.js'
export type { CapabilityCredentialScope, CapabilityId, CapabilityLocalDeclaration, CapabilityLocation, CapabilityLocationView,
  CapabilityPlanView, CapabilityPrivacyScope, CapabilityRemoteDeclaration, CapabilityResolutionView, CapabilityRole, CapabilitySupport,
  HostCapabilities } from './capability-locations.js'
export { compareWorkCopy, inspectWorkCopy, workCopyGaps, WorkCopyUnsupported } from './work-copy.js'
export type { HandoffCopyView, WorkCopyBlocker, WorkCopyComparison, WorkCopyDigest, WorkCopyFile, WorkCopyFileState, WorkCopySnapshot } from './work-copy.js'
export { RemoteDevice } from './remote-device.js'
export type { RemoteDeviceCommand, RemoteDeviceConfig, RemoteDeviceGrant, RemotePairingView, RemotePermission } from './remote-device.js'
export { RemoteEnvironment } from './remote-environment.js'
export type { RemoteEnvironmentPermission, RemoteEnvironmentState, RemotePairOptions } from './remote-environment.js'
export { RemoteJobHandle, RemoteSubprocess, RemoteTerminalHandle } from './remote-subprocess.js'
export type { RemoteCommandTransport, RemoteJobState, RemoteSpawnSpec, RemoteTerminalSpawnSpec } from './remote-subprocess.js'
export type { RemoteCommandSpec, RemoteJobRecovery } from './remote-protocol.js'
export { NativeSessions } from './native-sessions.js'
export type { NativeSessionsOptions, NativeSessionRequest, NativeTool } from './native-sessions.js'
export { DsBotExecutionAdapter } from './ds-bot-adapter.js'
export type { DsBotAdapterContext, DsBotAdapterOptions, DsBotEngineFactory, DsBotEngineFactoryResult, DsBotNativeSessions, DsBotOwner } from './ds-bot-adapter.js'
export { createDsBotHostAdapter } from './ds-bot-host.js'
export type { DsBotHostConfig } from './ds-bot-host.js'
export { SqliteSessionPersistence, StorageSessionPersistence } from './session-persistence.js'
export type { Config as SessionPersistenceConfig } from './session-persistence.js'
export { Slots } from './slots.js'
export type { ExecutionSlot, SlotActivation, SlotLimits, SlotOptions, SlotSnapshot, SlotWaitingReason } from './slots.js'
export { Jobs } from './jobs.js'
export type { JobCancelReason, JobOutput, JobRecord, JobStart, JobState, JobStream, JobView, JobsOptions } from './jobs.js'
export { Previews } from './previews.js'
export type { PreviewRecord, PreviewState, PreviewView } from './previews.js'
export { Subagents } from './subagents.js'
export type { SubagentCancelReason, SubagentRecord, SubagentResult, SubagentScope, SubagentStart, SubagentState, SubagentView, SubagentsOptions } from './subagents.js'
export { BackgroundWork } from './background.js'
export type { BackgroundEntry, BackgroundIndexRecord, BackgroundKind, BackgroundLiveness } from './background.js'
export type { EnvironmentHandoffState, EnvironmentHandoffStep, EnvironmentHandoffView, HandoffBlocker } from './environment-handoff.js'
export type { StatusReport } from './execution.js'
export { createChatServer } from './chat-server.js'
export { ClientAccess } from './client-access.js'
export type { ClientCapability, ClientEnrollment, ClientEvent, ClientEventInput, ClientEventPage, ClientGrant, ClientIdentity } from './client-access.js'
export { createClientGateway } from './client-gateway.js'
export type { ClientGatewayOptions, ClientGatewayTls } from './client-gateway.js'
export { Effects } from './effects.js'
export type { Effect, EffectRequest, EffectReceipt, EffectResult, EffectHandler, EffectsOptions } from './effects.js'
export { localDeliveryChannel } from './deliveries.js'
export type { Delivery, DeliveryBasis, DeliveryChannel, DeliveryContext, DeliveryDestination, DeliveryOptions, DeliveryPurpose, DeliveryResult, DeliveryState, DeliveryView } from './deliveries.js'
export { HostLease } from './host.js'
export type { HostAcquisition, HostLeaseRecord, HostLeaseView, HostOptions } from './host.js'
export { Watchdog } from './watchdog.js'
export type { WatchdogBudget, WatchdogHost, WatchdogInspection, WatchdogKind, WatchdogNotification, WatchdogOptions, WatchdogProbe,
  WatchdogSetupHealth, WatchdogSourceHealth, WatchdogState } from './watchdog.js'
export { ProcessWatchdogHost } from './watchdog-process.js'
export type { ProcessWatchdogHostOptions, ProcessWatchdogStatus } from './watchdog-process.js'
export { listSupervisorProposals, Supervisor } from './supervisor.js'
export type { SupervisorAssessment, SupervisorAssessor, SupervisorEngine, SupervisorObservationRecord, SupervisorObservationResult,
  SupervisorFindingKind, SupervisorOptions, SupervisorProposal, SupervisorReport, SupervisorSnapshot } from './supervisor.js'
export { createSessionAssessor } from './supervisor-session.js'
export type { SessionSupervisorOptions } from './supervisor-session.js'
export { createSessionConfigInterpreter, validateBehaviorChange } from './config-instructions.js'
export type { BehaviorChange, BehaviorInstructionRecord, BehaviorInterpreter, BehaviorInterpreterRequest, BehaviorPolicyChange,
  ConfigDraft, SessionConfigInterpreterOptions } from './config-instructions.js'
export { getLegacyArchive, listLegacyArchives, prepareLegacyArchive, publishLegacyArchive, readLegacyObject, verifyLegacyArchive } from './legacy-archive.js'
export type { LegacyArchiveManifest, LegacyArchiveMapping, LegacyArchiveOptions, LegacyArchiveReadOptions, LegacyArchiveReviewItem,
  LegacyArchiveRole, LegacyArchiveSession } from './legacy-archive.js'
export { Switchover } from './switchover.js'
export type { GapCounts, GapCursor, GapInputPage, GapInputResult, GapInputState, GapReceipt, GapVersion, LegacyCore, LegacyCursorFact, LegacyReceiptFact,
  LegacyReceiptState, LegacyRestartEvidence, LegacyReviewFact, LegacySnapshot, LegacyStopEvidence, SwitchoverArchiveFact, SwitchoverBlocker, SwitchoverCheckpoint,
  SwitchoverEntry, SwitchoverEntryFact, SwitchoverGapInput, SwitchoverOldHomeFact, SwitchoverOptions, SwitchoverRecord, SwitchoverState,
  SwitchoverRestartFact, SwitchoverStopFact, SwitchoverView } from './switchover.js'
export { Activation, CURRENT_CORE } from './activation.js'
export type { ActivationGate, ActivationGapRecord, ActivationGapState, ActivationManifest, ActivationOptions, ActivationRecord,
  ActivationRelease, ActivationReleaseContext, ActivationReleaseCounts, ActivationReleaseResult, ActivationState, ActivationView, CurrentCore } from './activation.js'
export { Reversal } from './reversal.js'
export type { AbandonOptions, AbandonmentRecord, LegacyRecovery, LegacyRestartControl, ReverseControl, ReverseEvidence, ReverseOptions, ReverseRecord, ReverseState } from './reversal.js'
export type { HostTakeoverBlocker, HostTakeoverBlockerCode, HostTakeoverOutcome, HostTakeoverRecord, HostTakeoverTicket } from './host-takeover.js'
export { RoleConfigStore, validateRoleConfig } from './config.js'
export type { RoleConfig, RoleConfigUse, RoleConfigView, RoleModel, RoleProfile, StoredRoleConfig } from './config.js'
export { FeishuSource, GitHubSource, ScheduleSource } from './channels.js'
export type { FeishuEvent, FeishuSourceConfig, GitHubEvent, GitHubSourceConfig, ScheduleConfig, ScheduleOccurrence, ScheduleRule } from './channels.js'
export type { DeliveryCondition, DeliveryConditionKind, DeliveryConditionState, DeliveryTarget } from './delivery-state.js'
export type { ContextCandidate, ContextCard, ContextKind, ContextRef, ContextRequest } from './context.js'
export { Proactive } from './proactive.js'
export type { ProactiveArtifact, ProactiveBudget, ProactiveCandidate, ProactiveMatch, ProactiveMode, ProactiveOptions, ProactivePreparation, ProactiveRule, ProactiveRun } from './proactive.js'
export { FeishuPoller, GitHubPoller, ScheduleRunner } from './pollers.js'
export type { ChannelHealth, FeishuTransport, GitHubTransport } from './pollers.js'
export { GitHubCliReplyTransport, GitHubCliTransport, isMissingResource } from './github-api.js'
export type { GitHubApiRunner, GitHubCliTransportOptions } from './github-api.js'
export { GitHubDeliveryChannel } from './github-delivery.js'
export type { GitHubComment, GitHubDeliveryChannelOptions, GitHubPlatformReceipt, GitHubReplyRequest, GitHubReplySource, GitHubReplyTransport } from './github-delivery.js'
export { FeishuApiError, FeishuOpenApi } from './feishu-api.js'
export type { FeishuApiOptions, FeishuChatInfo } from './feishu-api.js'
export { FeishuMemberSync } from './feishu-sync.js'
export { FeishuDeliveryChannel } from './feishu-delivery.js'
export type { FeishuDeliveryChannelOptions, FeishuReplyTransport } from './feishu-delivery.js'
export { FeishuRuntime } from './feishu-runtime.js'
export type { FeishuRuntimeOptions } from './feishu-runtime.js'
export { SourceMembership } from './membership.js'
export type { MembershipSnapshot, SourceMember } from './membership.js'
export { CoreError } from './model.js'
export type { DesktopSource, Receipt, SourceKind, SubmitRequest, Work, IntakePolicy, IntakeRule, IntakeAssessment, IntakeActorKind, IntakeAddressing } from './model.js'
export type { SourceObjectRef, ReceiveSourceEvent, AcceptSourceRequest, SourceEvent, SourceProjection, SourceReceipt } from './source-events.js'
export type { EvaluationItem, SourceEvaluation } from './source-evaluations.js'
export type { Attention } from './attention.js'
export type { CrossSourceAssociation, InputDelivery, RecoveryDecision, RequeueDecision, SubscriptionDecision, ThreadSubscription, TicketDirection, WorkFanout, WorkFanoutTarget, WorkInput, WorkNote, WorkOwnership } from './work-inputs.js'
export type { AsyncTx, Storage } from './storage.js'

export interface Config { databasePath: string; instanceId: string; source: DesktopSource; storage?: Storage; effects?: EffectsOptions; sessions?: NativeSessions; environments?: ExecutionEnvironment[]; slots?: SlotOptions; jobs?: JobsOptions; subagents?: SubagentsOptions; delivery?: DeliveryOptions; host?: HostOptions; proactive?: ProactiveOptions; activationGate?: import('./activation.js').ActivationGate }
export const name = 'ds-superagent'

declare module '@deepseek-ai/cordis' { interface Context { superagent: Engine } }

export async function apply(ctx: Context, config: Config) {
  const storage = config.storage ?? await SqliteStorage.open(config.databasePath)
  let engine: Engine | undefined
  ctx.effect(() => async () => {
    // Stop background work before releasing the lease, so the release is not lost to a racing transaction.
    try { await engine?.effects.stop(); await engine?.shutdown() } finally { await storage.close() }
  })
  engine = new Engine(storage, config.instanceId, config.source, config.effects, config.sessions, config.environments, config.slots, config.jobs, config.subagents, config.delivery, config.host, config.proactive)
  engine.setActivationGate(config.activationGate)
  // A process may only serve an Instance after it holds the lease. A replacement reconciles the prior Host first.
  await engine.acquireHost()
  ctx.provide('superagent', engine)
  engine.effects.start()
}
