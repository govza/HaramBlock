/** A captured frame cannot be serialized for transport (normally cross-origin canvas taint). */
export class PermanentFrameTransferError extends Error {
  override readonly name = 'PermanentFrameTransferError';
}

export function isWriteOnlyCanvasError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'SecurityError' ||
      // 'origin-clean': Chrome's DataCloneError for a tainted bitmap at the port.
      /write-only canvas|cannot get blob|taint|origin-clean/i.test(error.message))
  );
}
