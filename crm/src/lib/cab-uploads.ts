import path from 'path';

export function getCabUploadsDir(): string {
  return process.env.CAB_UPLOADS_DIR || path.join(process.cwd(), 'uploads', 'cabs');
}
