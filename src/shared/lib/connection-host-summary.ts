/**
 * The address a connection definition points at, for lists and the admin pages: `host[\instance][:port][/database or service]`.
 * It reads only the fields that are set, so it summarises a definition of any engine.
 * It lives in the kernel because both the connection pages and the tenant administration show it.
 */
export function hostSummary(definition: Readonly<Record<string, unknown>>): string {
  const field = (key: string) => (typeof definition[key] === 'string' ? (definition[key] as string) : undefined)
  const instance = field('instanceName')
  const target = field('serviceName') ?? field('database')
  return [
    field('host') ?? '',
    instance === undefined ? '' : `\\${instance}`,
    typeof definition.port === 'number' ? `:${definition.port}` : '',
    target === undefined ? '' : `/${target}`,
  ].join('')
}
