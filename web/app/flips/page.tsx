import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../../components/Footer.tsx";
import { YourFlips } from "../../components/YourFlips.tsx";
import { apiUrls } from "../../lib/api/server.ts";
import { copy } from "../../lib/copy.ts";

export const metadata: Metadata = {
  title: copy.flips.title,
  robots: { index: false },
  // The address of this page holds nothing: the list is read from this browser.
  referrer: "no-referrer",
};

// The browser's address for the service is read when the request arrives.
export const dynamic = "force-dynamic";

export default function FlipsPage() {
  return (
    <>
      <main className="make">
        <div className="make-bar">
          <Link href="/" className="back">
            {copy.make.home}
          </Link>
          <p className="kicker">{copy.flips.title}</p>
        </div>
        <YourFlips apiUrl={apiUrls().browser} />
      </main>
      <Footer />
    </>
  );
}
