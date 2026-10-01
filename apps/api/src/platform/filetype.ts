/** Real file type from the first bytes (never trust the browser's declared type). */
export function sniff(buf: Buffer, declared: string): string | null {
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  // Office Open XML (docx/xlsx/pptx) are zip files; accept only when declared as such.
  if (hex.startsWith('504b0304')) return /openxmlformats|opendocument/.test(declared) ? declared : 'application/zip';
  if (hex.startsWith('d0cf11e0a1b11ae1')) return /msword|ms-excel|ms-powerpoint/.test(declared) ? declared : null; // legacy Office
  // Plain text (CSV/TXT): no NUL bytes and valid UTF-8 in the sample.
  if (/^text\/(plain|csv)$/.test(declared)) {
    const sample = buf.subarray(0, 4096);
    if (!sample.includes(0) && Buffer.from(sample.toString('utf8'), 'utf8').equals(sample)) return declared;
  }
  return null;
}
