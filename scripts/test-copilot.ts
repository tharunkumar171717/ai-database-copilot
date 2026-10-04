/**
 * Asks the copilot the example questions end-to-end (Gemini -> MCP -> PostgreSQL).
 *   npm run test:copilot
 */
import "dotenv/config";
import { askDatabaseCopilot } from "../lib/gemini";

const questions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "What tables are available?",
      "How many users do we have?",
      "How many pending orders are there?",
      "What are the top 5 products by sales?",
      "Which customer has placed the most orders?",
      "Show me orders above 50000.",
      "Explain the relationship between users and orders.",
      "What products are out of stock?",
      "Delete all cancelled orders.",
      "What is the capital of France?",
      "What is the average delivery time for orders?",
    ];

async function main() {
  for (const q of questions) {
    const started = Date.now();
    try {
      const r = await askDatabaseCopilot(q);
      console.log(`\nQ: ${q}  (${Date.now() - started}ms)`);
      console.log(`tools: ${r.toolCalls.map((t) => t.name + (t.isError ? "(error)" : "")).join(", ") || "none"}`);
      if (r.sqlQueries.length) console.log(`sql: ${r.sqlQueries.join(" | ")}`);
      console.log(`A: ${r.answer}`);
    } catch (err) {
      console.log(`\nQ: ${q}\nERROR: ${(err as Error).message}`);
    }
  }
}
main();
