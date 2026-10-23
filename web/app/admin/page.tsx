import type { Metadata } from "next";
import { AdminPanel } from "../../components/AdminPanel.tsx";
import { apiUrls } from "../../lib/api/server.ts";
import { copy } from "../../lib/copy.ts";

// For one person, behind a secret the service checks. Not for search engines, and not linked from
// anywhere on the site. The address of the service is read when the page is asked for.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: `${copy.site.name} ${copy.admin.title}`,
  robots: { index: false, follow: false, noarchive: true },
};

export default function AdminPage() {
  return (
    <>
      <header className="masthead">
        <h1>{copy.site.name}</h1>
      </header>
      <main className="admin">
        <AdminPanel apiUrl={apiUrls().browser} />
      </main>
    </>
  );
}
