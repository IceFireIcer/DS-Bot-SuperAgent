import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier, type DesktopSource } from './model.js'
import type { NativeSessions, NativeTool } from './native-sessions.js'
import type { AsyncTx, Storage } from './storage.js'
import type { RoleProfile } from './config.js'
import type { MainWorkCard, MainWorkIntent, MainWorkNotification, WorkDelegation } from './work-delegation.js'

export interface MainBinding { instanceId: string; mainId: string; mainSessionId: string; routerSessionId: string }
interface MainState extends MainBinding { sequence: number; activeCommand?: string }
export interface MainMessage { id: string; sequence: number; role: 'user' | 'main'; text: string; createdAt: number; status: 'queued' | 'running' | 'completed' | 'failed'; error?: string }
interface MainCommand { fingerprint: string; messageId: string; userSequence: number; status: MainMessage['status']; replySequence?: number }
interface MainUpdateCommand { attempt: number; state: 'running' | 'failed' | 'completed' | 'discarded'; messageId: string; sequence?: number }
export interface MainAddress { instanceId: string }
export interface MainSend extends MainAddress { commandId: string; text: string }
export interface MainPage extends MainBinding { messages: MainMessage[]; cursor?: number; works?: MainWorkCard[] }
interface MainEvent { type: string; data: { id?: string; message?: { content?: { type: string; text?: string }[] }; reason?: { kind?: string } } }
const messageKey = (sequence: number) => String(sequence).padStart(16, '0')

/** Business facts stay separate from the native Session; no transaction spans a model turn. */
export class MainConversation {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private pendingTurns = 0
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly source: DesktopSource,
    private readonly sessions?: NativeSessions,
    private readonly prepare?: (sessionId: string) => Promise<{ profile: RoleProfile; revision: number }>,
    private readonly work?: () => WorkDelegation | undefined) {}

  private authorize(request: MainAddress) {
    if (!request || request.instanceId !== this.instanceId || !this.source.allowedActorIds.includes(this.source.actorId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This Main conversation is outside the authorized Instance.')
    }
    if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The Main conversation is closed.')
  }

  private async state(tx: AsyncTx): Promise<MainState> {
    const prior = await tx.get<MainState>('main-state', 'main')
    if (prior) return prior
    const initial: MainState = { instanceId: this.instanceId, mainId: `main-${randomUUID()}`, mainSessionId: `main-session-${randomUUID()}`, routerSessionId: `router-${randomUUID()}`, sequence: 0 }
    await tx.insert('main-state', 'main', initial)
    return initial
  }

  async open(request: MainAddress): Promise<MainBinding> {
    this.authorize(request)
    if (!this.sessions?.mainRoute) throw new CoreError('ROLE_NOT_CONFIGURED', 'Main needs its own explicit model route.')
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const { sequence: _sequence, activeCommand: _active, ...binding } = await this.state(tx)
      return binding
    })
  }

  async page(request: MainAddress & { after?: number; limit?: number }): Promise<MainPage> {
    this.authorize(request)
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) {
      throw new CoreError('INVALID_INPUT', 'Main history needs a bounded page and non-negative cursor.')
    }
    const state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
    if (state.activeCommand) await this.reconcile(state, state.activeCommand)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const { sequence: _sequence, activeCommand: _active, ...binding } = await this.state(tx)
      const page = await tx.scan<MainMessage>('main-message', { limit, ...(request.after === undefined ? {} : { after: messageKey(request.after) }) })
      return { ...binding, messages: page.items.map(item => item.value), ...(page.cursor ? { cursor: Number(page.cursor) } : {}) }
    })
  }

  async send(request: MainSend) {
    this.authorize(request)
    identifier(request.commandId, 'commandId')
    if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 32768) throw new CoreError('INVALID_INPUT', 'Send a nonempty Main message of at most 32768 bytes.')
    const binding = await this.open(request)
    const key = createHash('sha256').update(canonicalJson([this.source.sourceInstanceId, this.source.actorId, request.commandId])).digest('hex')
    const fingerprint = createHash('sha256').update(canonicalJson([request.instanceId, request.text])).digest('hex')
    await commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainCommand>('main-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This Main message identity was already used for different text.')
        return
      }
      const state = await this.state(tx)
      const sequence = state.sequence + 1
      const messageId = `main-input-${randomUUID()}`
      await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: messageId, sequence, role: 'user', text: request.text, createdAt: Date.now(), status: 'queued' })
      await tx.insert<MainCommand>('main-command', key, { fingerprint, messageId, userSequence: sequence, status: 'queued' })
      await tx.replace('main-state', 'main', { ...state, sequence })
    })
    this.pendingTurns++
    const turn = this.tail.then(() => this.run(binding, key, request.text)).finally(() => { this.pendingTurns-- })
    this.tail = turn.catch(() => {})
    return turn
  }

  private tools(binding: MainBinding, command: MainCommand, originalUserText: string, configurationRevision: number): NativeTool[] {
    return [
      { name: 'delegate_work', description: 'Create one durable local WorkBrief for one to four independent items. Give every item a clear goal, strict constraints and observable acceptance criteria. The Router decides and establishes the Tickets; this tool does not mean any Worker started or completed.',
        parameters: {
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                goal: { type: 'string', required: true },
                constraints: { type: 'string' },
                acceptanceCriteria: { type: 'string' },
              },
            },
          },
          goal: { type: 'string' },
          constraints: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
        },
        execute: async args => {
          const work = this.work?.()
          if (!work) return JSON.stringify({ status: 'rejected', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false, message: 'No authorized local workspace is configured; no work was started.' })
          const items = Array.isArray(args.items) ? args.items.map(item => {
            const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
            return {
              goal: value.goal,
              constraints: value.constraints ?? args.constraints,
              acceptanceCriteria: value.acceptanceCriteria ?? args.acceptanceCriteria,
            }
          }) as MainWorkIntent[] : undefined
          const brief = await work.create({ commandId: `main-work:${command.messageId}`, mainId: binding.mainId,
            mainSessionId: binding.mainSessionId, routerSessionId: binding.routerSessionId, mainMessageId: command.messageId,
            originalUserText, ...(items ? { items } : { goal: args.goal ?? '', constraints: args.constraints ?? '', acceptanceCriteria: args.acceptanceCriteria ?? '' }),
            configurationRevision })
          return JSON.stringify(await work.query(binding.mainId, { workBriefId: brief.id }))
        } },
      { name: 'query_work', description: 'Read a bounded status, receipt and verified result for a work item already visible in the Main conversation.',
        parameters: { workBriefId: { type: 'string' }, workItemId: { type: 'string' } },
        execute: async args => {
          const work = this.work?.()
          return work ? JSON.stringify(await work.query(binding.mainId, {
            ...(args.workBriefId ? { workBriefId: args.workBriefId } : {}), ...(args.workItemId ? { workItemId: args.workItemId } : {}),
          }))
            : JSON.stringify({ status: 'unavailable', code: 'DELEGATION_UNAVAILABLE', ticketCreated: false })
        } },
    ]
  }

  private async run(binding: MainBinding, key: string, text: string) {
    if (this.closed) throw new CoreError('RUNTIME_CLOSED', 'The Main conversation is closed.')
    const command = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
    if (!command) throw new CoreError('INCOMPLETE_STATE', 'The Main input receipt is missing.')
    if (command.status === 'completed') return { ...binding, messageId: command.messageId, status: command.status }
    try {
      const state = await commandTransaction(this.storage, this.instanceId, tx => this.state(tx))
      if (state.activeCommand && state.activeCommand !== key) {
        if (!await this.reconcile(binding, state.activeCommand)) throw new CoreError('MAIN_TURN_UNKNOWN', 'The previous Main turn needs reconciliation before another turn.')
      }
      if ((await this.sessions!.hasMessage(binding.mainSessionId, command.messageId)).found) {
        if (await this.reconcile(binding, key)) return { ...binding, messageId: command.messageId, status: 'completed' as const }
        if (command.status === 'failed') return { ...binding, messageId: command.messageId, status: command.status }
        throw new CoreError('MAIN_TURN_UNKNOWN', 'The previous Main turn needs reconciliation.')
      }
      if (command.status === 'failed') return { ...binding, messageId: command.messageId, status: command.status }
      await this.updateCommand(key, 'running')
      const prepared = await this.prepare?.(binding.mainSessionId)
      const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, text,
        tools: this.tools(binding, command, text, prepared?.revision ?? 1), messageId: command.messageId,
        ...(prepared ? { profile: prepared.profile } : {}) })
      const answer = this.reply(result.events as MainEvent[], command.messageId)
      if (!answer) throw new CoreError('MAIN_TURN_FAILED', 'Main did not produce a completed visible reply.')
      await this.publish(key, answer)
      return { ...binding, messageId: command.messageId, status: 'completed' as const }
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'MAIN_TURN_FAILED'
      await this.updateCommand(key, 'failed', code)
      throw new CoreError(code, 'Main could not finish this reply. Your message remains in the conversation.')
    }
  }

  notify(notification: MainWorkNotification, signal: AbortSignal, isCurrent: (transaction?: AsyncTx) => Promise<boolean>) {
    signal.throwIfAborted()
    if (this.pendingTurns) throw new CoreError('MAIN_BUSY', 'Main is handling another turn; keep this notification queued.')
    this.pendingTurns++
    const turn = this.tail.then(async () => {
      signal.throwIfAborted()
      const binding = await this.open({ instanceId: this.instanceId })
      if (notification.mainId !== binding.mainId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'The work update belongs to another Main.')
      const key = notification.update.id
      const prior = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainUpdateCommand>('main-update-command', key))
      if (prior?.state === 'completed' || prior?.state === 'discarded') return
      if (prior?.state === 'running') {
        const previous = await this.readTurn(binding, prior.messageId)
        if (previous.answer) {
          await this.publishUpdateReply(key, prior.messageId, previous.answer, prior.attempt, isCurrent)
          return
        }
      }
      const attempt = prior?.state === 'failed' || prior?.state === 'running' ? prior.attempt + 1 : prior?.attempt ?? 0
      const messageId = `main-update:${key}:${attempt}`
      const record = (state: MainUpdateCommand['state']) => commandTransaction(this.storage, this.instanceId, async tx => {
        const next: MainUpdateCommand = { attempt, state, messageId }
        if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
      })
      if (!await isCurrent()) { await record('discarded'); return }
      let answer: string | undefined
      if ((await this.sessions!.hasMessage(binding.mainSessionId, messageId)).found) {
        const turn = await this.readTurn(binding, messageId)
        answer = turn.answer
        if (!answer && turn.ended) { await record('failed'); throw new CoreError('MAIN_UPDATE_FAILED', 'Main ended this notification without a visible reply.') }
        if (!answer) throw new CoreError('MAIN_TURN_UNKNOWN', 'The original Main update turn needs reconciliation.')
      } else {
        const prepared = await this.prepare?.(binding.mainSessionId)
        if (!await isCurrent()) { await record('discarded'); return }
        signal.throwIfAborted()
        await record('running')
        try {
          const result = await this.sessions!.run({ role: 'main', sessionId: binding.mainSessionId, messageId, tools: [], signal,
            text: `[Work update]\nThis is a bounded Router notification, not a new user request. Explain the receipt or result briefly. Do not claim more than its evidence.\n${JSON.stringify(notification)}`,
            ...(prepared ? { profile: prepared.profile } : {}) })
          answer = this.reply(result.events as MainEvent[], messageId)
        } catch (error) {
          const turn = await this.readTurn(binding, messageId)
          if (!turn.ended) throw error
          answer = turn.answer
        }
        if (!answer) { await record('failed'); throw new CoreError('MAIN_UPDATE_FAILED', 'Main ended this notification without a visible reply.') }
      }
      if (!await isCurrent()) { await record('discarded'); return }
      await this.publishUpdateReply(key, messageId, answer, attempt, isCurrent)
    }).finally(() => { this.pendingTurns-- })
    this.tail = turn.catch(() => {})
    return turn
  }

  private publishUpdateReply(key: string, messageId: string, answer: string, attempt: number,
    isCurrent: (transaction?: AsyncTx) => Promise<boolean>) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      if ((await tx.get<MainUpdateCommand>('main-update-command', key))?.state === 'completed') return
      const current = await isCurrent(tx)
      const state = await this.state(tx)
      const sequence = state.sequence + 1
      if (current) await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: `reply:${messageId}`, sequence,
        role: 'main', text: answer, createdAt: Date.now(), status: 'completed' })
      const next: MainUpdateCommand = { messageId, sequence, attempt, state: current ? 'completed' : 'discarded' }
      if (current) await tx.replace('main-state', 'main', { ...state, sequence })
      if (!await tx.replace('main-update-command', key, next)) await tx.insert('main-update-command', key, next)
    })
  }

  private reply(events: readonly MainEvent[], messageId: string) {
    const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
    if (start < 0) return undefined
    const following = events.slice(start + 1)
    const end = following.findIndex(event => event.type === 'turn/end')
    if (end < 0 || following[end]?.data.reason?.kind !== 'completed') return undefined
    const answer = following.slice(0, end).filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    return answer.trim() ? answer : undefined
  }

  private async reconcile(binding: MainBinding, key: string) {
    const command = await commandTransaction(this.storage, this.instanceId, tx => tx.get<MainCommand>('main-command', key))
    if (!command || command.status === 'completed') return command?.status === 'completed'
    if (!this.sessions || !(await this.sessions.hasMessage(binding.mainSessionId, command.messageId)).found) return false
    const answer = await this.readReply(binding, command.messageId)
    if (answer) { await this.publish(key, answer); return true }
    return false
  }

  private async readReply(binding: MainBinding, messageId: string) {
    return (await this.readTurn(binding, messageId)).answer
  }

  private async readTurn(binding: MainBinding, messageId: string): Promise<{ answer?: string; ended: boolean }> {
    if (!this.sessions) return { ended: false }
    const events: MainEvent[] = []
    let after: number | undefined
    for (let count = 0; count < 100; count++) {
      const page = await this.sessions.readSession(binding.mainSessionId, { limit: 100, ...(after === undefined ? {} : { after }) })
      events.push(...page.events as unknown as MainEvent[])
      const answer = this.reply(events, messageId)
      if (answer) return { answer, ended: true }
      const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
      if (start >= 0 && events.slice(start + 1).some(event => event.type === 'turn/end')) return { ended: true }
      if (page.cursor === undefined) return { ended: false }
      after = page.cursor
    }
    throw new CoreError('MAIN_HISTORY_BUDGET', 'Main history reconciliation exceeded its bounded read budget.')
  }

  private publish(key: string, answer: string) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const prior = await tx.get<MainCommand>('main-command', key)
      if (!prior || prior.status === 'completed') return
      const state = await this.state(tx)
      const sequence = state.sequence + 1
      await tx.insert<MainMessage>('main-message', messageKey(sequence), { id: `reply:${prior.messageId}`, sequence, role: 'main', text: answer, createdAt: Date.now(), status: 'completed' })
      await tx.replace('main-state', 'main', { ...state, sequence })
      await this.updateCommandIn(tx, key, { ...prior, status: 'completed', replySequence: sequence })
    })
  }

  private async updateCommandIn(tx: AsyncTx, key: string, command: MainCommand, error?: string) {
    await tx.replace('main-command', key, command)
    const message = await tx.get<MainMessage>('main-message', messageKey(command.userSequence))
    if (message) await tx.replace('main-message', messageKey(command.userSequence), { ...message, status: command.status, ...(error ? { error } : {}) })
    const state = await this.state(tx)
    if (command.status === 'running') await tx.replace('main-state', 'main', { ...state, activeCommand: key })
    else if (state.activeCommand === key && command.status === 'completed') {
      const { activeCommand: _active, ...settled } = state
      await tx.replace('main-state', 'main', settled)
    }
  }

  private updateCommand(key: string, status: MainCommand['status'], error?: string) {
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const command = await tx.get<MainCommand>('main-command', key)
      if (command && command.status !== 'completed') await this.updateCommandIn(tx, key, { ...command, status }, error)
    })
  }

  async close() { this.closed = true; await this.tail }
}
