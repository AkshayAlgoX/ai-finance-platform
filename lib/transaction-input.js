import { z } from "zod";
import { Prisma } from "@prisma/client";

/**
 * Server-side validation for transaction writes.
 *
 * Server actions are public POST endpoints: the client form's validation
 * (app/lib/schema.js) does not protect them. Only these fields are written;
 * anything else in the payload (userId, status, id, ...) is ignored.
 */

const MAX_AMOUNT = 1_000_000_000; // 1e9 in the account currency

const amountSchema = z
  .any()
  .transform((v) => (typeof v === "number" || typeof v === "string" ? String(v).trim() : ""))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "Amount must be a positive number with at most 2 decimals")
  .transform((v) => new Prisma.Decimal(v))
  .refine((d) => d.gt(0) && d.lte(MAX_AMOUNT), "Amount must be greater than 0 and at most 1,000,000,000");

export const transactionInputSchema = z
  .object({
    type: z.enum(["INCOME", "EXPENSE"]),
    amount: amountSchema,
    description: z.string().max(500).optional().nullable(),
    date: z.coerce.date(),
    accountId: z.string().min(1),
    category: z.string().min(1).max(100),
    isRecurring: z.boolean().default(false),
    recurringInterval: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional().nullable(),
  })
  .refine((d) => !d.isRecurring || d.recurringInterval, {
    message: "Recurring interval is required for recurring transactions",
    path: ["recurringInterval"],
  });

export function parseTransactionInput(data) {
  const parsed = transactionInputSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid transaction");
  }
  return parsed.data;
}

/** Signed effect of a transaction on its account balance, as an exact Decimal. */
export function balanceDelta(type, amount) {
  const value = new Prisma.Decimal(amount);
  return type === "EXPENSE" ? value.neg() : value;
}
