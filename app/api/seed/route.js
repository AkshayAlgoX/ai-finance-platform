import { seedTransactions } from "@/actions/seed";

// Development helper: replaces the seeded account's transactions. It has no
// authentication, so it is disabled in production builds.
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  const result = await seedTransactions();
  return Response.json(result);
}
