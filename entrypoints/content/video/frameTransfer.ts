/** A captured frame cannot be serialized for transport (normally cross-origin canvas taint). */
export class PermanentFrameTransferError extends Error {
  override readonly name = 'PermanentFrameTransferError';
}

export function isWriteOnlyCanvasError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'SecurityError' || /write-only canvas|cannot get blob|taint/i.test(error.message))
  );
}
