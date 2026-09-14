import type { Metadata } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import "./globals.css";

// Loaded through next/font so there is no flash of fallback type on a
// projector, where a reflow mid-talk is very visible.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Adaptive LLM Gateway",
  description:
    "Live routing dashboard - AWS Community Day CEE 2026",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-canvas font-body text-ink">{children}</body>
    </html>
  );
}
