import { TokenVerifier } from "../auth/token-verifier.ts";

export interface LedgerEntry {
  invoiceId: string;
  idempotencyKey: string;
  tenantId: string;
  amountCents: number;
  status: "pending" | "settled" | "void";
}

export class InvoiceLedger {
  private readonly byKey = new Map<string, LedgerEntry>();
  private readonly verifier: TokenVerifier;

  constructor(verifier: TokenVerifier) {
    this.verifier = verifier;
  }

  async recordCharge(
    authToken: string,
    invoiceId: string,
    idempotencyKey: string,
    amountCents: number,
  ): Promise<LedgerEntry> {
    const claims = await this.verifier.verify(authToken);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }
    const entry: LedgerEntry = {
      invoiceId,
      idempotencyKey,
      tenantId: claims.tenantId,
      amountCents,
      status: "pending",
    };
    this.byKey.set(idempotencyKey, entry);
    return entry;
  }

  settleInvoice(idempotencyKey: string): LedgerEntry {
    const entry = this.byKey.get(idempotencyKey);
    if (!entry) {
      throw new Error(`Missing invoice for key ${idempotencyKey}`);
    }
    entry.status = "settled";
    return entry;
  }
}
