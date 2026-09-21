import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { readAuthCookies } from "../modules/auth/auth.cookies.js";
import { verifyAccessToken } from "../modules/auth/auth.tokens.js";
import { validateSessionContext } from "../modules/auth/auth.service.js";
import { Session } from "../modules/auth/session.model.js";
import type { UserDocument } from "../modules/users/user.model.js";
import { HttpError } from "../lib/http-error.js";

export interface AuthContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  companyId: Types.ObjectId;
  user: UserDocument;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Protected-route gate. A valid, unexpired JWT is necessary but never
 * sufficient — every request re-validates the referenced session
 * (revocation, rolling/absolute expiry), the user (active), and the
 * user's current company membership straight from the database. See
 * docs/api.md "Session architecture" for why this can't be shortcut.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { accessToken } = readAuthCookies(req);
    if (!accessToken) {
      throw HttpError.unauthorized();
    }

    const verified = await verifyAccessToken(accessToken);
    if (!verified.valid || !Types.ObjectId.isValid(verified.claims.sid)) {
      throw HttpError.unauthorized();
    }

    const session = await Session.findById(verified.claims.sid);
    if (!session) {
      throw HttpError.unauthorized();
    }

    const { user } = await validateSessionContext(session, new Date());

    req.auth = {
      userId: user._id,
      sessionId: session._id,
      companyId: session.companyId,
      user,
    };

    next();
  } catch (error) {
    next(error);
  }
}
