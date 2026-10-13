// Answers the page's requests (see APP_BRIDGE in build.py).

import { imageDel, imageGet, imageKeys, imagePut, saveLibrary, shareExport } from './storage';

export type Request = { id: number; op: string; args: unknown };

export function parseRequest(data: string): Request | null {
  try {
    const msg = JSON.parse(data);
    if (msg && typeof msg.id === 'number' && typeof msg.op === 'string') return msg as Request;
  } catch {
    // Not one of ours.
  }
  return null;
}

export async function handle(req: Request): Promise<unknown> {
  const args = req.args as any;
  switch (req.op) {
    case 'store.save':
      if (typeof args !== 'string') throw new Error('Expected the shelf as text');
      saveLibrary(args);
      return true;
    case 'img.get':
      return imageGet(String(args));
    case 'img.put':
      imagePut(String(args?.key), args?.value);
      return true;
    case 'img.del':
      imageDel(String(args));
      return true;
    case 'img.keys':
      return imageKeys();
    case 'share':
      return shareExport(String(args?.filename || 'gilded-spines.json'), String(args?.data ?? ''));
    default:
      throw new Error(`Unknown request: ${req.op}`);
  }
}
