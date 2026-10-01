/** Expected access/contract failures leave the committed page state unchanged. */
export class AccessError extends Error {}
export class ReceiptConflict extends Error {}
export class CompatibilityError extends Error {}
