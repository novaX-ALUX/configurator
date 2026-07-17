import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MAVLINK_MAPPINGS_VERSION, MIT_PACKAGES } from './packages'

/**
 * Static licenses / third-party notices page (issue #39). Satisfies the
 * obligation from docs/notes/decisions-m1.md Decision 3 LOCKED(a): the public
 * site must disclose the LGPL dependency `mavlink-mappings`, its license
 * terms, and how to obtain its source. Always reachable — no vehicle
 * connection required.
 */

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-nvx-primary underline underline-offset-2 hover:opacity-80">
      {children}
    </a>
  )
}

export function LicensesPage() {
  const { t } = useTranslation()

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="mx-auto max-w-[760px]">
        <h1 className="mb-1.5 font-heading text-[19px] font-bold text-nvx-text">{t('licenses.title')}</h1>
        <p className="mb-4 text-[13px] leading-relaxed text-nvx-muted">{t('licenses.intro')}</p>

        <section className="mb-4 rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <h2 className="mb-1.5 font-heading text-[15px] font-bold text-nvx-text">{t('licenses.app.title')}</h2>
          <p className="text-[13px] leading-relaxed text-nvx-muted">
            {t('licenses.app.body')}{' '}
            <ExtLink href="https://github.com/novaX-ALUX/configurator">{t('licenses.app.sourceLink')}</ExtLink>
          </p>
        </section>

        <section className="mb-4 rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <h2 className="mb-1.5 font-heading text-[15px] font-bold text-nvx-text">mavlink-mappings</h2>
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="font-semibold text-nvx-subtle">{t('licenses.mavlink.versionLabel')}</dt>
            <dd className="font-mono text-nvx-text">{MAVLINK_MAPPINGS_VERSION}</dd>
            <dt className="font-semibold text-nvx-subtle">{t('licenses.mavlink.licenseLabel')}</dt>
            <dd className="text-nvx-text">GNU Lesser General Public License v3.0 (LGPL-3.0)</dd>
          </dl>
          <p className="mb-2 text-[13px] leading-relaxed text-nvx-muted">{t('licenses.mavlink.usageNote')}</p>
          <p className="mb-3 text-[13px]">
            <ExtLink href="https://www.gnu.org/licenses/lgpl-3.0.html">{t('licenses.mavlink.licenseTextLink')}</ExtLink>
          </p>
          <h3 className="mb-1 text-[13px] font-bold text-nvx-text">{t('licenses.mavlink.obtainTitle')}</h3>
          <p className="mb-1.5 text-[13px] leading-relaxed text-nvx-muted">{t('licenses.mavlink.obtainBody')}</p>
          <ul className="list-disc pl-5 text-[13px] leading-relaxed">
            <li>
              <ExtLink href={`https://www.npmjs.com/package/mavlink-mappings/v/${MAVLINK_MAPPINGS_VERSION}`}>
                {t('licenses.mavlink.obtainNpm', { version: MAVLINK_MAPPINGS_VERSION })}
              </ExtLink>
            </li>
            <li>
              <ExtLink href="https://github.com/padcom/mavlink-mappings">{t('licenses.mavlink.obtainGithub')}</ExtLink>
            </li>
          </ul>
        </section>

        <section className="rounded-xl border border-nvx-border bg-nvx-surface p-4 shadow-card">
          <h2 className="mb-1.5 font-heading text-[15px] font-bold text-nvx-text">{t('licenses.others.title')}</h2>
          <p className="mb-1.5 text-[13px] leading-relaxed text-nvx-muted">{t('licenses.others.body')}</p>
          <ul className="list-disc pl-5 text-[13px] leading-relaxed">
            {MIT_PACKAGES.map((p) => (
              <li key={p.name}>
                <ExtLink href={p.url}>{p.name}</ExtLink>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
