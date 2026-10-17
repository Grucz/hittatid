// Hitta tid: raderar omröstningar automatiskt när deras sparandetid har gått ut.
// Körs en gång per dygn (schemalagd funktion i Netlify).
import { getDataStore, deletePollData } from "../lib/core.mjs";

export default async () => {
  const store = await getDataStore();
  const { blobs } = await store.list({ prefix: "poll/" });
  const now = Date.now();
  let removed = 0;
  for (const b of blobs) {
    const poll = await store.get(b.key, { type: "json" });
    if (poll?.deleteAt && Date.parse(poll.deleteAt) < now) {
      await deletePollData(store, b.key.split("/")[1]);
      removed++;
    }
  }
  console.log(`Städning klar: ${removed} omröstningar raderade.`);
  return new Response("ok");
};

export const config = { schedule: "@daily" };
