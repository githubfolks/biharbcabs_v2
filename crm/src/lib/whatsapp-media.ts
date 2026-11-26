import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getMetaWhatsAppConfig } from './settings';
import { ALLOWED_DOC_MIME_EXT, MAX_DRIVER_DOC_BYTES, getDriverDocsDir } from './driver-docs';

export interface DownloadedWhatsAppMedia {
  storedFilename: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Download an inbound Meta WhatsApp Cloud API media attachment (image or PDF)
 * directly into the private persistent driver-docs storage directory.
 */
export async function downloadMetaWhatsAppMedia(
  mediaId: string,
  prefix: string
): Promise<DownloadedWhatsAppMedia | null> {
  const config = await getMetaWhatsAppConfig();
  const token = String(config?.access_token || '').trim();
  const version = String(config?.api_version || 'v21.0').trim();
  if (!token || !mediaId) {
    console.warn('[WhatsAppMedia] Skipping media download: Meta access_token or mediaId missing.');
    return null;
  }

  // Step 1: Fetch temporary download URL from Meta Graph API
  const metaRes = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    console.error(`[WhatsAppMedia] Metadata lookup failed (${metaRes.status}) for media ${mediaId}`);
    return null;
  }
  const metaJson = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!metaJson.url) return null;

  const mime = String(metaJson.mime_type || '').toLowerCase().split(';')[0].trim();
  const ext = ALLOWED_DOC_MIME_EXT[mime];
  if (!ext) {
    console.warn(`[WhatsAppMedia] Unsupported MIME type '${mime}' for media ${mediaId}`);
    return null;
  }

  // Step 2: Download binary with Bearer auth
  const binRes = await fetch(metaJson.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!binRes.ok) {
    console.error(`[WhatsAppMedia] Binary download failed (${binRes.status}) for media ${mediaId}`);
    return null;
  }
  const buf = Buffer.from(await binRes.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_DRIVER_DOC_BYTES) {
    console.warn(`[WhatsAppMedia] File size ${buf.length} out of bounds for media ${mediaId}`);
    return null;
  }

  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const storedFilename = `${safePrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const fullPath = path.join(getDriverDocsDir(), storedFilename);
  fs.writeFileSync(fullPath, buf, { mode: 0o600 });

  return {
    storedFilename,
    originalFilename: `${safePrefix}${ext}`,
    mimeType: mime,
    sizeBytes: buf.length,
  };
}
