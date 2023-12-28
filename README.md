# Image Downloader & PDF Converter

This Node.js script allows for downloading images from a list of URLs and converting them into PDF format. It supports different modes for downloading images, creating PDFs, and cleaning up after conversion.

## Features

-   Downloads images from provided URLs.
-   Converts downloaded images into PDF format.
-   Supports different modes: download only, download and convert to PDF, download and convert to PDF with image cleanup.
-   Flexible image selection using CSS selectors.

## Requirements

-   Node.js
-   Puppeteer
-   Axios
-   ImageMagick (for PDF conversion)

## Installation

Clone or download the repository.

Install the required Node.js modules:

```bash
npm install
```

**Ensure ImageMagick is installed on your system for PDF conversion.**

## Usage

Create a file named urls.txt in the script's directory. Add the URLs, each on a new line.

Run the script with one of the following commands, depending on the desired mode:

### Download Images Only:

If you want all images on the page, use the following command:

```bash
node index.js [BaseName]
```

If you want to target specific images, use the following command:

```bash
node index.js [BaseName] images [CssSelector]
```

### Download Images and Convert to PDF:

```bash
node index.js [BasePdfName] pdf [CssSelector]
```

### Download Images, Convert to PDF, then Remove Images:

```bash
node index.js [BasePdfName] pdfclean [CssSelector]
```

Replace [BasePdfName] with the desired base name for the output PDFs, and [CssSelector] with the CSS selector to target images on the page (default is 'img').

PDFs and/or images will be stored in folders named after the base PDF name, with sequence numbers appended.

## Notes

The script processes each URL in urls.txt and generates a PDF for each batch of images fetched.

Ensure the website is accessible and the CSS selector correctly targets the image elements.

The script may require adjustments for specific websites or for handling different web page structures.

## Disclaimer

This script is intended for personal use and educational purposes. Ensure you have the right to download and convert content from the provided URLs. Respect copyright laws and the terms of service of the websites you are accessing.
