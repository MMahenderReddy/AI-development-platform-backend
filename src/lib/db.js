import mongoose from "mongoose";
import config from "../config/env.js";

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5_000;

export const connectDb = async () => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(config.mongoUri, {
        dbName: "orchestrator_db",
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS: 45_000,
      });
      console.log("[db] connected to orchestrator_db");
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`[db] connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message.slice(0, 120)} — retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
};
