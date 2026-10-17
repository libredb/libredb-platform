'use client'

export function InboxLayout({
  sidebar, list, detail,
}: { sidebar: React.ReactNode; list: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0">
      <aside className="w-[180px] shrink-0 overflow-y-auto border-r bg-card">{sidebar}</aside>
      <section className="w-[320px] shrink-0 overflow-y-auto border-r bg-background">{list}</section>
      <section className="flex min-w-0 flex-1 flex-col bg-background">{detail}</section>
    </div>
  )
}
