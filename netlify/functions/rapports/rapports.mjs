// Fonction Netlify : enregistre et lit les rapports du jour (Netlify Blobs) et rédige l'insight (Netlify AI Gateway).
import { getStore } from "@netlify/blobs";
import ACL from "./acl.mjs";
import { makeHandler } from "./handler.mjs";

const MODELS = (process.env.INSIGHT_MODEL || "claude-haiku-4-5,claude-sonnet-4-5").split(",").map(s => s.trim()).filter(Boolean);

const SYSTEM = `Tu es l'analyste commercial terrain d'un distributeur de produits laitiers en Côte d'Ivoire.
Tu écris l'insight du rapport du jour d'un commercial, lu sur WhatsApp.
Règles : français simple, 2 ou 3 phrases, 55 mots maximum, aucun nom de personne ni de client, pas de liste, pas de titre,
un seul emoji au plus. Donne une lecture de sa journée (chiffres fournis) puis une action concrète pour demain,
en t'appuyant sur ses challenges et opportunités et sur les tendances remontées par les autres commerciaux.`;

async function ai(ctx) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "";
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const others = ctx.others.filter(o => o.ch || o.op).slice(0, 60)
    .map((o, i) => `- Commercial ${i + 1} : challenges « ${o.ch || "aucun"} » ; opportunités « ${o.op || "aucune"} »`).join("\n");
  const user = `Date : ${ctx.date}
Indicateurs du commercial (montants en FCFA, gap négatif = retard sur le plan) :
${JSON.stringify(ctx.kpi)}
Ses challenges : ${ctx.mine?.ch || "aucun"}
Ses opportunités : ${ctx.mine?.op || "aucune"}
Rapports des autres commerciaux du jour (${ctx.others.length} reçus) :
${others || "- aucun commentaire"}`;
  for (const model of MODELS) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(base + "/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 220, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
      if (text) return text.slice(0, 600);
    } catch { /* modèle suivant */ } finally { clearTimeout(timer); }
  }
  return "";
}

export default async (req) => {
  const store = getStore({ name: "rapports", consistency: "strong" });
  return makeHandler(store, ACL, undefined, ai)(req);
};

export const config = { path: "/api/rapports" };
