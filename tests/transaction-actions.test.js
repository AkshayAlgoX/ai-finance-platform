import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Server-action behaviour of actions/transaction.js with an in-memory fake
 * of the Prisma client. Clerk, Arcjet, Next cache and Gemini are stubbed;
 * nothing touches a database or the network.
 */

const state = vi.hoisted(() => ({ userId: "clerk_alice", calls: [] }));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: state.userId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@arcjet/next", () => ({ request: async () => ({}) }));
vi.mock("@/lib/arcjet", () => ({ default: { protect: async () => ({ isDenied: () => false }) } }));
vi.mock("@google/generative-ai", () => ({ GoogleGenerativeAI: class {} }));

const users = { clerk_alice: { id: "u_alice" }, clerk_bob: { id: "u_bob" } };
const accounts = {
  acc_alice_1: { id: "acc_alice_1", userId: "u_alice" },
  acc_alice_2: { id: "acc_alice_2", userId: "u_alice" },
  acc_bob: { id: "acc_bob", userId: "u_bob" },
};
let transactions;

function owned(where) {
  const a = accounts[where.id];
  return a && (!where.userId || a.userId === where.userId) ? a : null;
}

const fakeTx = {
  transaction: {
    create: async ({ data }) => {
      state.calls.push(["transaction.create", data]);
      return { id: "t_new", ...data };
    },
    update: async ({ where, data }) => {
      state.calls.push(["transaction.update", where, data]);
      return { ...transactions[where.id], ...data };
    },
  },
  account: {
    update: async ({ where, data }) => {
      state.calls.push(["account.update", where, data]);
      if (!owned(where)) throw new Error("Record to update not found.");
      return accounts[where.id];
    },
  },
};

vi.mock("@/lib/prisma", () => ({
  db: {
    user: { findUnique: async ({ where }) => users[where.clerkUserId] ?? null },
    account: { findUnique: async ({ where }) => owned(where) },
    transaction: {
      findUnique: async ({ where }) => {
        const t = transactions[where.id];
        return t && t.userId === where.userId ? t : null;
      },
    },
    $transaction: async (fn) => fn(fakeTx),
  },
}));

const { createTransaction, updateTransaction } = await import("../actions/transaction.js");

const base = { type: "EXPENSE", amount: 0.1, date: "2026-10-01", accountId: "acc_alice_1", category: "food" };
const accountUpdates = () => state.calls.filter((c) => c[0] === "account.update");
const inc = (call) => call[2].balance.increment.toString();

beforeEach(() => {
  state.userId = "clerk_alice";
  state.calls = [];
  transactions = {
    t1: { id: "t1", userId: "u_alice", accountId: "acc_alice_1", type: "EXPENSE", amount: new Prisma.Decimal("40.00") },
  };
});

describe("createTransaction", () => {
  it("applies the balance change as an atomic, exact increment", async () => {
    await createTransaction({ ...base, amount: 0.1 });
    const [upd] = accountUpdates();
    expect(upd[1]).toEqual({ id: "acc_alice_1", userId: "u_alice" });
    expect(upd[2]).not.toHaveProperty("balance.set");
    expect(inc(upd)).toBe("-0.1");
  });

  it("writes only whitelisted fields and the caller's userId", async () => {
    await createTransaction({ ...base, userId: "u_bob", status: "FAILED", id: "chosen", lastProcessed: "2020-01-01" });
    const [, data] = state.calls.find((c) => c[0] === "transaction.create");
    expect(data.userId).toBe("u_alice");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("id");
    expect(data).not.toHaveProperty("lastProcessed");
  });

  it.each([["abc"], [-5], [0], [1.234], ["1e3"], [2_000_000_000], [NaN]])("rejects amount %j before writing", async (amount) => {
    await expect(createTransaction({ ...base, amount })).rejects.toThrow(/Amount/);
    expect(state.calls).toEqual([]);
  });

  it("refuses another user's account", async () => {
    await expect(createTransaction({ ...base, accountId: "acc_bob" })).rejects.toThrow("Account not found");
    expect(state.calls).toEqual([]);
  });
});

describe("updateTransaction", () => {
  it("cannot touch another user's account balance", async () => {
    // Previously: the victim's balance was incremented and the transaction moved there.
    await expect(
      updateTransaction("t1", { ...base, type: "INCOME", amount: 1_000_000, accountId: "acc_bob" })
    ).rejects.toThrow("Account not found");
    expect(state.calls).toEqual([]);
  });

  it("applies the exact net change on the same account", async () => {
    await updateTransaction("t1", { ...base, amount: "25.50" });
    const ups = accountUpdates();
    expect(ups).toHaveLength(1);
    expect(inc(ups[0])).toBe("14.5"); // -25.50 - (-40.00)
  });

  it("reverses the old effect when moving between the caller's accounts", async () => {
    await updateTransaction("t1", { ...base, amount: "25.50", accountId: "acc_alice_2" });
    const ups = accountUpdates();
    expect(ups.map((u) => [u[1].id, inc(u)])).toEqual([
      ["acc_alice_1", "40"],
      ["acc_alice_2", "-25.5"],
    ]);
  });

  it("ignores a client-supplied userId", async () => {
    await updateTransaction("t1", { ...base, userId: "u_bob" });
    const [, , data] = state.calls.find((c) => c[0] === "transaction.update");
    expect(data).not.toHaveProperty("userId");
  });
});

describe("GET /api/seed", () => {
  it("is disabled in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@/actions/seed", () => ({ seedTransactions: vi.fn() }));
    const { GET } = await import("../app/api/seed/route.js");
    const res = await GET();
    expect(res.status).toBe(404);
    vi.unstubAllEnvs();
  });
});
