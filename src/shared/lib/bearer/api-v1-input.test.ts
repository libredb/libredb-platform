import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ValidationError } from '../errors'
import { parseApiInput, readJsonObject } from './api-v1-input'

function request(body: string): Request {
  return new Request('http://localhost:3100/api/v1/probe', { method: 'PUT', body })
}

describe('parseApiInput', () => {
  const schema = z.strictObject({ level: z.enum(['read', 'write']), page: z.number().int().default(1) })

  it('answers the parsed input', () => {
    expect(parseApiInput(schema, { level: 'read' })).toEqual({ level: 'read', page: 1 })
  })

  it('throws ValidationError with the messages of each field', () => {
    let refusal: unknown
    try {
      parseApiInput(schema, { level: 'admin', page: 1.5 })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(ValidationError)
    expect((refusal as ValidationError).fieldErrors).toEqual({ level: [expect.any(String)], page: [expect.any(String)] })
  })
})

describe('readJsonObject', () => {
  it('answers a JSON object', async () => {
    expect(await readJsonObject(request('{"level":"read"}'))).toEqual({ level: 'read' })
  })

  it.each(['{level', '', '[]', 'null', '"read"'])('refuses the body %j on body', async (body) => {
    await expect(readJsonObject(request(body))).rejects.toMatchObject({ fieldErrors: { body: ['must be a JSON object'] } })
  })
})
