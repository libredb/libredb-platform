export interface SeedSharedQuery {
  tenantSlug: string
  createdByEmail: string
  connectionName: string
  name: string
  description: string
  sql: string
}

export const SHARED_QUERIES: SeedSharedQuery[] = [
  // Acme Corp
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'sarah.chen@acme.test',
    connectionName: 'Acme Production PG',
    name: 'Active Users Last 30 Days',
    description: 'Count of unique active users in the last 30 days, grouped by week.',
    sql: `SELECT
  date_trunc('week', last_login_at) AS week,
  COUNT(DISTINCT id) AS active_users
FROM users
WHERE last_login_at > now() - interval '30 days'
  AND active = true
GROUP BY 1
ORDER BY 1 DESC;`,
  },
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'james.wilson@acme.test',
    connectionName: 'Acme Analytics MySQL',
    name: 'Revenue by Product Category',
    description: 'Monthly revenue breakdown by product category for the current quarter.',
    sql: `SELECT
  p.category,
  DATE_FORMAT(o.created_at, '%Y-%m') AS month,
  SUM(oi.quantity * oi.unit_price) AS revenue
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
WHERE o.created_at >= DATE_FORMAT(CURDATE(), '%Y-01-01')
GROUP BY p.category, DATE_FORMAT(o.created_at, '%Y-%m')
ORDER BY month, revenue DESC;`,
  },
  {
    tenantSlug: 'acme-corp',
    createdByEmail: 'maria.garcia@acme.test',
    connectionName: 'Acme Staging PG',
    name: 'Table Size Report',
    description: 'Shows the size of all tables in the current database, sorted by total size.',
    sql: `SELECT
  schemaname || '.' || tablename AS table_name,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS data_size,
  pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
LIMIT 20;`,
  },
  // Startup Labs
  {
    tenantSlug: 'startup-labs',
    createdByEmail: 'tom.reed@startuplabs.test',
    connectionName: 'Startup Main PG',
    name: 'API Response Time P95',
    description: 'P95 response time per endpoint for the last 24 hours.',
    sql: `SELECT
  endpoint,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95_ms,
  COUNT(*) AS total_requests,
  AVG(response_time_ms)::int AS avg_ms
FROM api_logs
WHERE created_at > now() - interval '24 hours'
GROUP BY endpoint
ORDER BY p95_ms DESC;`,
  },
  {
    tenantSlug: 'startup-labs',
    createdByEmail: 'anna.white@startuplabs.test',
    connectionName: 'Startup Main PG',
    name: 'User Signup Funnel',
    description: 'Tracks user signup completion rates through each step.',
    sql: `SELECT
  step,
  COUNT(*) AS users,
  ROUND(COUNT(*)::numeric / FIRST_VALUE(COUNT(*)) OVER (ORDER BY step_order) * 100, 1) AS pct
FROM signup_events
WHERE created_at > now() - interval '30 days'
GROUP BY step, step_order
ORDER BY step_order;`,
  },
  // Solo Developer
  {
    tenantSlug: 'solo-developer',
    createdByEmail: 'dev@example.com',
    connectionName: 'Local Dev PG',
    name: 'Check Running Queries',
    description: 'Shows currently running queries with their duration and state.',
    sql: `SELECT
  pid,
  now() - pg_stat_activity.query_start AS duration,
  state,
  LEFT(query, 120) AS query_preview
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY duration DESC;`,
  },
]
