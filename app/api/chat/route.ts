import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { askDatabaseCopilot, CopilotError } from "@/lib/gemini";
import { createQueryLog } from "@/lib/query-logs";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  message: z.string().trim().min(1, "Please enter a question").max(1000, "Question is too long (max 1000 characters)"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(20)
    .default([]),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "You must be signed in to use the copilot." }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const user = { userId: session.user.id ?? session.user.email, userEmail: session.user.email };

  try {
    // Only the last few turns are sent as context to keep prompts small.
    const result = await askDatabaseCopilot(body.message, body.history.slice(-10));
    const toolsUsed = [...new Set(result.toolCalls.map((t) => t.name))];

    await createQueryLog({
      ...user,
      question: body.message,
      generatedSql: result.sqlQueries.length ? result.sqlQueries.join(";\n") : null,
      toolUsed: toolsUsed.length ? toolsUsed.join(", ") : null,
      response: result.answer,
    });

    return NextResponse.json({
      answer: result.answer,
      toolsUsed,
      // Generated SQL is intentionally NOT sent to the browser; it is stored in query_logs (/logs).
    });
  } catch (err) {
    const error =
      err instanceof CopilotError
        ? err
        : new CopilotError("Something went wrong. Please try again.", 500, { cause: err });
    if (!(err instanceof CopilotError)) console.error("[api/chat] unexpected error:", (err as Error)?.message);

    await createQueryLog({
      ...user,
      question: body.message,
      generatedSql: null,
      toolUsed: null,
      response: `ERROR: ${error.userMessage}`,
    });

    return NextResponse.json({ error: error.userMessage }, { status: error.status });
  }
}
