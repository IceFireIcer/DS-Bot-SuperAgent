import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatRows } from './cells.js'
import { MainComposer } from './composer.js'
import { BrandMark } from './sidebar.js'
import { createSource } from './sources.js'
import { installLocale, t } from './i18n.js'
import { allThemes, themeCss } from './themes.js'
import { SHELL_CSS, CONVERSATION_CSS, installCompiledStyles, installStyles } from './styles.js'

export async function productCall(endpoint, payload = {}) {
  const response = await fetch('api/product', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  let result
  try { result = await response.json() } catch { throw new Error(t('Could not reach Main. Check that the app is running.')) }
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? t('Main is unavailable.')), { code: result.error?.code })
  return result.value
}

export function applyProduct(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'superagent: interface copy')
  const view = createSource({ binding: null, messages: [], works: [], error: null })
  const useView = () => useSyncExternalStore(view.subscribe, view.getSnapshot)
  let stopped = false
  const refresh = async () => {
    try {
      const binding = view.getSnapshot().binding ?? await productCall('open')
      const messages = []
      let works = []
      let after
      do {
        const page = await productCall('history', { instanceId: binding.instanceId, limit: 100, ...(after === undefined ? {} : { after }) })
        messages.push(...page.messages)
        if (after === undefined) works = page.works ?? []
        after = page.cursor
      } while (after !== undefined && !stopped)
      if (!stopped) view.set({ binding, messages, works, error: null })
    } catch (error) { if (!stopped) view.set(state => ({ ...state, error: error.message })) }
  }
  ctx.effect(() => {
    let timer
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 750) }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, 'superagent: follow the shared Main')
  const emptyRoster = { bots: [], byId: {}, roomsById: {}, prefs: {} }
  const statusCopy = status => ({ routing: t('Routing work'), pending: t('Pending work'), running: t('Running work'),
    waiting: t('Waiting for an answer'), blocked: t('Blocked work'), stopped: t('Stopped work'), success: t('Work complete'),
    failed: t('Work failed'), rejected: t('Work declined'), unknown: t('Work result unknown') })[status] ?? status
  const receiptCopy = status => ({ routing: t('Router is routing'), accepted: t('Accepted by Router'), rejected: t('Not accepted') })[status] ?? status
  function MainWorkCard({ work }) {
    return h('article', { className: 'bt-main-work', 'aria-label': t('Work item: {goal}', { goal: work.brief.goal }) },
      h('div', { className: 'bt-main-work-head' }, h('strong', null, work.brief.goal),
        h('span', { className: 'bt-main-work-status', role: 'status' }, statusCopy(work.status))),
      h('p', { className: 'bt-main-work-id' }, `${t('Work brief')} ${work.brief.id}`),
      h('p', { className: 'bt-main-work-id' }, `${t('Receipt')}: ${receiptCopy(work.receipt.status)}`),
      work.receipt.ticketId ? h('p', { className: 'bt-main-work-id' }, `${t('Ticket')} ${work.receipt.ticketId}`) : null,
      work.receipt.reason ? h('p', { className: 'bt-main-error' }, `${t('Work receipt')}: ${work.receipt.reason}`) : null,
      work.receipt.status === 'routing' ? h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.receipt.nextStep}`) : null,
      h('p', { className: 'bt-main-work-detail' }, `${t('Constraints')}: ${work.brief.constraints}`),
      h('p', { className: 'bt-main-work-detail' }, `${t('Acceptance criteria')}: ${work.brief.acceptanceCriteria}`),
      work.outcome ? h('div', { className: 'bt-main-work-result' },
        h('p', null, work.outcome.summary), h('p', { className: 'bt-main-work-detail' }, `${t('Verification')}: ${work.outcome.evidence}`),
        h('p', { className: 'bt-main-work-detail' }, `${t('Next step')}: ${work.outcome.nextStep}`),
        work.outcome.artifacts.map(artifact => h('p', { key: artifact.path, className: 'bt-main-work-artifact' },
          h('code', null, artifact.path), ' ', h('span', null, `${artifact.bytes} ${t('bytes')} · ${artifact.sha256.slice(0, 12)}`)))) : null)
  }
  function MainConversation() {
    const state = useView()
    const [sending, setSending] = useState(false)
    const [sendError, setSendError] = useState(null)
    const bottom = useRef(null)
    const pending = useRef(null)
    const scroll = useRef(null)
    const follow = useRef(true)
    useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' }) }, [state.messages.length])
    const send = async text => {
      if (!state.binding) return false
      const storageKey = `superagent:pending:${state.binding.instanceId}`
      try {
        setSending(true); setSendError(null)
        if (!pending.current) {
          try { pending.current = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') } catch { /* Draft storage is optional. */ }
        }
        if (!pending.current || pending.current.text !== text) pending.current = { commandId: crypto.randomUUID(), text }
        try { sessionStorage.setItem(storageKey, JSON.stringify(pending.current)) } catch { /* The stable identity still lives until this window closes. */ }
        const result = await productCall('send', { instanceId: state.binding.instanceId, ...pending.current })
        pending.current = null
        try { sessionStorage.removeItem(storageKey) } catch { /* Draft storage is optional. */ }
        await refresh()
        if (result.status === 'failed') { setSendError(t('Main could not finish this reply. Your message is saved.')); return false }
        return true
      } catch (error) { setSendError(error.message); await refresh(); return false }
      finally { setSending(false) }
    }
    const busy = sending || state.messages.some(message => message.status === 'running' || message.status === 'queued')
    return h('section', { className: 'bt-main-conversation', 'aria-label': 'Main' },
      h('header', { className: 'bt-main-header' }, h(BrandMark, { size: 28 }), h('span', null, 'Main')),
      h('div', { className: 'bt-main-history', ref: scroll, onScroll: () => { const node = scroll.current; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 } },
        h('div', { className: 'bt-main-messages' },
          state.messages.length === 0 ? h('p', { className: 'bt-main-empty' }, t('What would you like to discuss?')) : null,
          state.messages.map(message => h('div', { key: message.id },
            h(ChatRows, { items: [{ kind: message.role === 'main' ? 'bot' : 'user', text: message.text, time: message.createdAt }], sessionId: 'main', roster: emptyRoster, actions: {} }),
            message.status === 'failed' ? h('p', { className: 'bt-main-error', role: 'status' }, t('Main could not finish this reply. Your message is saved.')) : null)),
          state.works.map(work => h(MainWorkCard, { key: work.brief.workItemId ?? work.brief.id, work })),
          busy ? h('p', { className: 'bt-main-status', role: 'status' }, t('Main is replying…')) : null,
          h('div', { ref: bottom }))),
      h(MainComposer, { onSend: send, busy: sending || !state.binding, error: sendError ?? state.error }))
  }
  function MainNavigation() { return h('nav', { className: 'bt-main-nav', 'aria-label': t('Conversations') }, h('button', { type: 'button', className: 'bt-soft', 'aria-current': 'page', onClick: () => document.getElementById('main-message')?.focus() }, h(BrandMark, { size: 24 }), 'Main')) }
  const shadow = (name, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -200 }, component))
  ctx.effect(() => installCompiledStyles(SHELL_CSS + CONVERSATION_CSS + PRODUCT_CSS, 'main'), 'superagent: existing chat styles')
  ctx.effect(() => { const style = installStyles(themeCss(allThemes().deepseek), 'main-theme'); return () => style.remove() }, 'superagent: existing theme')
  shadow('main.conversation', MainConversation)
  shadow('sidebar.workspaces', MainNavigation)
  shadow('sidebar.brand.name', () => h('span', null, 'DS-SuperAgent'))
  shadow('sidebar.brand.mark', BrandMark)
}

const PRODUCT_CSS = `
.bt-main-conversation{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-main-header{height:56px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:.5px solid var(--bt-line-2);font-size:15px;font-weight:600}
.bt-main-history{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px}
.bt-main-messages{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.bt-main-composer{width:min(800px,100% - 32px);margin:16px auto 20px;padding:12px;border:1px solid var(--bt-line);border-radius:16px;background:var(--bt-card)}
.bt-main-composer textarea{display:block;width:100%;resize:vertical;min-height:80px;max-height:200px;padding:4px;border:0;background:transparent;color:var(--bt-ink);font:inherit;font-size:14px;line-height:22px;box-sizing:border-box}
.bt-main-composer textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-main-send{display:flex;justify-content:flex-end;margin-top:8px}
.bt-main-send button{height:36px;min-width:64px}
.bt-main-label{display:block;margin:0 0 6px;font-size:12px;color:var(--bt-ink-2)}
.bt-main-empty{margin:48px 0;color:var(--bt-ink-2);font-size:14px;line-height:22px;text-align:center}
.bt-main-error{margin:8px 0;color:var(--bt-danger);font-size:13px;line-height:18px}
.bt-main-status{color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-main-work{max-width:800px;margin:0 auto;width:calc(100% - 32px);padding:12px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);box-sizing:border-box}
.bt-main-work-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;color:var(--bt-ink);font-size:14px;line-height:20px}
.bt-main-work-head strong{min-width:0;overflow-wrap:anywhere;font-weight:600}
.bt-main-work-status{flex:none;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-main-work-id,.bt-main-work-detail,.bt-main-work-artifact{margin:6px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-main-work-result{margin-top:8px;padding-top:8px;border-top:.5px solid var(--bt-line-2);color:var(--bt-ink);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-main-work-result p{margin:0 0 6px}.bt-main-work-result p:last-child{margin-bottom:0}
.bt-main-work-artifact code{font:inherit;color:var(--bt-ink)}
.bt-main-nav{padding:12px}.bt-main-nav button{width:100%;display:flex;align-items:center;gap:10px;justify-content:flex-start;min-height:40px}
@media(max-width:640px){.bt-main-history{padding:16px}.bt-main-header{padding:0 16px}}
`
