import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminCredentials, seedUserCredentials } from './credentials'

// ─── Seed Credentials ───────────────────────────────────────
// The customer is a tenant user of the development seed (prisma/seeds/development.ts),
// and the agent is the platform admin that the production seed creates from BOOTSTRAP_ADMIN_*.
// e2e/credentials.ts reads both passwords from E2E_* variables.
const CUSTOMER = seedUserCredentials('sarah.chen@acme.com')
const AGENT    = adminCredentials()

// ─── Helpers ────────────────────────────────────────────────

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  // Post-login redirect: signIn('credentials') redirects to /, which lands on /connections or /support
  await page.waitForURL(/\/(connections|support)/, { timeout: 15_000 })
}

/** A ticket's detail page, /support/<id>, which the new-ticket page /support/new is not. */
function isTicketPage(url: URL): boolean {
  return /^\/support\/[^/]+$/.test(url.pathname) && url.pathname !== '/support/new'
}

/**
 * Types into the reply composer and sends with the composer's own "Gönder" button, because the CSAT prompt of a
 * resolved ticket has a "Gönder" button too.
 */
async function sendInComposer(page: Page, text: string) {
  const editor = page.locator('.tiptap-editor')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await editor.click()
  // A click anywhere in the composer box, here its centre, puts the caret in the editor
  await expect(editor.locator('.ProseMirror')).toBeFocused()
  await page.keyboard.type(text)
  // The composer is the editor box's parent, which holds the toolbar and the send button
  await editor.locator('..').getByRole('button', { name: 'Gönder' }).click()
}

/** Opens a ticket as the signed-in customer and returns the URL of its detail page. */
async function openTicket(page: Page, subject: string): Promise<string> {
  await page.goto('/support/new')
  await expect(page.locator('input#subject')).toBeVisible({ timeout: 10_000 })
  await page.locator('input#subject').fill(subject)
  // TicketForm has a single submit path: the composer's "Gönder" button
  await sendInComposer(page, 'Bağlanamıyorum, test açıklaması')
  await page.waitForURL(isTicketPage, { timeout: 15_000 })
  return page.url()
}

/** Signs the agent in, in a browser context of its own, and resolves the ticket at `ticketUrl`. */
async function resolveAsAgent(browser: Browser, ticketUrl: string) {
  const agentContext = await browser.newContext()
  try {
    const agentPage = await agentContext.newPage()
    await login(agentPage, AGENT.email, AGENT.password)
    await agentPage.goto(ticketUrl)
    // The Resolve button shows only to agents who can manage tickets
    const resolveBtn = agentPage.getByRole('button', { name: 'Resolve' })
    await expect(resolveBtn).toBeVisible({ timeout: 10_000 })
    await resolveBtn.click()
    await expect(agentPage.getByRole('button', { name: 'Reopen' })).toBeVisible({ timeout: 10_000 })
  } finally {
    await agentContext.close()
  }
}

// ─── Tests ──────────────────────────────────────────────────
// Tests 2 and 5 open a ticket of their own and follow it by its URL, because the CSAT prompt shows only to the
// ticket's creator, only the creator's reply reopens a ticket, and the inbox lists only open tickets by default.

test.describe('Support Phase 1', () => {
  // Multi-login tests need more than the default 30s
  test.setTimeout(60_000)

  test('1. customer opens ticket, agent sees it', async ({ page, browser }) => {
    // Customer creates a new ticket
    await login(page, CUSTOMER.email, CUSTOMER.password)
    const subject = `Playwright test ticket ${Date.now()}`
    await openTicket(page, subject)

    // Agent logs in and should see the ticket in the inbox
    const agentContext = await browser.newContext()
    const agentPage = await agentContext.newPage()
    await login(agentPage, AGENT.email, AGENT.password)
    await agentPage.goto('/support')

    await expect(agentPage.getByText(subject)).toBeVisible({ timeout: 30_000 })

    await agentContext.close()
  })

  test('2. resolve triggers CSAT prompt for customer', async ({ page, browser }) => {
    await login(page, CUSTOMER.email, CUSTOMER.password)
    const ticketUrl = await openTicket(page, `Playwright CSAT ticket ${Date.now()}`)

    await resolveAsAgent(browser, ticketUrl)

    // The customer views the same ticket and sees the CSAT prompt
    await page.goto(ticketUrl)
    // CsatPrompt renders "Ticket'ınız çözümlendi. Nasıl gitti?"
    await expect(page.locator('text=Nasıl gitti')).toBeVisible({ timeout: 10_000 })
  })

  test('3. keyboard j/k navigates inbox', async ({ page }) => {
    await login(page, AGENT.email, AGENT.password)
    await page.goto('/support')

    const rows = page.locator('a[href^="/support/"]')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })

    // Click within the inbox list area to ensure keyboard focus is on the page
    await rows.first().focus()
    // Small pause for react-hotkeys-hook to register
    await page.waitForTimeout(300)

    // Press j to move selection down, then Enter to open
    await page.keyboard.press('j')
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/support\/[a-zA-Z0-9-]+/, { timeout: 5_000 })
  })

  test('4. search finds ticket by subject', async ({ page }) => {
    await login(page, AGENT.email, AGENT.password)
    await page.goto('/support')

    // The search input has placeholder "Ara..." (InboxList component)
    const searchInput = page.locator('input[placeholder="Ara..."]')
    await expect(searchInput).toBeVisible({ timeout: 5_000 })

    // Search for a seeded ticket subject fragment
    // TKT-SEED-001 subject: "Veritabanı bağlanamıyor"
    await searchInput.fill('bağlan')
    await searchInput.press('Enter')

    // Should find at least the seeded ticket
    await expect(
      page.locator('text=bağlan').first(),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('5. customer reply on resolved ticket auto-reopens', async ({ page, browser }) => {
    await login(page, CUSTOMER.email, CUSTOMER.password)
    const ticketUrl = await openTicket(page, `Playwright reopen ticket ${Date.now()}`)
    await resolveAsAgent(browser, ticketUrl)

    // The customer replies on the resolved ticket
    await page.goto(ticketUrl)
    await sendInComposer(page, 'Hala çalışmıyor, tekrar bakabilir misiniz?')

    // Auto-reopen should emit REOPENED activity within the conversation timeline
    // The timeline-activity component renders "yeniden açtı" for REOPENED type
    await expect(
      page.locator('text=yeniden açtı').or(page.locator('text=REOPENED')),
    ).toBeVisible({ timeout: 15_000 })
  })
})
