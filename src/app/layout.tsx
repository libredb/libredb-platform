import type { Metadata } from 'next'
import { Geist, Geist_Mono, Inter } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'
import { QueryProvider } from '@/shared/providers/query-provider'
import { ThemeProvider } from '@/shared/providers/theme-provider'
import { Toaster } from 'sonner'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'LibreDB Platform',
  description: 'Database Access Governance Platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} min-h-screen bg-background font-sans antialiased`}>
        <SessionProvider>
          <QueryProvider>
            <ThemeProvider>
              {children}
              <Toaster />
            </ThemeProvider>
          </QueryProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
