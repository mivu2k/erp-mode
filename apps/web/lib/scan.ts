'use client';

export type Detector = { detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]> };
/**
 * The browser's own barcode reader when it has one (Chrome/Android); otherwise the bundled ZXing decoder
 * (iPhone Safari, Firefox), loaded only when first needed and served from /zxing_reader.wasm so it works offline.
 */
export async function barcodeDetector(): Promise<Detector> {
  const Native = (window as unknown as { BarcodeDetector?: new () => Detector }).BarcodeDetector;
  if (Native) return new Native();
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? '/zxing_reader.wasm' : prefix + path) } });
  return new BarcodeDetector() as unknown as Detector;
}
