import OpenAI from "openai";
import { UPSTAGE_BASE_URL, DEFAULT_MODEL } from "./src/solar/constants.js";

const apiKey = process.env.UPSTAGE_API_KEY;
if (!apiKey) {
  console.error("UPSTAGE_API_KEY not set");
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL: UPSTAGE_BASE_URL });

async function test() {
  try {
    const response = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 5,
    });
    console.log("Success:", response.data.choices[0].message.content);
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
  }
}

test();