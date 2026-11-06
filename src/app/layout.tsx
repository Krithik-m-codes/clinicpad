import type { Metadata } from "next";
import { Geist, Geist_Mono, Poppins } from "next/font/google";
import "./globals.css";
import { PrescriptionProvider } from "@/contexts/PrescriptionContext";
import Header from "@/components/layout/Header";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ClinicPad — Your pad, digitised",
  description:
    "Prescription-first clinic software that uses your own pad and works when the internet doesn't.",
  applicationName: "ClinicPad",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${poppins.variable} antialiased font-poppins`}
      >
        <PrescriptionProvider>
          <Header />
          <main className="pt-10 md:pt-14 lg:pt-18 bg-[var(--secondary-color)] ">{children}</main>
        </PrescriptionProvider>
      </body>
    </html>
  );
}
