// Logique de l'API des rapports du jour, indépendante du stockage et de l'IA (testable hors Netlify).
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
const sha = s => createHash("sha256").update(s).digest("hex");

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

/* Thèmes repérés dans les challenges, pour l'insight automatique (repli sans IA) */
const THEMES = [
  ["les ruptures de stock", /ruptur|stock|manque de produit|pas de produit|livraison/i],
  ["la concurrence", /concurren|promo|prix bas|moins cher/i],
  ["les prix", /prix|cher|tarif/i],
  ["les clients fermés ou absents", /ferm|absent|inventaire/i],
  ["les paiements et le crédit", /paie|crédit|credit|dette|impay/i],
  ["le transport", /panne|véhicule|vehicule|carbur|camion|route/i],
  ["les avaries", /avari|périm|perim|cass|froid|frigo/i],
];
const fr = n => Math.round(n).toLocaleString("fr-FR");
export function autoInsight(ctx) {
  const parts = [], k = ctx.kpi || {};
  if (typeof k.gapM === "number") {
    if (k.gapM < 0 && k.restants > 0) parts.push(`Retard de ${fr(-k.gapM)} FCFA sur le plan du mois : visez ${fr(k.dynNext || 0)} FCFA par jour sur les ${k.restants} jours de vente restants.`);
    else if (k.gapM >= 0) parts.push(`En avance de ${fr(k.gapM)} FCFA sur le plan du mois : gardez le rythme.`);
  }
  if (typeof k.vPct === "number" && k.vPct < 0.95) parts.push("Visites sous l'objectif du jour : préparez la tournée de demain dès ce soir.");
  const texts = ctx.others.map(o => o.ch || "").concat(ctx.mine?.ch || "");
  const counts = THEMES.map(([n, re]) => [n, texts.filter(t => re.test(t)).length]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  if (counts.length) parts.push(`Sur le terrain, le sujet le plus remonté est ${counts[0][0]} (${counts[0][1]} rapport${counts[0][1] > 1 ? "s" : ""}).`);
  const ops = ctx.others.filter(o => o.op).length + (ctx.mine?.op ? 1 : 0);
  if (ops) parts.push(`${ops} opportunité${ops > 1 ? "s" : ""} signalée${ops > 1 ? "s" : ""} aujourd'hui : à transformer en commandes.`);
  return parts.slice(0, 3).join(" ") || "Envoyez vos chiffres du jour pour recevoir une analyse.";
}

export function makeHandler(store, ACL, now = () => Date.now(), ai = null) {
  const who = (id, tok) => {
    const a = typeof id === "string" && ACL[id];
    if (!a || typeof tok !== "string" || tok.length > 200) return null;
    return sha(tok) === a.h ? a : null;
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
      // index du jour : sert à l'insight global (les noms ne sont jamais transmis à l'IA)
      const net = (rep.vc || 0) + (rep.vr || 0) - (rep.ac || 0) - (rep.ar || 0);
      await store.setJSON(`d/${body.date}/${body.id}`, { ch: rep.ch || "", op: rep.op || "", net, v: rep.v || 0, f: rep.f || 0 });
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
    if (body.action === "insight") {
      if (me.r !== "com") return json(403, { error: "Insight réservé aux rapports des commerciaux." });
      if (!isDate(body.date)) return json(400, { error: "Date invalide" });
      const mine = ((await store.get(key(body.id, body.date.slice(0, 7)), { type: "json" })) || {})[body.date] || null;
      let others = [];
      try {
        const { blobs = [] } = await store.list({ prefix: `d/${body.date}/` });
        others = (await Promise.all(blobs.filter(b => !b.key.endsWith("/" + body.id)).slice(0, 150).map(b => store.get(b.key, { type: "json" })))).filter(Boolean);
      } catch { others = []; }
      const kpi = body.kpi && typeof body.kpi === "object"
        ? Object.fromEntries(Object.entries(body.kpi).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).slice(0, 30)) : {};
      const ctx = { date: body.date, kpi, mine: mine && { ch: mine.ch || "", op: mine.op || "" },
        others: others.map(o => ({ ch: String(o.ch || "").slice(0, 300), op: String(o.op || "").slice(0, 300), net: o.net || 0 })) };
      const sig = sha(JSON.stringify(ctx));
      const cacheKey = `i/${body.id}/${body.date}`;
      const cached = await store.get(cacheKey, { type: "json" });
      if (cached && cached.sig === sig) return json(200, { text: cached.text, source: cached.source, n: others.length });
      let text = "", source = "auto";
      if (ai) { try { text = (await ai(ctx)) || ""; if (text) source = "ia"; } catch { text = ""; } }
      if (!text) text = autoInsight(ctx);
      await store.setJSON(cacheKey, { sig, text, source });
      return json(200, { text, source, n: others.length });
    }
    return json(400, { error: "Action inconnue" });
  };
}
