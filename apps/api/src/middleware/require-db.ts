import type { NextFunction, Request, Response } from "express";
import { connectDb } from "../db/connect.js";

/**
 * Ensures a database connection is established before a route's handlers
 * run. Mount this on any router that needs Mongoose models; the health
 * route deliberately does NOT use this so it can respond without the DB.
 */
export async function requireDb(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await connectDb();
    next();
  } catch (error) {
    next(error);
  }
}
