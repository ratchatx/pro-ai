import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

console.log('Type of pdfParse:', typeof pdfParse);
console.log('pdfParse keys:', Object.keys(pdfParse));
if (typeof pdfParse !== 'function') {
    if (pdfParse.default) {
        console.log('Type of pdfParse.default:', typeof pdfParse.default);
    }
}
