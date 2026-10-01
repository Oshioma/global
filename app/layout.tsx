import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';
import { SetYourCity } from '@/components/SetYourCity';
import { ConfirmYourEmail } from '@/components/auth/ConfirmYourEmail';
import { FormDrafts } from '@/components/FormDrafts';
import { getCurrentMember } from '@/lib/auth';
import { SITE_URL, organisationSchema } from '@/lib/seo';

// The site's own metadata, and the template every page title hangs off.
//
// `template` is the piece that was missing: a page setting its own title used
// to replace this one entirely, and a page setting none inherited the bare
// word "Guestlist". Now a night is "Sunfall — Brockwell Park, Sat 12 Jul ·
// Guestlist" and the brand rides along without being written out each time.
//
// metadataBase makes every relative image in an og: tag absolute, which is
// the difference between a link preview showing the flyer and showing nothing.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Guestlist — what\u2019s on tonight', template: '%s · Guestlist' },
  description:
    'Guestlist — curated events, nights and experiences for the generation that grew up on rave culture.',
  alternates: { canonical: '/' },
  openGraph: {
    siteName: 'Guestlist',
    type: 'website',
    url: SITE_URL,
    title: 'Guestlist — what\u2019s on tonight',
    description:
      'Curated events, nights and experiences for the generation that grew up on rave culture.',
  },
  twitter: { card: 'summary_large_image' },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Theme is a per-visitor choice (cookie) so the server renders the right
  // palette with no flash. Light is the default; dark is the original look.
  const theme = (await cookies()).get('gl_theme')?.value === 'dark' ? 'dark' : undefined;
  // The footer belongs to the site, not to the homepage. Somebody thinking
  // "you're missing a night" is rarely on the front page when they think it.
  const member = await getCurrentMember().catch(() => null);
  return (
    <html lang="en" data-theme={theme}>
      <body>
        {/* The site itself, once, so a search for the name shows the name and
            a search box rather than a bare link. */}
        <script type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organisationSchema()) }}/>
        <SiteHeader />
        {/* A member with no resolved place is, to Guestlist, nowhere. Asked
            once a visit until they answer — see components/SetYourCity. */}
        {member && !member.home_location_id && <SetYourCity />}
        {/* An unproved address is not a locked account — they can use
            everything. It is a profile nobody else can find yet, and that is
            what the ask explains. */}
        {member && !member.email_verified_at && <ConfirmYourEmail />}
        {children}
        {/* Every form on the site survives a refresh — see components/FormDrafts. */}
        <FormDrafts />
        <SiteFooter isSignedIn={!!member} isAdmin={member?.role === 'admin'} />
      </body>
    </html>
  );
}
