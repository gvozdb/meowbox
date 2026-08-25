export class OperationNeedsAttentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = OperationNeedsAttentionError.name;
  }
}

export class OperationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = OperationFailedError.name;
  }
}
