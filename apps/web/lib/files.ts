'use client';
import { getToken, raw, refresh } from './api';

export interface Attachment { id: string; fileName: string; mimeType: string; size: number; createdAt: string }

/**
 * Shrinks photos before upload: max 2000px on the long side, JPEG 0.85 (PNG stays PNG for transparency).
 * Also bakes in EXIF rotation so phone pictures aren't sideways. Small images and non-images pass through.
 */
export async function prepareImage(file: File, maxDim = 2000): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap === 'undefined') return file;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.(png|jpe?g|webp)$/i, '') + (type === 'image/png' ? '.png' : '.jpg'), { type });
}

/** Multipart upload with progress (XHR: fetch has no upload progress). Retries once after a token refresh. */
export function uploadFile(entityType: string, entityId: string, file: File, onProgress?: (pct: number) => void, retry = true): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    const t = getToken();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = async () => {
      if (xhr.status === 401 && retry && (await refresh())) return uploadFile(entityType, entityId, file, onProgress, false).then(resolve, reject);
      const body = (() => { try { return JSON.parse(xhr.responseText); } catch { return null; } })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(typeof body?.message === 'string' ? body.message : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const fd = new FormData();
    fd.append('entityType', entityType);
    fd.append('entityId', entityId);
    fd.append('file', file);
    xhr.send(fd);
  });
}

const urls = new Map<string, Promise<string>>();
/** Object URL for an attachment (fetched with auth, cached for the page's lifetime). */
export function fileUrl(id: string): Promise<string> {
  if (!urls.has(id)) urls.set(id, raw(`attachments/${id}/file`).then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch((e) => { urls.delete(id); throw e; }));
  return urls.get(id)!;
}

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
export const isImage = (m: string) => m.startsWith('image/');
