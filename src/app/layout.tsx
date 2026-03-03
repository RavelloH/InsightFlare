import type { Metadata } from "next";
import "./globals.css";
import { JetBrains_Mono } from "next/font/google";

const jetbrainsMono = JetBrains_Mono({subsets:['latin'],variable:'--font-sans'});

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
