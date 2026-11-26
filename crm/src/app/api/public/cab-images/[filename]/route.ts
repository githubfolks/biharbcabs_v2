import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getCabUploadsDir } from '@/lib/cab-uploads';

export const dynamic = 'force-dynamic';

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: { filename: string } }
) {
  const filename = String(params.filename || '').trim();
  if (!SAFE_FILENAME.test(filename) || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const ext = path.extname(filename).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Unsupported file type' }, { status: 400 });
  }

  try {
    const filePath = path.join(getCabUploadsDir(), filename);
    const data = await fs.readFile(filePath);
    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
  }
}
