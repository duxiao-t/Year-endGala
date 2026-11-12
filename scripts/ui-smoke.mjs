import fs from 'node:fs'
import { chromium } from 'playwright'

const baseUrl = process.env.UI_BASE_URL || 'http://localhost:3101'
const adminPassword = process.env.ADMIN_PASSWORD || 'test-admin'
const screenToken = process.env.SCREEN_TOKEN || 'screen-test'
const outputDir = 'artifacts'
fs.mkdirSync(outputDir, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
})
const errors = []

async function capture(page, name, path) {
  page.on('console', (message) => {
    const guestProbe =
      name === 'join' && message.text().includes('status of 401 (Unauthorized)')
    if (message.type() === 'error' && !guestProbe) {
      errors.push(`[${name}] console: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => errors.push(`[${name}] pageerror: ${error.message}`))
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true })
}

async function captureCurrent(page, name, delay = 1200) {
  await page.waitForTimeout(delay)
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true })
}

try {
  const landing = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await capture(landing, 'landing', '/')

  const join = await browser.newPage({ viewport: { width: 430, height: 932 } })
  await join.addInitScript(() => {
    class StubDeviceMotionEvent extends Event {
      static requestPermission() {
        return Promise.resolve('granted')
      }
    }
    Object.defineProperty(window, 'DeviceMotionEvent', {
      configurable: true,
      value: StubDeviceMotionEvent
    })
  })
  const joinPath = process.env.JOIN_CODE
    ? `/join?code=${encodeURIComponent(process.env.JOIN_CODE)}`
    : '/join'
  await capture(join, 'join', joinPath)
  const employeeNo = `UI${Date.now().toString().slice(-8)}`
  await join.fill('input[autocomplete="username"]', employeeNo)
  await join.fill('input[autocomplete="name"]', '界面测试')
  await join.fill('input[autocomplete="organization"]', '测试部')
  await join.click('button[type="submit"]')
  await join.waitForURL('**/play', { timeout: 10_000 })
  await join.waitForTimeout(1200)
  await join.screenshot({ path: `${outputDir}/play.png`, fullPage: true })

  const screen = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await capture(screen, 'screen', `/screen?token=${encodeURIComponent(screenToken)}`)

  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await admin.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' })
  await admin.waitForTimeout(800)
  await admin.fill('input[type="password"]', adminPassword)
  await admin.click('button[type="submit"]')
  await admin.waitForTimeout(1200)
  await admin.screenshot({ path: `${outputDir}/admin.png`, fullPage: true })

  async function adminPost(path, body) {
    const result = await admin.evaluate(
      async ({ path, body, baseUrl }) => {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        return { ok: response.ok, status: response.status, body: await response.text() }
      },
      { path, body, baseUrl }
    )
    if (!result.ok) throw new Error(`${path} failed: ${result.status} ${result.body}`)
  }

  async function adminAction(game, action) {
    await adminPost(`/api/admin/games/${game}/action`, { action })
  }

  await adminAction('shake', 'start')
  await captureCurrent(screen, 'screen-shake')
  await captureCurrent(join, 'play-shake')
  await join.getByRole('button', { name: '开启运动权限' }).click()
  const tapButton = join.getByTestId('tap-button')
  await tapButton.waitFor({ state: 'visible', timeout: 5000 })
  await tapButton.click()
  await join.waitForTimeout(1300)
  const tapCount = await join.getByTestId('tap-count').textContent()
  if (!/[1-9]\d* 次/.test(tapCount || '')) {
    throw new Error(`shake fallback did not record a tap: ${tapCount}`)
  }
  await join.screenshot({ path: `${outputDir}/play-shake-fallback.png`, fullPage: true })
  await adminAction('shake', 'finish')

  await adminAction('shake', 'start')
  const enableMotion = join.getByRole('button', { name: '开启运动权限' })
  await enableMotion.waitFor({ state: 'visible', timeout: 5000 })
  await enableMotion.click()
  await join.evaluate(async () => {
    const startedAt = performance.now()
    for (let index = 0; performance.now() - startedAt < 1200; index += 1) {
      const event = new Event('devicemotion')
      Object.defineProperty(event, 'acceleration', {
        value: { x: 0, y: 0, z: 0 }
      })
      Object.defineProperty(event, 'accelerationIncludingGravity', {
        value: { x: index % 2 === 0 ? 9 : -9, y: 0, z: 9.8 }
      })
      window.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  })
  await join.waitForTimeout(1800)
  const sensorStatus = await join.getByTestId('sensor-status').textContent()
  const sensorScore = await join.evaluate(async () => {
    const response = await fetch('/api/me')
    const summary = await response.json()
    return summary.shake.score
  })
  const capturedCount = Number(/已捕获 (\d+) 次/.exec(sensorStatus || '')?.[1] || 0)
  if (
    !/传感器已连接/.test(sensorStatus || '') ||
    !/重力向量/.test(sensorStatus || '') ||
    capturedCount <= 0 ||
    sensorScore <= 0
  ) {
    throw new Error(`shake sensor path failed: ${sensorStatus}; score=${sensorScore}`)
  }
  await join.screenshot({ path: `${outputDir}/play-shake-sensor.png`, fullPage: true })
  await adminAction('shake', 'finish')

  await adminAction('redpacket', 'start')
  await captureCurrent(screen, 'screen-redpacket')
  await captureCurrent(join, 'play-redpacket')
  await adminAction('redpacket', 'finish')

  await adminAction('quiz', 'start')
  await captureCurrent(screen, 'screen-quiz')
  await captureCurrent(join, 'play-quiz')
  await adminAction('quiz', 'finish')

  await adminAction('lottery', 'show')
  await captureCurrent(screen, 'screen-lottery')
  await captureCurrent(join, 'play-lottery')
  await adminPost('/api/admin/lottery/draw', { prizeIndex: 0, count: 1 })
  await captureCurrent(screen, 'screen-lottery-result', 3500)

  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`UI smoke passed. Screenshots in ${outputDir}/`)
  }
} finally {
  await browser.close()
}
