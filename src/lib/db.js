import mongoose from "mongoose";
import config from "../config/env.js";

export const connectDb = async () => {
  await mongoose.connect(config.mongoUri, { dbName: "orchestrator_db" });
  console.log("[db] connected to orchestrator_db");
};
