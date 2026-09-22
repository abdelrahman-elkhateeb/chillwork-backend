import mongoose from "mongoose";
import { afterEach, beforeAll } from "vitest";
import { connectDb } from "../src/db/connect.js";
import { User } from "../src/modules/users/user.model.js";

beforeAll(async () => {
  await connectDb();
  // The concurrent-duplicate-registration test relies on the unique index
  // on User.email actually existing in MongoDB, not just on the schema —
  // Model.init() waits for index builds to finish instead of racing them.
  await User.init();
});

afterEach(async () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return;
  }
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});
