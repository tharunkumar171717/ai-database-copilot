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
  callbacks: {
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
