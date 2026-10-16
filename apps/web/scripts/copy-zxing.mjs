// Serves the barcode decoder from the app itself (default is a public CDN, unreachable on an offline LAN).
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
const req = createRequire(createRequire(import.meta.url).resolve('barcode-detector/ponyfill'));
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
copyFileSync(req.resolve('zxing-wasm/reader/zxing_reader.wasm'), new URL('../public/zxing_reader.wasm', import.meta.url));
