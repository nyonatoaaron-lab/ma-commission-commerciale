// Fonction Netlify : enregistre et lit les rapports du jour (stockage Netlify Blobs).
import { getStore } from "@netlify/blobs";
import ACL from "./acl.mjs";
import { makeHandler } from "./handler.mjs";

export default async (req) => {
  const store = getStore({ name: "rapports", consistency: "strong" });
  return makeHandler(store, ACL)(req);
};

export const config = { path: "/api/rapports" };
