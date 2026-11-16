// Logique de l'API des rapports du jour, indépendante du stockage (testable hors Netlify).
import { createHash } from "node:crypto";

const NUM = ["v", "f", "vc", "ac", "vr", "ar", "cc"];
const TXT = ["ch", "op"];
const MAX_NUM = 1e11, MAX_TXT = 1500, MAX_LPC = 12;
const DAY = 86400000;
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const isMonth = s => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const key = (id, month) => `r/${id}/${month}`;

function clean(rep) {
  if (!rep || typeof rep !== "object") return null;
  const out = {};
  for (const k of NUM) {
    if (rep[k] === undefined || rep[k] === null || rep[k] === "") continue;
    const n = Number(rep[k]);
    if (!Number.isFinite(n) || n < 0 || n > MAX_NUM) return null;
    out[k] = Math.round(n);
  }
  if (rep.lpc !== undefined) {
    if (!Array.isArray(rep.lpc) || rep.lpc.length > MAX_LPC) return null;
    out.lpc = rep.lpc.map(x => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= MAX_NUM ? Math.round(n) : 0; });
  }
  for (const k of TXT) if (typeof rep[k] === "string" && rep[k].trim()) out[k] = rep[k].trim().slice(0, MAX_TXT);
  return out;
}

export function makeHandler(store, ACL, now = () => Date.now()) {
  const who = (id, tok) => {
    const a = typeof id === "string" && ACL[id];
    if (!a || typeof tok !== "string" || tok.length > 200) return null;
    return createHash("sha256").update(tok).digest("hex") === a.h ? a : null;
  };
  const months = (list) => Array.isArray(list) ? [...new Set(list.filter(isMonth))].slice(0, 4) : [];
  const read = async (id, ms) => {
    const out = {};
    await Promise.all(ms.map(async m => { out[m] = (await store.get(key(id, m), { type: "json" })) || {}; }));
    return out;
  };

  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Requête illisible" }); }
    const me = who(body.id, body.tok);
    if (!me) return json(401, { error: "Accès refusé : reconnectez-vous." });

    if (body.action === "save") {
      if (me.r !== "com") return json(403, { error: "Seuls les commerciaux envoient un rapport." });
      if (!isDate(body.date)) return json(400, { error: "Date invalide" });
      const t = Date.parse(body.date + "T00:00:00Z"), n = now();
      if (t > n + DAY) return json(400, { error: "Impossible d'envoyer un rapport pour une date future." });
      if (t < n - 45 * DAY) return json(400, { error: "Rapport trop ancien (plus de 45 jours)." });
      const rep = clean(body.report);
      if (!rep) return json(400, { error: "Rapport invalide : vérifiez les montants saisis." });
      rep.at = new Date(n).toISOString();
      const k = key(body.id, body.date.slice(0, 7));
      const cur = (await store.get(k, { type: "json" })) || {};
      cur[body.date] = rep;
      await store.setJSON(k, cur);
      return json(200, { ok: true, report: rep });
    }
    if (body.action === "get") {
      return json(200, { data: await read(body.id, months(body.months)) });
    }
    if (body.action === "team") {
      if (!Array.isArray(me.t)) return json(403, { error: "Aucune équipe rattachée à ce compte." });
      const ms = months(body.months), data = {};
      await Promise.all(me.t.map(async m => { data[m] = await read(m, ms); }));
      return json(200, { data });
    }
    return json(400, { error: "Action inconnue" });
  };
}
