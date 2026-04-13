import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import MobileNavProvider from "@/components/MobileNavProvider";
import Sidebar from "@/components/Sidebar";
import UnitsProvider from "@/components/UnitsProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ESPresense Hub",
  description: "Indoor positioning system using ESPresense nodes",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex">
        <UnitsProvider>
          <MobileNavProvider>
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              {children}
            </div>
          </MobileNavProvider>
        </UnitsProvider>
      </body>
    </html>
  );
}
