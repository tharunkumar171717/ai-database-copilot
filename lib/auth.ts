import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Auth.js (NextAuth v5) with Google OAuth.
 * Reads AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET from the environment.
 * Sessions are stateless encrypted JWT cookies (httpOnly), so no session table is needed.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: { signIn: "/", error: "/" },
  trustHost: true,
  logger: {
    // Surface why a Google sign-in failed (e.g. redirect_uri_mismatch, invalid_client) in server logs.
    error(error) {
      const cause = (error as { cause?: { err?: Error } }).cause?.err;
      console.error("[auth] sign-in error:", (error as { type?: string }).type ?? error.name, "-", cause?.message ?? error.message);
    },
    warn(code) {
      console.warn("[auth] warning:", code);
    },
  },
  callbacks: {
    async signIn({ account, profile }) {
      // Runs after Google redirects back and the code is exchanged. Never log tokens.
      console.log("[auth] Google sign-in success:", {
        provider: account?.provider,
        clientId: process.env.AUTH_GOOGLE_ID,
        googleUserId: profile?.sub,
        email: profile?.email,
        name: profile?.name,
        emailVerified: profile?.email_verified,
      });
      return true;
    },
    async jwt({ token, profile }) {
      // Google's stable account id ("sub") is the user id we log.
      if (profile?.sub) token.sub = profile.sub;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
