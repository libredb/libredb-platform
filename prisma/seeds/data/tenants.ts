export const TENANTS = [
  {
    name: 'Acme Corp',
    slug: 'acme-corp',
    planCode: 'BUSINESS',
    settings: { timezone: 'America/New_York', dateFormat: 'MM/DD/YYYY' },
  },
  {
    name: 'Startup Labs',
    slug: 'startup-labs',
    planCode: 'TEAM',
    settings: { timezone: 'America/Los_Angeles', dateFormat: 'YYYY-MM-DD' },
  },
  {
    name: 'Solo Developer',
    slug: 'solo-developer',
    planCode: 'FREE',
    settings: { timezone: 'Europe/London', dateFormat: 'DD/MM/YYYY' },
  },
] as const
