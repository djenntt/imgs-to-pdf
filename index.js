const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');
const rimraf = require('rimraf');

async function downloadImage(imageUrl, folderPath, maxRetries = 1) {
    const imageName = path.basename(new URL(imageUrl).pathname);
    const imagePath = path.resolve(__dirname, folderPath, imageName);

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const writer = fs.createWriteStream(imagePath);
            const response = await axios({
                url: imageUrl,
                method: 'GET',
                responseType: 'stream'
            });
            response.data.pipe(writer);
            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', () => {
                    writer.close();
                    reject(new Error(`Failed to download image on attempt ${attempt}`));
                });
            });
        } catch (error) {
            if (attempt === maxRetries + 1) {
                return Promise.reject(error);
            }
        }
    }
}

function formatSequenceNumber(number, totalUrls) {
    const length = totalUrls.toString().length;
    return number.toString().padStart(length, '0');
}

(async () => {
    const errors = [];
    let pdfSequenceNumber = 1;
    const urls = fs.readFileSync('urls.txt', 'utf8').split('\n').filter(Boolean);
    const basePdfName = process.argv[2] || 'output';
    const mode = process.argv[3] || '';
    const cssSelector = process.argv[4] || 'img';

    for (let i = 0; i < urls.length; i++) {
        let failed = false;
        const url = urls[i];
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });

        const imageUrls = await page.evaluate((selector) => {
            const images = Array.from(document.querySelectorAll(selector));
            return images.map(img => img.getAttribute('data-src') || img.src).filter(src => src !== 'about:blank');
        }, cssSelector);

        await browser.close();

        const folderPath = './images';
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        const imagesFolderPath = path.join(folderPath, `images_${pdfSequenceNumber}`);
        if (!fs.existsSync(imagesFolderPath)) {
            fs.mkdirSync(imagesFolderPath, { recursive: true });
        }

        const downloadPromises = imageUrls.map(imageUrl => downloadImage(imageUrl, imagesFolderPath, 2));
        const results = await Promise.allSettled(downloadPromises);

        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                failed = true;
                errors.push({ url: imageUrls[index], error: result.reason.message });
            }
        });

        if (errors.length === 0) {
            const formattedSequenceNumber = formatSequenceNumber(pdfSequenceNumber, urls.length);
            const pdfName = `${basePdfName}_${formattedSequenceNumber}`;
            const pdfFolderPath = path.join('./pdfs', basePdfName);

            if (!fs.existsSync(pdfFolderPath)) {
                fs.mkdirSync(pdfFolderPath, { recursive: true });
            }

            const pdfPath = path.join(pdfFolderPath, `${pdfName}.pdf`);
            const convertCommand = `magick convert ${imagesFolderPath}/*.* ${pdfPath}`;

            exec(convertCommand, (error, _stdout, stderr) => {
                if (error) {
                    console.error(`Error: ${error.message}`);
                    return;
                }
                if (stderr) {
                    console.error(`stderr: ${stderr}`);
                    return;
                }

                console.log(`Images converted to PDF: ${pdfPath}`);
                if (mode === 'pdfclean') {
                    rimraf.sync(imagesFolderPath);
                    console.log('Images folder removed.');
                }
            });
        }

        pdfSequenceNumber++;
    }

    if (errors.length > 0) {
        console.error(`Errors occurred:`, errors);
    }
})();
