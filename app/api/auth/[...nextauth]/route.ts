import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

export const { POST } = handlers;

/** Log every redirect back from Google (the OAuth callback) before Auth.js handles it. */
export async function GET(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname.endsWith("/callback/google")) {
    console.log("[auth] Google callback hit:", {
      callbackUrl: `${request.nextUrl.origin}${pathname}`,
      clientId: process.env.AUTH_GOOGLE_ID,
      hasCode: searchParams.has("code"), // the code itself is a credential - never log it
      error: searchParams.get("error"),
      errorDescription: searchParams.get("error_description"),
      scope: searchParams.get("scope"),
    });
  }
  return handlers.GET(request);
}
