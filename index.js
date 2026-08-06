const express = require('express')
const app = express()
const morgan = require("morgan");
const helmet = require("helmet");
const port = (process.env.PORT || 3333);

const puppeteer = require("puppeteer");

const getScreenShot = async ({ url, width = 800, height = 500, fullPage = true, waitUntil = 'networkidle0' }) => {

    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    const page = await browser.newPage();

    await page.setViewport({ width, height })

    await page.goto(url, { waitUntil })
    // await page.evaluate(() => {
    //     window.scrollBy(0, window.innerHeight);
    // })
    // await sleep(200)
    const buffer = await page.screenshot({
        encoding: 'binary',
        // path: 'image.png',
        fullPage: fullPage
    })

    browser.close();

    return buffer
};

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(helmet());
app.use(morgan("dev"));

app.post('/screenshot', async (req, res, next) => {

    try {

        const { url, width, height, waitUntil, fullPage = true } = req.body;
        if (!url) return next(Error('url is required'))

        const buffer = await getScreenShot({ url, width, height, fullPage, waitUntil })

        res.send(buffer);

    } catch (err) { next(err) }

})

var packageFile = require('./package.json');

app.get('/version', (req, res) => res.send(packageFile.version))
app.get('/', (req, res) => res.send('API Screenshot'))

app.use((req, res, next) => { next(Error("Not Found")); });

const error = function (err, req, res, next) { res.status(500).json({ status: "error", message: err.message, data: null }); }
app.use(error);

app.listen(port, () => console.log(`App Lstening on port ${port}`))