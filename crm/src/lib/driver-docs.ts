import fs from 'fs';
import path from 'path';
import { getCabUploadsDir } from './cab-uploads';
export { DRIVER_DOC_TYPES, VALID_DOC_TYPE_CODES } from './driver-doc-types';
export type { DriverDocType } from './driver-doc-types';

export const ALLOWED_DOC_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export const MAX_DRIVER_DOC_BYTES = 5 * 1024 * 1024; // 5 MB

export function getDriverDocsDir(): string {
  const dir = path.join(getCabUploadsDir(), 'driver-docs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function safeStoredFilenamePath(storedFilename: string): string | null {
  const clean = path.basename(storedFilename);
  if (!/^[a-zA-Z0-9._-]+$/.test(clean) || clean !== storedFilename) return null;
  return path.join(getDriverDocsDir(), clean);
}
