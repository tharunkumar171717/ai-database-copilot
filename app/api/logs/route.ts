import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listQueryLogs } from "@/lib/query-logs";

export const runtime = "nodejs";

/** GET /api/logs?page=1&q=search - paginated query logs, newest first. */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to view logs." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  try {
    const result = await listQueryLogs({
      page: Number(searchParams.get("page") ?? "1"),
      search: searchParams.get("q") ?? "",
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/logs] failed:", (err as Error).message);
    return NextResponse.json({ error: "Could not load logs. Please try again." }, { status: 500 });
  }
}
