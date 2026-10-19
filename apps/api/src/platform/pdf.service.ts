import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Browser, chromium } from 'playwright-core';

/** HTML → PDF with headless Chromium (CHROME_PATH). The browser is launched once and reused. */
@Injectable()
export class PdfService implements OnModuleDestroy {
  /** For plain helpers (sendReport) outside DI. */
  static instance: PdfService;
  constructor() {
    PdfService.instance = this;
  }

  private browser: Promise<Browser> | null = null;
  private log = new Logger('Pdf');

  private launch() {
    if (!process.env.CHROME_PATH) throw new ServiceUnavailableException('PDF rendering needs CHROME_PATH (headless Chromium); use Print → Save as PDF meanwhile');
    this.browser ??= chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch((e) => {
      this.browser = null;
      this.log.error(e);
      throw new ServiceUnavailableException('PDF renderer failed to start');
    });
    return this.browser;
  }

  async render(html: string, thermalWidthMm?: number): Promise<Buffer> {
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      // Print scripts (auto window.print) are stripped; no network needed since QR/barcodes are inline SVG.
      // Rendered documents are self-contained: no request may leave the renderer (custom brochure HTML/CSS included).
      await page.route(/^(?!data:)/, (r) => r.abort());
      await page.setContent(html.replace(/<script[\s\S]*?<\/script>/g, ''), { waitUntil: 'load', timeout: 15_000 });
      // A slip is one strip as long as its content, not Letter-sized pages.
      const height = thermalWidthMm ? Math.ceil((await page.evaluate(() => document.body.scrollHeight)) * 25.4 / 96 + 4) : 0;
      const pdf = await page.pdf(thermalWidthMm ? { width: `${thermalWidthMm}mm`, height: `${height}mm`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } } : { preferCSSPageSize: true, printBackground: true, format: 'A4' });
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  async onModuleDestroy() {
    if (this.browser) await (await this.browser).close().catch(() => {});
  }
}
