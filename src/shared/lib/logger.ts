type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogFormat = 'json' | 'pretty'

interface LogContext {
  [key: string]: unknown
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'passwordencrypted',
  'token', 'secret', 'apikey', 'accesstoken', 'refreshtoken',
  'authorization', 'cookie', 'stripesecretkey',
  // The license token of a self-hosted install, under the name of its variable.
  'platform_license',
])

function sanitize(obj: LogContext): LogContext {
  const result: LogContext = {}
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]'
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error)) {
      result[key] = sanitize(value as LogContext)
    } else {
      result[key] = value
    }
  }
  return result
}

function formatJson(level: LogLevel, message: string, context: LogContext): string {
  return JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...sanitize(context),
  })
}

function formatPretty(level: LogLevel, message: string, context: LogContext): string {
  const color = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' }[level]
  const reset = '\x1b[0m'
  const ts = new Date().toISOString().slice(11, 23)
  const sanitized = sanitize(context)
  const ctx = Object.keys(sanitized).length > 0 ? ` ${JSON.stringify(sanitized)}` : ''
  return `${color}[${ts}] ${level.toUpperCase().padEnd(5)}${reset} ${message}${ctx}`
}

export function createLogger(level: LogLevel = 'info', format: LogFormat = 'json') {
  const minPriority = LEVEL_PRIORITY[level]

  function log(logLevel: LogLevel, message: string, errorOrContext?: Error | LogContext, maybeContext?: LogContext) {
    if (LEVEL_PRIORITY[logLevel] < minPriority) return

    let context: LogContext = {}
    if (errorOrContext instanceof Error) {
      context = {
        ...maybeContext,
        error: { message: errorOrContext.message, stack: errorOrContext.stack },
      }
    } else if (errorOrContext) {
      context = errorOrContext
    }

    const formatted = format === 'json'
      ? formatJson(logLevel, message, context)
      : formatPretty(logLevel, message, context)

    const consoleFn = logLevel === 'error' ? console.error
      : logLevel === 'warn' ? console.warn
      : logLevel === 'debug' ? console.debug
      : console.log

    consoleFn(formatted)
  }

  return {
    debug: (message: string, context?: LogContext) => log('debug', message, context),
    info: (message: string, context?: LogContext) => log('info', message, context),
    warn: (message: string, context?: LogContext) => log('warn', message, context),
    error: (message: string, error?: Error, context?: LogContext) => log('error', message, error, context),
  }
}

const logLevel = (process.env.LOG_LEVEL as LogLevel) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
const logFormat = (process.env.LOG_FORMAT as LogFormat) ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')

export const logger = createLogger(logLevel, logFormat)
