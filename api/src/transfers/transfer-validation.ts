export interface TransferActor {
  userId: string;
  role: string;
}

export const TRANSFER_SOURCE_KIND = /^[A-Z][A-Z0-9_]{1,63}$/;
export const TRANSFER_RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
export const TRANSFER_CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
export const TRANSFER_FILENAME = /^[^\x00-\x1f\x7f/\\]{1,255}$/;
export const TRANSFER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertTransferActor(actor: TransferActor): void {
  if (!TRANSFER_UUID.test(actor.userId) || !['ADMIN', 'MANAGER'].includes(actor.role)) {
    throw new Error('Transfer actor is invalid');
  }
}

export function assertTransferResource(sourceKind: string, resourceId: string): void {
  if (!TRANSFER_SOURCE_KIND.test(sourceKind) || !TRANSFER_RESOURCE_ID.test(resourceId)) {
    throw new Error('Transfer resource is invalid');
  }
}

export function assertTransferPresentation(filename: string, contentType: string): void {
  if (
    !TRANSFER_FILENAME.test(filename) ||
    Buffer.byteLength(filename, 'utf8') > 255 ||
    !TRANSFER_CONTENT_TYPE.test(contentType)
  ) {
    throw new Error('Transfer presentation is invalid');
  }
}
