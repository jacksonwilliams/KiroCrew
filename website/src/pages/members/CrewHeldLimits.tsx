/**
 * The Profile tab's "Asks you first" section: the limits a Bot's upgrade move could
 * not apply as written, which make it ask a person before the actions they cover,
 * and the one control that ends them all
 * (docs/decisions/2026-11-17-a-person-can-end-a-bots-held-limits-from-its-profile-tab.md).
 *
 * Shown only while one of them makes the Bot ask. A caller the owner gate refuses
 * (403) cannot release them, so it sees nothing. A limit's text is stored text,
 * rendered as a value.
 */
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MemberHeldLimit, type MemberRosterRow } from '../../api/client'
import { crewDisplayName } from '../../components/AgentSelector'
import { useConfirm } from '../../components/ConfirmDialog'
import ErrorNotice from '../../components/ErrorNotice'
import { Btn } from '../../components/ui'

/** What each capability covers; an unknown one covers every action. */
const COVERS: Record<string, string> = {
  shell: 'pages.membersPage.held_limits_cap_shell',
  fs_read: 'pages.membersPage.held_limits_cap_fs_read',
  fs_write: 'pages.membersPage.held_limits_cap_fs_write',
  web_fetch: 'pages.membersPage.held_limits_cap_web_fetch',
  web_search: 'pages.membersPage.held_limits_cap_web_search',
  subagent: 'pages.membersPage.held_limits_cap_subagent',
  mcp: 'pages.membersPage.held_limits_cap_mcp',
  none: 'pages.membersPage.held_limits_cap_none',
}
const EVERY_ACTION = 'pages.membersPage.held_limits_cap_any'

const status = (e: unknown): number | undefined => (e as { status?: number } | null)?.status

export default function CrewHeldLimits({ member }: { member: MemberRosterRow }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const queryKey = ['member-held-limits', member.slug, member.name]
  const held = useQuery({
    queryKey,
    queryFn: () => api.memberHeldLimits(member.slug, member.name),
  })
  const release = useMutation({
    mutationFn: (limits: MemberHeldLimit[]) => api.memberHeldLimitsRelease(member.slug, member.name, limits),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  if (held.isError) {
    if (status(held.error) === 403) return null
    return <ErrorNotice message={t('pages.membersPage.held_limits_load_failed')} askAgent testId="crew-held-limits-error" />
  }
  const limits = held.data?.limits ?? []
  if (!limits.some(l => l.capability !== 'none')) return null
  const readsOwnFolder = held.data?.kiro_cli && limits.some(l => l.capability === 'fs_read' || l.capability === '*')

  const onRelease = async () => {
    const ok = await confirm({
      title: t('pages.membersPage.held_limits_confirm_title'),
      body: (
        <>
          <p>{t('pages.membersPage.held_limits_confirm_body', { name: crewDisplayName(member) })}</p>
          <ul className="mt-2 list-disc pl-5" data-testid="crew-held-limits-confirm-list">
            {limits.map((l, i) => <li key={i}>{l.text}</li>)}
          </ul>
        </>
      ),
      confirmLabel: t('pages.membersPage.held_limits_confirm'),
      danger: true,
    })
    if (ok) release.mutate(limits)
  }

  return (
    <section className="rounded-2xl border border-border bg-bg px-3.5 py-3" data-testid="crew-held-limits">
      <div className="text-[11px] font-semibold tracking-wide uppercase text-muted mb-1">{t('pages.membersPage.held_limits_heading')}</div>
      <p className="text-[13px] leading-relaxed text-text">{t('pages.membersPage.held_limits_lead')}</p>
      {readsOwnFolder && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted" data-testid="crew-held-limits-kiro-cli">{t('pages.membersPage.held_limits_kiro_cli')}</p>
      )}
      <ul className="mt-2 flex flex-col gap-1.5">
        {limits.map((l, i) => (
          <li key={i} className="text-[13px] leading-snug" data-testid="crew-held-limit">
            <span className="text-text break-words">{l.text}</span>
            <span className="block text-[12px] text-muted">{t(Object.hasOwn(COVERS, l.capability) ? COVERS[l.capability] : EVERY_ACTION)}</span>
          </li>
        ))}
      </ul>
      {release.isError && (
        <div className="mt-2">
          <ErrorNotice
            message={t(status(release.error) === 409 ? 'pages.membersPage.held_limits_changed' : 'pages.membersPage.held_limits_release_failed')}
            askAgent
            testId="crew-held-limits-release-error"
          />
        </div>
      )}
      <Btn type="button" danger className="mt-2.5" onClick={() => void onRelease()} disabled={release.isPending} data-testid="crew-held-limits-release">
        {t('pages.membersPage.held_limits_release')}
      </Btn>
      {confirmDialog}
    </section>
  )
}
