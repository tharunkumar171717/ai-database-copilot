"use client";

import { useEffect } from "react";

/**
 * Prints the Google OAuth client id + callback URL in the browser console (debug aid).
 * The client id is public (it is visible in Google's sign-in URL); the secret is never sent.
 */
export default function ClientIdLogger({ clientId }: { clientId: string | null }) {
  useEffect(() => {
    console.log("[auth] Google OAuth client_id:", clientId ?? "(AUTH_GOOGLE_ID not set)");
    console.log("[auth] Google callback URL:", `${window.location.origin}/api/auth/callback/google`);
  }, [clientId]);
  return null;
}
