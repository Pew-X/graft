import type { Metadata } from "next";
import { Footer } from "../../../components/Footer.tsx";
import { ManagePublication } from "../../../components/ManagePublication.tsx";
import { apiUrls } from "../../../lib/api/server.ts";
import { copy } from "../../../lib/copy.ts";

export const metadata: Metadata = {
  title: copy.manage.title,
  robots: { index: false },
  // The address of this page holds only a public id, never a key.
  referrer: "no-referrer",
};

// The browser's address for the service is read when the request arrives.
export const dynamic = "force-dynamic";

export default async function ManagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <main className="make">
        <p className="kicker">{copy.manage.title}</p>
        <ManagePublication id={id} apiUrl={apiUrls().browser} />
      </main>
      <Footer />
    </>
  );
}
