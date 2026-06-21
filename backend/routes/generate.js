const router  = require('express').Router();
const { auth, adminOnly } = require('../middleware/auth');
const { log } = require('../helpers/logger');

const SYSTEM_PROMPT = `Du bist ein professionelles Business-Intelligence-System für Lead-Recherche.
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

// POST /api/generate — KI-Lead-Generierung (Admin oder can_generate_leads)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.can_generate_leads)
    return res.status(403).json({ error: 'Keine Berechtigung für Lead-Generierung' });

  const { query, location, size, max_leads, sources, fields, extra } = req.body;
  if (!query) return res.status(400).json({ error: 'Suchbegriff fehlt' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Claude API Key nicht konfiguriert (.env)' });

  const maxL = Math.min(parseInt(max_leads) || 10, 50);
  const srcList = Array.isArray(sources) ? sources.join(', ') : 'web';

  const userPrompt = `Recherchiere bis zu ${maxL} ECHTE Unternehmen:

Suchbegriff: "${query}"
${location ? `Standort: "${location}"` : ''}
${size ? `Größe: ${size}` : ''}
${extra ? `Kriterien: ${extra}` : ''}
Bevorzugte Quellen: ${srcList}

Gib nur real existierende Unternehmen zurück. Unbekannte Felder als null.

Antworte NUR mit diesem JSON-Array:
[{"company":"Name","ceo":null,"email":null,"phone":null,"location":"Stadt","website":null,"linkedin_url":null,"industry":"Branche","employees":null,"revenue":null,"source":"${sources?.[0]||'web'}","confidence":80,"notes":null}]`;

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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API HTTP ${response.status}`);
    }

    const data = await response.json();
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
        source:       l.source || sources?.[0] || 'web',
        confidence:   Math.min(100, Math.max(0, parseInt(l.confidence) || 50)),
        notes:        l.notes || null,
      }))
      .filter(l => l.company);

    await log(req.user.id, 'leads_generate', 'system', null,
      { query, location, count: leads.length }, req.ip);

    res.json({ ok: true, leads });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
