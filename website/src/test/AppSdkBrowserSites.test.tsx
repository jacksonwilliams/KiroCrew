/**
 * The App SDK's `useBrowserSites`: an app page reads its own browsing list; adding a
 * site sends nothing until the owner presses Allow in the dashboard's own dialog;
 * removing and turning off a site apply at once. And the detail page's card lists the
 * sites with their source and status and removes one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import AppConfirmHost from '../components/AppConfirmHost'
import { AppApiProvider, useBrowserSites } from '../app-sdk/index'
import AppDetailBrowserSites from '../pages/AppDetailBrowserSites'
import { queryClient as dashboardQueryClient } from '../api/queryClient'
import { MemoryRouter } from 'react-router-dom'

const LIST = {
  sites: [
    { site: 'https://www.example.com/watch', source: 'app', status: 'approved' },
    { site: 'https://music.example.net/song/*', source: 'owner', status: 'disabled' },
  ],
  active: ['https://www.example.com/watch'],
}

let calls: { method: string; path: string; body?: unknown }[]
let postAnswer: () => Response

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  calls = []
  postAnswer = () => json(LIST)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return method === 'GET' ? json(LIST) : postAnswer()
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AppApiProvider, { appName: 'tunes', allowedApiPaths: [], allowedEvents: [] }, children)
  return renderHook(() => useBrowserSites(), { wrapper })
}

const posts = () => calls.filter(c => c.method === 'POST')

describe('useBrowserSites', () => {
  it("reads the app's own list with no declared api path", async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).toEqual(LIST.sites))
    expect(result.current.active).toEqual(LIST.active)
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/apps/tunes/browser-sites' })
  })

  it('sends an add only after the owner presses Allow in the dashboard dialog', async () => {
    render(<AppConfirmHost />)
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    let answer: Promise<unknown> | undefined
    act(() => { answer = result.current.requestAdd(' https://music.example.net/song/* ') })
    const dialog = await screen.findByRole('dialog')
    // The dialog names the site exactly, and what allowing it lets the agent do.
    expect(within(dialog).getByTestId('browser-site-add-site').textContent).toBe('https://music.example.net/song/*')
    expect(dialog.textContent).toContain('signed in as you')
    expect(posts()).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow site' }))
    let settled: unknown
    await act(async () => { settled = await answer })
    expect(settled).toMatchObject({ ok: true, active: LIST.active })
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/apps/tunes/browser-sites', body: { action: 'add', site: 'https://music.example.net/song/*' } },
    ])
  })

  it('a declined add sends nothing', async () => {
    render(<AppConfirmHost />)
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    let answer: Promise<unknown> | undefined
    act(() => { answer = result.current.requestAdd('https://music.example.net/song/*') })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    let settled: unknown
    await act(async () => { settled = await answer })
    expect(settled).toEqual({ ok: false, code: 'declined', error: 'the owner did not allow it' })
    expect(posts()).toEqual([])
  })

  it('an add with no dialog host sends nothing', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    let settled: unknown
    await act(async () => { settled = await result.current.requestAdd('https://music.example.net/song/*') })
    expect(settled).toMatchObject({ ok: false, code: 'declined' })
    expect(posts()).toEqual([])
  })

  it('remove and disable apply at once, with no dialog', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    await act(async () => { await result.current.requestDisable('https://www.example.com/watch') })
    await act(async () => { await result.current.requestRemove('https://www.example.com/watch') })
    expect(posts().map(c => c.body)).toEqual([
      { action: 'disable', site: 'https://www.example.com/watch' },
      { action: 'remove', site: 'https://www.example.com/watch' },
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("marks the detail page's cached list stale after a change", async () => {
    const spy = vi.spyOn(dashboardQueryClient, 'invalidateQueries')
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    await act(async () => { await result.current.requestRemove('https://www.example.com/watch') })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['apps', 'tunes', 'browser-sites'] })
    spy.mockRestore()
  })

  it("says the gateway's refusal by code", async () => {
    postAnswer = () => json({ code: 'not_listed', error: 'that site is not on this app\'s list' }, 404)
    const { result } = mount()
    await waitFor(() => expect(result.current.sites).not.toBeNull())
    let settled: unknown
    await act(async () => { settled = await result.current.requestRemove('https://other.example.net/a') })
    expect(settled).toEqual({ ok: false, code: 'not_listed', error: "that site is not on this app's list" })
  })
})

describe('AppDetailBrowserSites', () => {
  it('lists every site with its source and status and removes one', async () => {
    const changed = vi.fn()
    postAnswer = () => json({ sites: [LIST.sites[1]], active: [] })
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AppDetailBrowserSites appName="tunes" onChanged={changed} />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    const rows = await screen.findAllByTestId('app-browser-site-row')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('From the app'),
      expect.stringContaining('Added by you'),
    ])
    expect(rows[0].textContent).toContain('Allowed')
    expect(rows[1].textContent).toContain('Turned off')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getAllByTestId('app-browser-site-row')).toHaveLength(1))
    expect(posts().map(c => c.body)).toEqual([{ action: 'remove', site: 'https://www.example.com/watch' }])
    expect(changed).toHaveBeenCalled()
  })

  it('says so when the list cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'unreadable', error: "this app's site list could not be read" }, 500)))
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AppDetailBrowserSites appName="tunes" />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    const card = await screen.findByTestId('app-browser-sites')
    await waitFor(() => expect(card.textContent).toContain('could not be read'))
  })

  it('draws nothing while the list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ sites: [], active: [] })))
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AppDetailBrowserSites appName="tunes" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})
