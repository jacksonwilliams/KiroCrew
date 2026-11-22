/**
 * Screenshot harness for the owner's edits of an app's browsing sites.
 *
 * Runs the REAL built SPA behind the shared `serveDist` server and answers every
 * /api/** call from fixtures through `stubDashboardApi`. No gateway, no dashboard
 * auth, no kiro-cli.
 *
 * The app's page is a stand-in bundle that calls the SDK's `useBrowserSites()`: it
 * lists the sites and has an "Add site" button that calls `requestAdd`. The harness
 * asserts that the click raises the dashboard's own dialog naming the site, that
 * nothing is posted before Allow, and that Allow posts exactly `{action: 'add', site}`.
 * Then the app detail page's "Browsing sites" card lists every site with its source
 * and status. Light and dark, wide and narrow.
 *
 * Usage: node scripts/capture-app-browser-sites-owner.mjs [outDir] [--dist=path]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

import { json } from './lib/boot-api.mjs'
import { serveDist, DEFAULT_DIST } from './lib/serve-dist.mjs'
import { stubDashboardApi } from './lib/stub-dashboard-api.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const OUT = args.find(a => !a.startsWith('--')) || '/tmp/app-browser-sites-owner-shots'
const DIST = flag('dist', DEFAULT_DIST)
mkdirSync(OUT, { recursive: true })

const APP = 'mood-music'
const ADDED = 'https://music.example.net/song/*'
const START = [
  { site: 'https://www.youtube.com/watch', source: 'app', status: 'approved' },
  { site: 'https://www.bilibili.com/video/*', source: 'app', status: 'disabled' },
]

const installedApp = () => ({
  name: APP, displayName: 'Mood Music', version: '0.3.0', enabled: true,
  installedAt: '2026-11-17T10:00:00Z', origin: 'registry',
  resources: 'gateway', lifecycle: 'gateway',
  browserSitesGrant: { approved: [START[0].site, START[1].site], staged: [] },
  manifest: {
    name: APP, version: '0.3.0', displayName: 'Mood Music',
    description: 'Music picks for how you feel.',
    author: 'iamwhatever', tags: ['music'],
    permissions: { api: ['/api/browser/media'], browserSites: [START[0].site, START[1].site] },
    ui: { entry: 'index.js', pages: [{ route: `/${APP}`, label: 'Mood Music' }] },
  },
})

// A stand-in app page: the list and one button, through the host's shared modules.
const BUNDLE = `
const React = window.__kirocrew_modules.react
const sdk = window.__kirocrew_modules['@kirocrew/app-sdk']
const h = React.createElement
export default function App() {
  const s = sdk.useBrowserSites()
  const [said, setSaid] = React.useState('')
  return h('div', { style: { padding: 24, display: 'grid', gap: 12, maxWidth: 640 } },
    h('h2', { style: { fontSize: 18, fontWeight: 600 } }, 'Sites'),
    h('ul', { 'data-testid': 'app-sites' }, (s.sites || []).map(r =>
      h('li', { key: r.site, style: { fontFamily: 'monospace', fontSize: 13 } }, r.site + ' (' + r.source + ', ' + r.status + ')'))),
    h('button', { 'data-testid': 'app-add-site', style: { padding: '6px 12px', border: '1px solid currentColor', borderRadius: 6, width: 'fit-content' },
      onClick: async () => { const r = await s.requestAdd(${JSON.stringify(ADDED)}); setSaid(r.ok ? 'added' : r.code) } }, 'Add site'),
    h('div', { 'data-testid': 'app-said' }, said))
}
`

const { srv, base } = await serveDist(DIST)
const browser = await chromium.launch()

function fail(msg) { throw new Error(`ASSERTION FAILED: ${msg}`) }

async function shoot(mode, width, height, label) {
  let sites = START.map(r => ({ ...r }))
  const posts = []
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, serviceWorkers: 'block', colorScheme: mode,
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  page.on('pageerror', err => console.log('PAGEERROR:', (err.stack || String(err)).slice(0, 600)))
  await stubDashboardApi(page, {
    theme: mode,
    localStorageEntries: { 'mc-onboarded': '1', 'mc-theme-mode': mode },
    extra: async (path, route) => {
      if (path === `/api/apps/${APP}/browser-sites`) {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON()
          posts.push(body)
          if (body.action === 'add') sites = [...sites, { site: body.site, source: 'owner', status: 'approved' }]
          if (body.action === 'remove') sites = sites.filter(r => r.site !== body.site)
        }
        return json(route, { sites, active: sites.filter(r => r.status === 'approved').map(r => r.site) }), true
      }
      if (path === '/api/apps/registry') return json(route, { apps: [], serverPlatform: { os: 'linux', arch: 'x86_64' } }), true
      if (path === '/api/apps/registries') return json(route, { registries: [] }), true
      if (path === `/api/apps/${APP}`) return json(route, installedApp()), true
      if (path === '/api/apps') return json(route, [installedApp()]), true
      if (path === '/api/source/contributors') return json(route, { contributors: [] }), true
      return false
    },
  })
  await page.route(`**/apps/${APP}/ui/index.js`, route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: BUNDLE,
  }))

  // The app's own page asks to add a site: the dashboard draws the dialog.
  await page.goto(`${base}/apps/${APP}`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('app-sites').locator('li').first().waitFor({ timeout: 15000 })
  await page.getByTestId('app-add-site').click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 10000 })
  if ((await dialog.getByTestId('browser-site-add-site').textContent()) !== ADDED) fail('the dialog does not name the site')
  if (!(await dialog.textContent()).includes('signed in as you')) fail('the dialog does not say what the agent may do')
  if (posts.length !== 0) fail('something was posted before Allow')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/add-dialog-${label}-${mode}.png`, fullPage: false })
  console.log(`wrote ${OUT}/add-dialog-${label}-${mode}.png`)
  await dialog.getByRole('button', { name: 'Allow site' }).click()
  await page.getByTestId('app-said').getByText('added').waitFor({ timeout: 10000 })
  if (JSON.stringify(posts) !== JSON.stringify([{ action: 'add', site: ADDED }])) fail(`posted ${JSON.stringify(posts)}`)

  // The detail page's card: every site, its source and status, and Remove.
  await page.goto(`${base}/apps/detail/${APP}`, { waitUntil: 'domcontentloaded' })
  const card = page.getByTestId('app-browser-sites')
  await card.waitFor({ timeout: 15000 })
  if (await card.getByTestId('app-browser-site-row').count() !== 3) fail('the card does not list three sites')
  if (await card.getByText('Added by you').count() !== 1) fail('the added site is not marked as the owner\'s')
  if (await card.getByText(/Turned off/).count() !== 1) fail('the turned-off site is not marked')
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/detail-card-${label}-${mode}.png`, fullPage: false })
  console.log(`wrote ${OUT}/detail-card-${label}-${mode}.png`)
  await context.close()
}

for (const mode of ['light', 'dark']) {
  await shoot(mode, 1400, 1000, 'wide')
  await shoot(mode, 420, 900, 'narrow')
}
console.log('OK dialog before add, add posted only after Allow, detail card rows, light and dark, wide and narrow')

await browser.close()
srv.close()
