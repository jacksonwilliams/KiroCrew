/**
 * The app detail page's "Browsing sites" card: every page the app's own agent may
 * browse (the manifest's `permissions.browserSites` and the sites the owner added
 * from the app's own page), where each came from and where it stands, and a Remove
 * per site. Hidden while the list is empty.
 *
 * Adding a site is the app page's job (`useBrowserSites` in the app SDK), behind the
 * dashboard's own dialog; approving a declared one is the reconsent notice above. This
 * card only takes a site away, which ends it at the agent's next step. The change is
 * owner-only on the gateway (`POST /api/apps/{name}/browser-sites`).
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { AppBrowserSite, AppBrowserSites } from '../api/client/apps'
import { Btn, Card, CardTitle } from '../components/ui'
import ErrorNotice from '../components/ErrorNotice'
import { i18nT } from '../i18n/t'

const SOURCE_TEXT: Record<AppBrowserSite['source'], () => string> = {
  app: () => i18nT('pages.appDetailPage.browser_sites_source_app'),
  owner: () => i18nT('pages.appDetailPage.browser_sites_source_owner'),
}

const STATUS_TEXT: Record<AppBrowserSite['status'], () => string> = {
  approved: () => i18nT('pages.appDetailPage.browser_sites_status_approved'),
  pending: () => i18nT('pages.appDetailPage.browser_sites_status_pending'),
  disabled: () => i18nT('pages.appDetailPage.browser_sites_status_disabled'),
}

const STATUS_TONE: Record<AppBrowserSite['status'], string> = {
  approved: 'text-ok-text',
  pending: 'text-warn',
  disabled: 'text-muted',
}

export default function AppDetailBrowserSites({ appName, onChanged }: { appName: string; onChanged?: () => void }) {
  const queryClient = useQueryClient()
  const key = ['apps', appName, 'browser-sites']
  const list = useQuery<AppBrowserSites>({ queryKey: key, queryFn: () => api.getAppBrowserSites(appName) })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const sites = list.data?.sites ?? []
  if (list.isError) {
    const message = list.error instanceof Error ? list.error.message : String(list.error)
    return (
      <Card data-testid="app-browser-sites">
        <CardTitle>{i18nT('pages.appDetailPage.browser_sites_list_title')}</CardTitle>
        <ErrorNotice message={message} variant="inline" askAgent />
      </Card>
    )
  }
  if (sites.length === 0) return null

  const remove = async (site: string) => {
    setBusy(site)
    setError('')
    try {
      queryClient.setQueryData(key, await api.changeAppBrowserSite(appName, 'remove', site))
      // The reconsent notice reads the staged sites off the app row.
      onChanged?.()
    } catch (e) {
      setError(i18nT('pages.appDetailPage.browser_sites_remove_failed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card data-testid="app-browser-sites">
      <CardTitle>{i18nT('pages.appDetailPage.browser_sites_list_title')}</CardTitle>
      <div className="mt-1 text-[12px] text-muted">{i18nT('pages.appDetailPage.browser_sites_list_hint')}</div>
      <ul className="mt-2 grid gap-2">
        {sites.map(row => (
          <li key={row.site} className="grid gap-1 text-[13px]" data-testid="app-browser-site-row">
            <code className="w-fit max-w-full break-all bg-bg-elevated border border-border px-1.5 py-0.5 rounded text-[11px] text-text">{row.site}</code>
            <div className="flex items-center gap-2">
              <span className="text-muted">{SOURCE_TEXT[row.source]?.() ?? row.source}</span>
              <span className={STATUS_TONE[row.status] ?? 'text-muted'}>· {STATUS_TEXT[row.status]?.() ?? row.status}</span>
              <Btn className="ml-auto shrink-0" onClick={() => void remove(row.site)} disabled={busy !== null}>
                {i18nT('pages.appDetailPage.browser_sites_remove')}
              </Btn>
            </div>
          </li>
        ))}
      </ul>
      {error && <ErrorNotice message={error} variant="inline" askAgent />}
    </Card>
  )
}
