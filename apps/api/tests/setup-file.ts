import mongoose from "mongoose";
import { afterEach, beforeAll } from "vitest";
import { connectDb } from "../src/db/connect.js";

beforeAll(async () => {
  await connectDb();
});

afterEach(async () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return;
  }
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});
