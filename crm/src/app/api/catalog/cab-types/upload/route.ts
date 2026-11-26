import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getCabUploadsDir } from '@/lib/cab-uploads';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'Image file is required.' }, { status: 400 });
    }

    const ext = ALLOWED_MIME[file.type.toLowerCase()];
    if (!ext) {
      return NextResponse.json(
        { success: false, error: 'Unsupported image format. Allowed: JPG, PNG, WebP.' },
        { status: 400 }
      );
    }

    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Image size must be between 1 byte and 5 MB.' },
        { status: 400 }
      );
    }

    const dir = getCabUploadsDir();
    await fs.mkdir(dir, { recursive: true });

    const filename = `cab-${crypto.randomUUID()}${ext}`;
    const targetPath = path.join(dir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(targetPath, buffer);

    return NextResponse.json(
      {
        success: true,
        filename,
        image_url: `/api/public/cab-images/${filename}`,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/cab-types/upload');
  }
}
