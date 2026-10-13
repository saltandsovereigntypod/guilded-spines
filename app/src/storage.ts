// Where the shelf lives on the phone: the app's Documents folder, which iOS
// backs up and never clears on its own (unlike a web view's storage).
//
//   Documents/library.json            books + settings, as the page's store
//   Documents/library.previous.json   the shelf as it was when the app opened
//   Documents/images/<key>.txt        cover and spine images (JPEG data URLs)

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { imageFileName, imageKeyFromFileName } from './inject';

const libraryFile = () => new File(Paths.document, 'library.json');
const previousFile = () => new File(Paths.document, 'library.previous.json');
const imagesDir = () => new Directory(Paths.document, 'images');

function readable(file: File): string | null {
  if (!file.exists) return null;
  const text = file.textSync();
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/** The saved shelf, or null if there is none yet. Falls back to the copy from the last opening if the main file is damaged. */
export function loadLibrary(): string | null {
  const text = readable(libraryFile()) ?? readable(previousFile());
  // One copy from each opening, so a bad session can always be stepped back from.
  if (text && readable(libraryFile())) {
    try {
      libraryFile().copySync(previousFile(), { overwrite: true });
    } catch {
      // Not fatal: the main file is still there.
    }
  }
  return text;
}

/** Writes the whole shelf: to a temporary file first, then moved over the old one. */
export function saveLibrary(json: string): void {
  JSON.parse(json); // refuse to write anything that would not load again
  const tmp = new File(Paths.document, 'library.json.tmp');
  tmp.create({ overwrite: true });
  tmp.write(json);
  tmp.moveSync(libraryFile(), { overwrite: true });
}

function ensureImagesDir(): Directory {
  const dir = imagesDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export async function imageGet(key: string): Promise<string | null> {
  const file = new File(ensureImagesDir(), imageFileName(key));
  return file.exists ? file.text() : null;
}

export function imagePut(key: string, dataUrl: string): void {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('Not an image');
  const file = new File(ensureImagesDir(), imageFileName(key));
  file.create({ overwrite: true });
  file.write(dataUrl);
}

export function imageDel(key: string): void {
  const file = new File(ensureImagesDir(), imageFileName(key));
  if (file.exists) file.delete();
}

export function imageKeys(): string[] {
  return ensureImagesDir()
    .list()
    .filter((entry): entry is File => entry instanceof File)
    .map((file) => imageKeyFromFileName(file.name))
    .filter((key): key is string => key !== null);
}

/** Hands an export to the share sheet (Save to Files, AirDrop, Mail…). */
export async function shareExport(filename: string, data: string): Promise<boolean> {
  const safeName = filename.replace(/[^\w.-]+/g, '-') || 'gilded-spines.json';
  const file = new File(Paths.cache, safeName);
  file.create({ overwrite: true });
  file.write(data);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: 'Save your Gilded Spines shelf',
  });
  return true;
}
