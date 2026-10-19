export type SignatureGateErrorCode =
  /** The call cannot be signed as given: a missing or malformed name, arguments, line, signer or context. */
  | "invalid_call"
  /** The call document is larger than a signature request may carry. */
  | "call_too_large"
  /** An option of the gate is out of range. */
  | "invalid_options"
  /**
   * Clavis reported a completion that does not match the call: another signer, or another line shown.
   * Nothing runs. This points at a misconfigured store or a tampered record, not at the person.
   */
  | "receipt_mismatch";

export class SignatureGateError extends Error {
  readonly code: SignatureGateErrorCode;

  constructor(code: SignatureGateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SignatureGateError";
    this.code = code;
  }
}
