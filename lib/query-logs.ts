import "server-only";
import { prisma } from "./db";

/** Persistence for the copilot_query_logs audit table (who asked what, when, which tool, which SQL, which answer). */

export type NewQueryLog = {
  userId: string;
  userEmail: string;
  question: string;
  generatedSql: string | null;
  toolUsed: string | null;
  response: string;
};

export async function createQueryLog(entry: NewQueryLog) {
  try {
    await prisma.queryLog.create({ data: entry });
  } catch (err) {
    // Logging must never break the chat response, but failures should be visible in server logs.
    console.error("[copilot_query_logs] failed to write log:", (err as Error).message);
  }
}

/**
 * Hard cap on the total number of questions this deployment will answer (all users combined).
 * Every answered or failed question is a row in copilot_query_logs, so the row count is the usage.
 */
export const QUESTION_LIMIT = 100;

export async function getRemainingQuestions(): Promise<number> {
  const used = await prisma.queryLog.count();
  return Math.max(0, QUESTION_LIMIT - used);
}

export const LOGS_PAGE_SIZE = 20;

export async function listQueryLogs({ page = 1, search = "" }: { page?: number; search?: string }) {
  const term = search.trim().slice(0, 200);
  const where = term
    ? {
        OR: [
          { question: { contains: term, mode: "insensitive" as const } },
          { userEmail: { contains: term, mode: "insensitive" as const } },
        ],
      }
    : {};

  const total = await prisma.queryLog.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / LOGS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);

  const logs = await prisma.queryLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (currentPage - 1) * LOGS_PAGE_SIZE,
    take: LOGS_PAGE_SIZE,
  });

  return {
    logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    total,
    page: currentPage,
    totalPages,
    search: term,
  };
}

export type QueryLogRow = Awaited<ReturnType<typeof listQueryLogs>>["logs"][number];
