// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeHtmlAttribute } from './code-login'

describe('decodeHtmlAttribute', () => {
  it('decodes the entities of the action of a Keycloak login form', () => {
    const authenticate = 'http://localhost:58080/realms/libredb/login-actions/authenticate'
    expect(decodeHtmlAttribute(`${authenticate}?session_code=s1&amp;execution=e1&amp;tab_id=t1`))
      .toBe(`${authenticate}?session_code=s1&execution=e1&tab_id=t1`)
    expect(decodeHtmlAttribute('&quot;&#39;&lt;&gt;&amp;')).toBe(`"'<>&`)
  })

  it('decodes each entity once, so an escaped entity such as &amp;lt; becomes &lt; and not <', () => {
    expect(decodeHtmlAttribute('&amp;lt;&amp;gt;&amp;quot;&amp;#39;&amp;amp;')).toBe('&lt;&gt;&quot;&#39;&amp;')
  })
})
