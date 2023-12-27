const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');
const rimraf = require('rimraf');

async function downloadImage(imageUrl, folderPath) {
    const imageName = path.basename(new URL(imageUrl).pathname);
    const imagePath = path.resolve(__dirname, folderPath, imageName);
    const writer = fs.createWriteStream(imagePath);

    const response = await axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

function formatSequenceNumber(number, totalUrls) {
    const length = totalUrls.toString().length;
    return number.toString().padStart(length, '0');
}

(async () => {
    const urls = fs.readFileSync('urls.txt', 'utf8').split('\n').filter(Boolean);
    const basePdfName = process.argv[2] || 'output';
    const mode = process.argv[3] || '';
    const cssSelector = process.argv[4] || 'img';

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const sequenceNumber = formatSequenceNumber(i + 1, urls.length);
        const pdfName = `${basePdfName}_${sequenceNumber}`;

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

        const imagesFolderPath = path.join('./images', pdfName);
        if (!fs.existsSync(imagesFolderPath)) {
            fs.mkdirSync(imagesFolderPath, { recursive: true });
        }

        const downloadPromises = imageUrls.map(imageUrl => downloadImage(imageUrl, imagesFolderPath));
        await Promise.all(downloadPromises);

        console.log(`All images from ${url} have been downloaded.`);

        if (!/pdf/i.test(mode)) {
            return;
        }

        const pdfFolderPath = path.join('./', basePdfName);
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
})();

// (async () => {
//     const urls = fs.readFileSync('urls.txt', 'utf8').split('\n').filter(Boolean);
//     const basePdfName = process.argv[2] || 'output';
//     const cssSelector = process.argv[3] || 'img';

//     for (let i = 0; i < urls.length; i++) {
//         const url = urls[i];
//         const sequenceNumber = formatSequenceNumber(i + 1, urls.length);
//         const pdfName = `${basePdfName}_${sequenceNumber}`;

//         const browser = await puppeteer.launch({ headless: 'new' });
//         const page = await browser.newPage();
//         await page.goto(url, { waitUntil: 'networkidle2' });

//         const imageUrls = await page.evaluate((selector) => {
//             const images = Array.from(document.querySelectorAll(selector));
//             return images.map(img => img.getAttribute('data-src') || img.src).filter(src => src !== 'about:blank');
//         }, cssSelector);

//         await browser.close();

//         const folderPath = './images';
//         if (!fs.existsSync(folderPath)) {
//             fs.mkdirSync(folderPath, { recursive: true });
//         }

//         const downloadPromises = imageUrls.map(imageUrl => downloadImage(imageUrl, folderPath));
//         await Promise.all(downloadPromises);

//         console.log(`All images from ${url} have been downloaded.`);

//         const convertCommand = `magick convert ${folderPath}/*.* ${pdfName}.pdf`;

//         exec(convertCommand, (error, _stdout, stderr) => {
//             if (error) {
//                 console.error(`Error: ${error.message}`);
//                 return;
//             }
//             if (stderr) {
//                 console.error(`stderr: ${stderr}`);
//                 return;
//             }
//             console.log(`Images converted to PDF: ${pdfName}`);

//             rimraf.sync(folderPath);
//             console.log('Images folder removed.');
//         });
//     }
// })();

// for (let i = 1; i < 113; i++) {
//     console.log('example url' + i);
// }