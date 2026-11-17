import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '../../test/helpers'
import type { MemberRosterRow } from '../../api/client'

const memberHeldLimits = vi.fn()
const memberHeldLimitsRelease = vi.fn()

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: {
      memberHeldLimits: (...a: unknown[]) => memberHeldLimits(...a),
      memberHeldLimitsRelease: (...a: unknown[]) => memberHeldLimitsRelease(...a),
    },
  }
})

import CrewHeldLimits from './CrewHeldLimits'

const member = { name: 'helper', slug: 'helper-id', display_name: 'Helper' } as unknown as MemberRosterRow
const SHELL = { text: 'deny shell commands', capability: 'shell' }
const HOOK = { text: 'the agentSpawn hook', capability: 'none' }
const KEY = ['member-held-limits', 'helper-id', 'helper']
const refusal = (status: number) => Object.assign(new Error('refused'), { status })

beforeEach(() => {
  memberHeldLimits.mockReset()
  memberHeldLimitsRelease.mockReset()
})

describe('CrewHeldLimits (the "Asks you first" section)', () => {
  it('renders nothing while no held limit makes the bot ask', async () => {
    memberHeldLimits.mockResolvedValue({ limits: [HOOK], kiro_cli: true })
    const { container, queryClient } = renderWithProviders(<CrewHeldLimits member={member} />)
    await waitFor(() => expect(queryClient.getQueryState(KEY)?.status).toBe('success'))
    expect(memberHeldLimits).toHaveBeenCalledWith('helper-id', 'helper')
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a caller the owner gate refuses', async () => {
    memberHeldLimits.mockRejectedValue(refusal(403))
    const { container, queryClient } = renderWithProviders(<CrewHeldLimits member={member} />)
    await waitFor(() => expect(queryClient.getQueryState(KEY)?.status).toBe('error'))
    expect(container).toBeEmptyDOMElement()
  })

  it('says a read that failed otherwise', async () => {
    memberHeldLimits.mockRejectedValue(refusal(500))
    renderWithProviders(<CrewHeldLimits member={member} />)
    expect(await screen.findByTestId('crew-held-limits-error')).toHaveTextContent('The held limits could not be read.')
  })

  it('lists every limit with what it covers, under its heading', async () => {
    memberHeldLimits.mockResolvedValue({
      limits: [SHELL, HOOK, { text: 'an odd one', capability: 'something-new' }],
      kiro_cli: false,
    })
    renderWithProviders(<CrewHeldLimits member={member} />)
    const section = await screen.findByTestId('crew-held-limits')
    expect(section).toHaveTextContent('Asks you first')
    const rows = within(section).getAllByTestId('crew-held-limit').map(r => r.textContent)
    expect(rows).toEqual([
      'deny shell commandsShell commands',
      'the agentSpawn hookDoes not run on its worker',
      'an odd oneEvery action',
    ])
    expect(within(section).queryByTestId('crew-held-limits-kiro-cli')).toBeNull()
  })

  it.each([
    ['fs_read', true, true],
    ['*', true, true],
    ['shell', true, false],
    ['fs_read', false, false],
  ])('names Kiro CLI\'s own-folder reads for a %s limit only on Kiro CLI (kiro_cli=%s)', async (capability, kiroCli, shown) => {
    memberHeldLimits.mockResolvedValue({ limits: [{ text: 'a limit', capability }], kiro_cli: kiroCli })
    renderWithProviders(<CrewHeldLimits member={member} />)
    await screen.findByTestId('crew-held-limits')
    expect(screen.queryByTestId('crew-held-limits-kiro-cli') !== null).toBe(shown)
  })

  it('confirms naming every limit, then posts exactly the listed limits', async () => {
    const limits = [SHELL, HOOK]
    memberHeldLimits.mockResolvedValueOnce({ limits, kiro_cli: false }).mockResolvedValue({ limits: [], kiro_cli: false })
    memberHeldLimitsRelease.mockResolvedValue({ released: limits })
    renderWithProviders(<CrewHeldLimits member={member} />)
    fireEvent.click(await screen.findByTestId('crew-held-limits-release'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Stop asking for these limits?')
    expect(dialog).toHaveTextContent('“Helper” will stop asking you before the actions these limits cover.')
    expect(within(dialog).getAllByRole('listitem').map(li => li.textContent)).toEqual([SHELL.text, HOOK.text])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop asking' }))

    await waitFor(() => expect(memberHeldLimitsRelease).toHaveBeenCalledWith('helper-id', 'helper', limits))
    await waitFor(() => expect(screen.queryByTestId('crew-held-limits')).toBeNull())
  })

  it('says the limits changed when the release is refused with 409', async () => {
    memberHeldLimits.mockResolvedValue({ limits: [SHELL], kiro_cli: false })
    memberHeldLimitsRelease.mockRejectedValue(refusal(409))
    renderWithProviders(<CrewHeldLimits member={member} />)
    fireEvent.click(await screen.findByTestId('crew-held-limits-release'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop asking' }))

    expect(await screen.findByTestId('crew-held-limits-release-error')).toHaveTextContent(
      'These limits changed. Check the list and try again.',
    )
    expect(memberHeldLimits).toHaveBeenCalledTimes(2)
  })
})
