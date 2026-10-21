import { createSignatureGate, type SignatureGate, type SignatureGateOptions } from "../gate.js";

export type TestClock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** The gate on a given clock. `runtime` is not part of the published options. */
export function createSignatureGateForTest(options: SignatureGateOptions, clock: TestClock): SignatureGate {
  return createSignatureGate({ ...options, runtime: clock } as SignatureGateOptions);
}
