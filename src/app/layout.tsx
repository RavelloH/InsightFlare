import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "InsightFlare API",
  description: "InsightFlare backend service",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
