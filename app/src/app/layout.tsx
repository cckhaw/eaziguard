import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "eaziguard",
  description: "Early-warning health dashboard for the campus network",
  robots: { index: false, follow: false },
  // "Add to Home Screen" on iPhone/iPad opens it full screen like an app (Apple HIG: shed the browser wrapper).
  appleWebApp: { capable: true, title: "eaziguard", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // lets content run edge to edge; safe-area insets keep controls clear of the notch and home indicator
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
