const router  = require('express').Router();
const { auth } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const BASE_SYSTEM_PROMPT = `Du bist ein professionelles Business-Intelligence-System für Lead-Recherche.
Deine Aufgabe: Echte, nachweislich existierende Unternehmen mit verfügbaren öffentlichen Kontaktdaten liefern.

ABSOLUT VERBOTEN:
- Daten erfinden oder halluzinieren
- Generische Dummy-E-Mails
- Fiktive Telefonnummern
- Nicht existierende Unternehmen

REGELN:
- Nur real existierende Firmen aus deinem Wissen
- E-Mails NUR wenn öffentlich im Impressum bekannt
- Telefon NUR wenn öffentlich bekannt
- Fehlende Werte als null
- confidence: 85-100=gut verifiziert, 65-84=bekannt, 40-64=unsicher
- Lieber 3 echte Leads als 10 erfundene
- Antworte NUR mit einem validen JSON-Array`;

const EXTRACT_SYSTEM_PROMPT = `Du bist ein Datenextraktions-System für Business-Leads.
Du erhältst ECHTE Live-Suchergebnisse und extrahierst daraus strukturierte Unternehmens-Daten.

REGELN:
- Extrahiere NUR was in den Suchergebnissen steht — erfinde NICHTS
- E-Mails und Telefonnummern nur wenn explizit in den Ergebnissen enthalten
- Fehlende Felder als null
- Duplikate entfernen — jedes Unternehmen nur einmal
- confidence: 85-100=direkt aus Ergebnissen, 65-84=aus Kontext erschließbar, 40-64=unsicher
- Antworte NUR mit einem validen JSON-Array`;

async function fetchSerperResults(query, location) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return null;
  try {
    const q = location ? `${query} ${location}` : query;
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, gl: 'de', hl: 'de', num: 20 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.organic || [];
  } catch { return null; }
}

async function fetchPlacesResults(query, location) {
  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!placesKey) return null;
  try {
    const q = location ? `${query} ${location}` : query;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${placesKey}&language=de&region=de`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results || []).slice(0, 20);
  } catch { return null; }
}

// POST /api/generate — KI-Lead-Generierung (Admin oder can_generate_leads)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung für Lead-Generierung' });

  const { query, location, size, max_leads, sources, fields, extra } = req.body;
  if (!query) return res.status(400).json({ error: 'Suchbegriff fehlt' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Claude API Key nicht konfiguriert (.env)' });

  const maxL    = Math.min(parseInt(max_leads) || 10, 100);
  const srcArr  = Array.isArray(sources) ? sources : ['web'];
  const useGoogle = srcArr.includes('google') || srcArr.includes('web');
  const useMaps   = srcArr.includes('maps');

  // Fetch live data in parallel
  const [serperResults, placesResults] = await Promise.all([
    useGoogle ? fetchSerperResults(query, location) : Promise.resolve(null),
    useMaps   ? fetchPlacesResults(query, location) : Promise.resolve(null),
  ]);

  const hasRealData = (serperResults && serperResults.length > 0) ||
                      (placesResults  && placesResults.length  > 0);

  let systemPrompt, userPrompt;

  if (hasRealData) {
    systemPrompt = EXTRACT_SYSTEM_PROMPT;

    let contextBlock = '';
    if (serperResults && serperResults.length > 0) {
      contextBlock += '\n=== GOOGLE SUCHERGEBNISSE (LIVE) ===\n';
      serperResults.slice(0, 15).forEach((r, i) => {
        contextBlock += `\n[${i + 1}] ${r.title}\nURL: ${r.link}\nBeschreibung: ${r.snippet || ''}\n`;
      });
    }
    if (placesResults && placesResults.length > 0) {
      contextBlock += '\n=== GOOGLE MAPS ERGEBNISSE (LIVE) ===\n';
      placesResults.forEach((p, i) => {
        contextBlock += `\n[${i + 1}] ${p.name}\nAdresse: ${p.formatted_address || ''}\n`;
        if (p.formatted_phone_number) contextBlock += `Telefon: ${p.formatted_phone_number}\n`;
        if (p.website) contextBlock += `Website: ${p.website}\n`;
        if (p.rating) contextBlock += `Bewertung: ${p.rating} (${p.user_ratings_total || 0} Bewertungen)\n`;
      });
    }

    userPrompt = `Extrahiere bis zu ${maxL} Unternehmen aus diesen ECHTEN Live-Suchergebnissen:

Ursprüngliche Suche: "${query}"${location ? ` in "${location}"` : ''}
${size ? `Unternehmensgröße: ${size}` : ''}
${extra ? `Zusätzliche Kriterien: ${extra}` : ''}
${contextBlock}
Antworte NUR mit diesem JSON-Array:
[{"company":"Name","ceo":null,"email":null,"phone":null,"location":"Stadt","website":null,"linkedin_url":null,"industry":"Branche","employees":null,"revenue":null,"source":"google","confidence":85,"notes":null}]`;
  } else {
    systemPrompt = BASE_SYSTEM_PROMPT;
    userPrompt = `Recherchiere bis zu ${maxL} ECHTE Unternehmen aus deinem Wissen:

Suchbegriff: "${query}"
${location ? `Standort: "${location}"` : ''}
${size ? `Größe: ${size}` : ''}
${extra ? `Kriterien: ${extra}` : ''}
Quellen: ${srcArr.join(', ')}

Antworte NUR mit diesem JSON-Array:
[{"company":"Name","ceo":null,"email":null,"phone":null,"location":"Stadt","website":null,"linkedin_url":null,"industry":"Branche","employees":null,"revenue":null,"source":"web","confidence":70,"notes":null}]`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API HTTP ${response.status}`);
    }

    const data    = await response.json();
    const rawText = data.content?.find(b => b.type === 'text')?.text || '';

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Kein JSON-Array in Antwort');

    let leads = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(leads)) throw new Error('Ungültiges Format');

    leads = leads
      .map(l => ({
        company:      l.company || null,
        ceo:          l.ceo || null,
        email:        l.email || null,
        phone:        l.phone || null,
        location:     l.location || null,
        website:      l.website || null,
        linkedin_url: l.linkedin_url || null,
        industry:     l.industry || null,
        employees:    l.employees != null ? String(l.employees) : null,
        revenue:      l.revenue || null,
        source:       l.source || srcArr[0] || 'web',
        confidence:   Math.min(100, Math.max(0, parseInt(l.confidence) || 50)),
        notes:        l.notes || null,
      }))
      .filter(l => l.company);

    await log(req.user.id, 'leads_generate', 'system', null,
      { query, location, count: leads.length, real_data: hasRealData }, req.ip);

    res.json({ ok: true, leads, real_data: hasRealData });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
