export interface SeedTicket {
  tenantSlug: string
  createdByEmail: string
  assignedToEmail?: string
  subject: string
  description: string
  status: string
  priority: string
  category: string
  daysAgo: number
  messages: {
    senderEmail: string
    content: string
    isInternal: boolean
    hoursAfterCreation: number
  }[]
}

export const TICKETS: SeedTicket[] = [
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'sarah.chen@acme.com',
    assignedToEmail: 'admin@libredb.example',
    subject: 'Cannot connect to production PostgreSQL',
    description: 'Getting timeout errors when trying to connect to our production PostgreSQL instance. The connection was working fine yesterday.',
    status: 'RESOLVED',
    priority: 'HIGH',
    category: 'TECHNICAL',
    daysAgo: 10,
    messages: [
      { senderEmail: 'sarah.chen@acme.com', content: 'Getting timeout errors when trying to connect to our production PostgreSQL instance. The connection was working fine yesterday.', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'admin@libredb.example', content: 'Can you confirm the host and port? Also, has your firewall configuration changed recently?', isInternal: false, hoursAfterCreation: 2 },
      { senderEmail: 'admin@libredb.example', content: 'Checking server logs: their IP might have been rotated by the cloud provider.', isInternal: true, hoursAfterCreation: 3 },
      { senderEmail: 'sarah.chen@acme.com', content: 'You were right, our cloud provider rotated the IP. Updated the connection and it works now. Thanks!', isInternal: false, hoursAfterCreation: 5 },
    ],
  },
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'james.wilson@acme.com',
    subject: 'Request for MongoDB query support',
    description: 'We need support for running aggregation pipelines on our MongoDB connection. Currently only simple find queries work.',
    status: 'OPEN',
    priority: 'MEDIUM',
    category: 'GENERAL',
    daysAgo: 5,
    messages: [
      { senderEmail: 'james.wilson@acme.com', content: 'We need support for running aggregation pipelines on our MongoDB connection. Currently only simple find queries work.', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'admin@libredb.example', content: 'Thanks for the feedback! MongoDB aggregation support is on our roadmap. We will keep you updated.', isInternal: false, hoursAfterCreation: 8 },
    ],
  },
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'maria.garcia@acme.com',
    assignedToEmail: 'devops@libredb.example',
    subject: 'Slow query execution on analytics database',
    description: 'Queries against the analytics MySQL database are taking 10x longer than usual. Possible index issue?',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    category: 'TECHNICAL',
    daysAgo: 2,
    messages: [
      { senderEmail: 'maria.garcia@acme.com', content: 'Queries against the analytics MySQL database are taking 10x longer than usual. Possible index issue?', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'devops@libredb.example', content: 'Looking into it. Can you share a specific query ID from the audit log so we can analyze the execution plan?', isInternal: false, hoursAfterCreation: 1 },
      { senderEmail: 'maria.garcia@acme.com', content: 'Sure, here are the slow queries from today: audit log IDs 42, 57, and 63.', isInternal: false, hoursAfterCreation: 3 },
    ],
  },
  {
    tenantSlug: 'startup-labs',
    createdByEmail: 'tom.reed@startuplabs.io',
    subject: 'How to upgrade from Team to Business plan?',
    description: 'We are growing and need more connections and advanced RBAC. How do we upgrade?',
    status: 'CLOSED',
    priority: 'LOW',
    category: 'BILLING',
    daysAgo: 12,
    messages: [
      { senderEmail: 'tom.reed@startuplabs.io', content: 'We are growing and need more connections and advanced RBAC. How do we upgrade?', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'admin@libredb.example', content: 'You can upgrade from Settings > Billing. Click "Change Plan" and select Business. Your billing will be prorated.', isInternal: false, hoursAfterCreation: 4 },
      { senderEmail: 'tom.reed@startuplabs.io', content: 'Found it, thanks! Upgrading now.', isInternal: false, hoursAfterCreation: 6 },
    ],
  },
  {
    tenantSlug: 'startup-labs',
    createdByEmail: 'anna.white@startuplabs.io',
    assignedToEmail: 'devops@libredb.example',
    subject: 'SSL certificate error on database connection',
    description: 'Getting SSL_ERROR_HANDSHAKE_FAILURE when connecting with SSL enabled. Our certs are valid.',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    category: 'TECHNICAL',
    daysAgo: 1,
    messages: [
      { senderEmail: 'anna.white@startuplabs.io', content: 'Getting SSL_ERROR_HANDSHAKE_FAILURE when connecting with SSL enabled. Our certs are valid.', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'devops@libredb.example', content: 'This might be a TLS version mismatch. Can you confirm your database server supports TLS 1.3?', isInternal: false, hoursAfterCreation: 3 },
    ],
  },
  {
    tenantSlug: 'solo-developer',
    createdByEmail: 'dev@example.com',
    subject: 'Feature request: dark mode for query editor',
    description: 'Would love to have a dark mode option for the query editor. My eyes thank you in advance!',
    status: 'OPEN',
    priority: 'LOW',
    category: 'GENERAL',
    daysAgo: 3,
    messages: [
      { senderEmail: 'dev@example.com', content: 'Would love to have a dark mode option for the query editor. My eyes thank you in advance!', isInternal: false, hoursAfterCreation: 0 },
      { senderEmail: 'admin@libredb.example', content: 'Great suggestion! Dark mode is already in our backlog. We will prioritize it for the next release.', isInternal: false, hoursAfterCreation: 12 },
    ],
  },
]
