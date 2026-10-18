import { test, expect, type Page } from '@playwright/test'
import { seedUserCredentials } from './credentials'

// A tenant user of the development seed, as in support-phase1.spec.ts.
const CUSTOMER = seedUserCredentials('sarah.chen@acme.test')

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(connections|support)/, { timeout: 15_000 })
}

test.describe('Storage access', () => {
  test('an uploaded attachment is not served without a session', async ({ page, browser }) => {
    await login(page, CUSTOMER.email, CUSTOMER.password)

    const body = `storage-auth ${Date.now()}`
    const upload = await page.request.post('/support/api/attachments/upload', {
      multipart: {
        file: { name: 'storage-auth.txt', mimeType: 'text/plain', buffer: Buffer.from(body) },
      },
    })
    expect(upload.status()).toBe(200)
    const { storageKey } = (await upload.json()) as { storageKey: string }
    expect(storageKey).toMatch(/^support\//)

    const anonymous = await browser.newContext()
    try {
      const res = await anonymous.request.get(`/api/storage/files/${storageKey}`, { maxRedirects: 0 })
      expect(res.status()).not.toBe(200)
      expect(await res.text()).not.toContain(body)
    } finally {
      await anonymous.close()
    }
  })
})
