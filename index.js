import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'

import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import puppeteer from 'puppeteer'

const packageFile = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'))

const port = Number(process.env.PORT ?? 3333)
// how many pages may render at once — the ceiling that keeps Chrome from eating the pod
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 2)
const navigationTimeout = Number(process.env.NAVIGATION_TIMEOUT ?? 30000)
// puppeteer defaults this to 180s — far too long to let a wedged CDP call sit on a slot
const protocolTimeout = Number(process.env.PROTOCOL_TIMEOUT ?? 60000)
// MOCKUP=1 short-circuits the whole browser path and returns a placeholder image,
// so callers can be developed and load-tested without Chrome ever launching
const mockup = process.env.MOCKUP === '1'

// --- browser lifecycle -------------------------------------------------------
// One Chrome for the whole process instead of one per request. If it dies or is
// closed, the next request lazily launches a fresh one.
let browserPromise = null

const launchBrowser = async () => {
    const browser = await puppeteer.launch({
        protocolTimeout,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    })

    browser.once('disconnected', () => { browserPromise = null })

    return browser
}

const getBrowser = () => {
    browserPromise ??= launchBrowser().catch(err => {
        browserPromise = null
        throw err
    })

    return browserPromise
}

// --- concurrency gate --------------------------------------------------------
const waiting = []
let active = 0

const drain = () => {
    while (active < maxConcurrency && waiting.length > 0) {
        active++
        waiting.shift()()
    }
}

const acquire = () => new Promise(resolve => { waiting.push(resolve); drain() })
const release = () => { active--; drain() }

// --- core --------------------------------------------------------------------
const getScreenShot = async ({ url, width = 800, height = 500, fullPage = true, waitUntil = 'networkidle0' }) => {

    // checked before the semaphore: there is no browser to serialise access to
    if (mockup) return buildMockup(width, height)

    await acquire()

    let page

    try {
        const browser = await getBrowser()

        page = await browser.newPage()

        page.setDefaultTimeout(navigationTimeout)

        await page.setViewport({ width, height })

        await page.goto(url, { waitUntil, timeout: navigationTimeout })

        // puppeteer >= 23 resolves to a Uint8Array; express only streams Buffers
        const image = await page.screenshot({ type: 'png', fullPage })

        return Buffer.from(image)

    } finally {
        // always runs, so a bad url or a navigation timeout can no longer leak a page.
        // bounded, because closing a page whose CDP connection is wedged can hang too.
        if (page) await Promise.race([page.close().catch(() => {}), delay(5000)])
        release()
    }
}

const app = express()

app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(helmet())
app.use(morgan('dev'))

app.post('/screenshot', async (req, res, next) => {

    const { url, width, height, waitUntil, fullPage = true } = req.body ?? {}

    if (!url) return next(badRequest('url is required'))

    let target
    try {
        target = new URL(url)
    } catch {
        return next(badRequest('url is not a valid URL'))
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return next(badRequest('url must be http or https'))
    }

    const buffer = await getScreenShot({
        url,
        width: toPositiveInt(width, 800),
        height: toPositiveInt(height, 500),
        fullPage,
        waitUntil
    })

    res.type('png').send(buffer)
})

app.get('/version', (req, res) => res.send(packageFile.version))
app.get('/', (req, res) => res.send('API Screenshot'))

app.use((req, res, next) => { next(notFound()) })

app.use((err, req, res, next) => {
    const status = err.status ?? 500
    if (status >= 500) console.error(err)
    res.status(status).json({ status: 'error', message: err.message, data: null })
})

const server = app.listen(port, () => {
    console.log(`App Listening on port ${port}`)
    if (mockup) console.warn('MOCKUP=1 — serving placeholder images, no page will be captured')
})

const shutdown = async signal => {
    console.log(`${signal} received, shutting down`)

    server.close()

    const pending = browserPromise
    browserPromise = null
    if (pending) await pending.then(browser => browser.close()).catch(() => {})

    process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// --- mockup image ------------------------------------------------------------
// A placeholder PNG at exactly the requested width x height: flat fill, a border
// and two diagonals, so it is obvious at a glance that it is not a real capture.
// Encoded by hand rather than pulling in an image library for one debug feature.
const MOCKUP_BG = [233, 236, 239]
const MOCKUP_INK = [173, 181, 189]

function buildMockup(width, height) {
    const stride = width * 3
    // one extra leading byte per scanline for the PNG row filter
    const raw = Buffer.alloc((stride + 1) * height)
    const tolerance = Math.max(width, height)

    for (let y = 0; y < height; y++) {
        const row = y * (stride + 1)
        raw[row] = 0 // filter type 0 (none)

        for (let x = 0; x < width; x++) {
            const onBorder = x < 2 || y < 2 || x >= width - 2 || y >= height - 2
            // corner-to-corner diagonals, compared in cross-multiplied form to stay integral
            const onDiagonal =
                Math.abs(y * width - x * height) <= tolerance ||
                Math.abs(y * width - (width - 1 - x) * height) <= tolerance

            const [r, g, b] = onBorder || onDiagonal ? MOCKUP_INK : MOCKUP_BG
            const px = row + 1 + x * 3
            raw[px] = r
            raw[px + 1] = g
            raw[px + 2] = b
        }
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8  // bit depth
    ihdr[9] = 2  // colour type: truecolour RGB
    // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlacing

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ])
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)

    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])

    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))

    return Buffer.concat([length, body, checksum])
}

let crcTable = null

function crc32(buf) {
    crcTable ??= Int32Array.from({ length: 256 }, (_, n) => {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        return c
    })

    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)

    return (c ^ -1) >>> 0
}

// --- helpers -----------------------------------------------------------------
function badRequest(message) {
    const err = Error(message)
    err.status = 400
    return err
}

function notFound() {
    const err = Error('Not Found')
    err.status = 404
    return err
}

function toPositiveInt(value, fallback) {
    const n = Math.trunc(Number(value))
    return Number.isFinite(n) && n > 0 ? n : fallback
}
