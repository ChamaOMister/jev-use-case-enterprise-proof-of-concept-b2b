import type { Db } from "../data/db.js";

/** invoices.from_pending_delivery, read here so the Phase 1 loader stays unchanged. */
export async function loadFromPendingDelivery(db: Db): Promise<Map<string, boolean>> {
  const rows = await db.all(`SELECT CAST(invoice_number AS VARCHAR) AS invoice_number, from_pending_delivery FROM invoices`);
  return new Map(
    rows.map((r) => {
      const n = r.invoice_number;
      const v = r.from_pending_delivery;
      if (typeof n !== "string" || typeof v !== "boolean") throw new Error(`Unexpected from_pending_delivery row ${JSON.stringify(r)}`);
      return [n, v];
    }),
  );
}
