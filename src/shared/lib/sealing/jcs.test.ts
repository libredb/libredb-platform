import { describe, expect, it } from 'vitest'
import { CanonicalJsonError, canonicalDefinition, canonicalJson } from './jcs'

// What `run` threw; fails when it returns.
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

// The JSON path that the CanonicalJsonError thrown by `run` names.
function refusedAt(run: () => unknown): string {
  const error = thrownBy(run)
  if (!(error instanceof CanonicalJsonError)) throw error
  return error.path
}

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code units and refuses non-finite and non-integer numbers', () => {
    // RFC 8785 section 3.2.3. U+1F600 is above U+FB33 as a code point, but its first UTF-16 code unit, 0xD83D,
    // is below 0xFB33, so it sorts first: an order by code points would put it last.
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    )

    expect(refusedAt(() => canonicalJson({ port: Number.NaN }))).toBe('$.port')
    expect(refusedAt(() => canonicalJson({ port: Number.POSITIVE_INFINITY }))).toBe('$.port')
    expect(refusedAt(() => canonicalJson({ ports: [1, Number.NEGATIVE_INFINITY] }))).toBe('$.ports[1]')
    expect(refusedAt(() => canonicalJson({ port: 1.5 }))).toBe('$.port')
    expect(refusedAt(() => canonicalJson({ ssl: { timeout: 0.25 } }))).toBe('$.ssl.timeout')
    // A definition number is a safe integer, as Number.isSafeInteger decides: its magnitude is below 2^53.
    expect(refusedAt(() => canonicalJson({ big: 2 ** 53 }))).toBe('$.big')
    expect(refusedAt(() => canonicalJson({ small: -(2 ** 53) }))).toBe('$.small')
    expect(canonicalJson({ smallest: Number.MIN_SAFE_INTEGER, largest: Number.MAX_SAFE_INTEGER, zero: -0, port: 5432 })).toBe(
      '{"largest":9007199254740991,"port":5432,"smallest":-9007199254740991,"zero":0}',
    )

    // A refusal names where the value sits, never the value.
    const error = thrownBy(() => canonicalJson({ ssl: { port: 1.5 } }))
    expect(error).toBeInstanceOf(CanonicalJsonError)
    expect((error as Error).message).toContain('$.ssl.port')
    expect((error as Error).message).not.toContain('1.5')
  })

  it('writes strings and literals as ECMAScript JSON.stringify does, sorts nested objects and adds no whitespace', () => {
    const value = {
      text: 'tab\tcontrol\u0001\u001f quote" backslash\\ solidus/ <eu> & \u00e9 \ud842\udfb7',
      nested: [2, { d: true, c: null }, []],
      literals: [null, true, false],
    }
    // The quote, the backslash and the controls are escaped; the solidus, <, >, & and text beyond ASCII are not.
    expect(canonicalJson(value)).toBe(
      '{"literals":[null,true,false],"nested":[2,{"c":null,"d":true},[]],' +
        '"text":"tab\\tcontrol\\u0001\\u001f quote\\" backslash\\\\ solidus/ <eu> & \u00e9 \ud842\udfb7"}',
    )
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}')
    expect(canonicalJson('host')).toBe('"host"')
  })

  it('refuses values JSON cannot carry and text that is not well-formed Unicode, naming the path', () => {
    expect(refusedAt(() => canonicalJson(undefined))).toBe('$')
    expect(refusedAt(() => canonicalJson({ host: undefined }))).toBe('$.host')
    // A hole in a sparse array is not a value; JSON.stringify would write null for it.
    expect(refusedAt(() => canonicalJson({ list: Object.assign([], { 0: 1, 2: 3 }) }))).toBe('$.list[1]')
    expect(refusedAt(() => canonicalJson({ run: () => 1 }))).toBe('$.run')
    expect(refusedAt(() => canonicalJson({ id: Symbol('x') }))).toBe('$.id')
    expect(refusedAt(() => canonicalJson({ big: BigInt(1) }))).toBe('$.big')
    // An object that is not a plain object is refused rather than written as what its toJSON returns.
    expect(refusedAt(() => canonicalJson({ at: new Date(0) }))).toBe('$.at')
    expect(refusedAt(() => canonicalJson(new Map()))).toBe('$')
    // RFC 8785 section 3.2.2.2: a lone surrogate is not Unicode, so it has no canonical form.
    expect(refusedAt(() => canonicalJson({ host: 'db\ud800' }))).toBe('$.host')
    expect(refusedAt(() => canonicalJson({ ssl: { '\udfb7': 'x' } }))).toBe('$.ssl')
  })
})

describe('canonicalDefinition', () => {
  it('writes a definition object and refuses a definition that is not a JSON object', () => {
    expect(canonicalDefinition({})).toBe('{}')
    expect(canonicalDefinition({ port: 5432, host: 'db.example.internal', ssl: { rejectUnauthorized: true, mode: 'verify-full' } })).toBe(
      '{"host":"db.example.internal","port":5432,"ssl":{"mode":"verify-full","rejectUnauthorized":true}}',
    )
    for (const definition of [[], 'host', null, 5, new Date(0)]) {
      expect(refusedAt(() => canonicalDefinition(definition))).toBe('$')
    }
    expect(refusedAt(() => canonicalDefinition({ port: 5432.5 }))).toBe('$.port')
  })
})
