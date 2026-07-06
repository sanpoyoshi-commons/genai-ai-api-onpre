import type { AuthContext } from '../lib/auth/context.js';

// requireAuth（B-1）が検証済みクレームを注入する req.auth を Express.Request に拡張する。
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
