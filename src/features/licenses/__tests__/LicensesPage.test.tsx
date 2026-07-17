import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import pkg from '../../../../package.json'
import { LicensesPage } from '../LicensesPage'
import { MAVLINK_MAPPINGS_VERSION, MIT_PACKAGES } from '../packages'

describe('LicensesPage', () => {
  it('discloses mavlink-mappings with the exact version pinned in package.json', () => {
    // The page hardcodes the version (importing package.json would bundle it);
    // this assertion is what keeps the two from drifting apart.
    expect(MAVLINK_MAPPINGS_VERSION).toBe(pkg.dependencies['mavlink-mappings'])

    render(<LicensesPage />)
    expect(screen.getByText('mavlink-mappings')).toBeInTheDocument()
    expect(screen.getByText(MAVLINK_MAPPINGS_VERSION)).toBeInTheDocument()
    expect(screen.getByText('GNU Lesser General Public License v3.0 (LGPL-3.0)')).toBeInTheDocument()
  })

  it('discloses every bundled runtime dependency — a new dependency must be added to the page', () => {
    const disclosed = ['mavlink-mappings', ...MIT_PACKAGES.map((p) => p.name)].sort()
    expect(disclosed).toEqual(Object.keys(pkg.dependencies).sort())
  })

  it('links the LGPL-3.0 license text and both ways to obtain the package source', () => {
    render(<LicensesPage />)
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://www.gnu.org/licenses/lgpl-3.0.html')
    expect(hrefs).toContain('https://github.com/padcom/mavlink-mappings')
    expect(hrefs).toContain(`https://www.npmjs.com/package/mavlink-mappings/v/${MAVLINK_MAPPINGS_VERSION}`)
  })
})
