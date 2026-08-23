/**
 * Image format detection by content, never by claim.
 *
 * A client tells us a file is a JPEG by sending `data:image/jpeg;base64,…` or by
 * naming it `.jpg`. Neither is evidence. The bytes are the evidence, so this
 * module reads them and the client's claim is discarded before it reaches
 * anything that stores or serves it.
 *
 * The allowlist is deliberately short, and what is *missing* is the point:
 *
 *  - **SVG is refused.** It is an XML document that may contain `<script>`, so
 *    serving one from our origin is stored XSS with extra steps. It also passes
 *    a naive "is it an image?" test, which is exactly why it needs naming here
 *    rather than being left to fall off the end of a switch.
 *  - **No TIFF, BMP, ICO, AVIF, HEIC.** Each is another decoder to trust. A
 *    friend giving away a chair does not need them.
 */

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/** The formats we will store and serve. Content type is derived from this. */
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/**
 * Identify an image from its leading bytes, or `null` if it is not one of the
 * four formats we accept.
 *
 * Returning `null` rather than throwing keeps the caller's control flow honest:
 * an unrecognised upload is a validation failure, not an exception.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  // JPEG: FF D8 FF. Every variant (JFIF, Exif, raw) shares this prefix.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: the 8-byte signature, including the CRLF/EOF bytes that exist to
  // detect exactly the kind of transfer corruption base64 avoids.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // GIF: "GIF87a" or "GIF89a".
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';

  // WebP is a RIFF container: "RIFF" ���� "WEBP". Both halves are checked -
  // "RIFF" alone is also how a WAV file starts.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Decode base64 to bytes, refusing anything malformed or oversized.
 *
 * The size is checked *before* decoding as well as after: a caller that streams
 * a gigabyte of base64 should be refused without us first materialising it.
 * The route's `bodyLimit` is the real defence; this is the one behind it.
 */
export function decodePhoto(base64: string): Uint8Array | null {
  // 4 base64 chars per 3 bytes, so this bounds the decoded size from the
  // encoded length without doing the work.
  if (base64.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }

  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) return null;
  return bytes;
}
