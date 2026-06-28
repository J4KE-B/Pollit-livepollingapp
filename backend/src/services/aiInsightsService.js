const { GoogleGenerativeAI } = require('@google/generative-ai');
const promptGuard = require('../security/promptGuard');

let genAI = null;
function getClient() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

/**
 * Build the Gemini prompt.
 *
 * SECURITY: audience free text reaches this prompt by TWO paths, and both are guarded through
 * src/security/promptGuard.js before the prompt is built:
 *   (a) `textSamples` -- the sampled open-text answers, and
 *   (b) `aggregated.results` -- for text/wordcloud polls the breakdown is grouped by the answer
 *       string, so each entry is raw audience text too (guarded via promptGuard.guardResults).
 * Guarding (a) but not (b) would let a payload ride in through the results breakdown untouched.
 *
 * Each raw string is run through promptGuard BEFORE it reaches this function's output:
 *   1. heuristics flag known injection shapes (high-severity payloads are redacted outright),
 *   2. sanitisation strips zero-width/bidi chars and chat-template markers,
 *   3. whatever survives is embedded inside a NONCE-DELIMITED block the model is told to treat
 *      strictly as data.
 * Layer 3 carries the weight: the attacker cannot forge the closing delimiter without guessing a
 * 96-bit per-request nonce, so they cannot escape the data region back into instruction context --
 * even with a phrasing our heuristics have never seen.
 *
 * Poll questions/options are presenter-authored (authenticated), so lower risk than audience text,
 * but we still sanitise them: a presenter account can be compromised, and a malicious presenter
 * could otherwise poison their own session's insights.
 *
 * Returns { prompt, detections, redactedCount, nonce }.
 */
function buildPrompt(poll, aggregated, textSamples) {
  const guarded = promptGuard.guardSamples(textSamples);

  // For text/wordcloud polls the results breakdown is grouped BY the answer string, so each entry
  // carries raw audience text -- a second injection path into the prompt. Guard it the same way as
  // the samples so a payload cannot ride in through `Results breakdown` untouched.
  const isFreeText = poll?.type === 'text' || poll?.type === 'wordcloud';
  const guardedResults = promptGuard.guardResults(aggregated?.results, isFreeText);
  const resultsBlock = JSON.stringify(guardedResults.results);

  // Merge detections from both untrusted paths so the caller flags/alerts on either.
  const detections = guarded.detections.concat(guardedResults.detections);
  const redactedCount = guarded.redactedCount + guardedResults.redactedCount;

  // Presenter-authored, but still sanitised and length-capped.
  const question = promptGuard.sanitize(poll?.question || '');
  const type = promptGuard.sanitize(String(poll?.type || ''));

  const { nonce, block } = promptGuard.buildUserDataBlock(guarded.samples);
  const samplesSection = guarded.samples.length
    ? `\n\nSample open-text responses from the audience (UNTRUSTED DATA):\n${block}`
    : '';

  const prompt = `You are an expert speaker's assistant analyzing live audience polling data in real-time.

Question: "${question}"
Type: ${type}
Total votes: ${aggregated?.total || 0}
Results breakdown: ${resultsBlock}${samplesSection}

Your task is to provide immediate, actionable insights for the presenter to keep the audience engaged.

Return a JSON object with exactly these keys:
- "pulse": A sharp, insightful one-sentence summary (max 25 words) of the audience's consensus or division. Avoid stating the obvious; uncover the underlying sentiment.
- "followups": An array of 2-3 engaging, open-ended questions (under 15 words each) the presenter can ask the room right now to spark discussion based on these results.
- "outliers": An array of 0-2 unexpected, contradictory, or uniquely interesting data points or sample responses. If everything is standard, return an empty array.

${promptGuard.dataHandlingInstruction(nonce)}

Output ONLY valid JSON matching the schema, with no markdown formatting or extra text.`;

  return { prompt, detections, redactedCount, nonce };
}

function safeJsonParse(text) {
  // Strip code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find first { ... } block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

/** Clamp a model-produced string. The model's output is untrusted too -- it just read attacker text. */
function clampString(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * @param {object} poll
 * @param {object} aggregated
 * @param {string[]} textSamples raw audience text -- guarded internally, do NOT pre-trust
 * @param {object} [opts]
 * @param {(info: object) => void} [opts.onInjectionDetected] called when attempts are detected
 */
async function generateInsights(poll, aggregated, textSamples, opts = {}) {
  const c = getClient();
  if (!c) {
    console.warn('AI insights: GEMINI_API_KEY not set, skipping');
    return null;
  }
  if (!poll || !aggregated || aggregated.total === 0) return null;

  const { prompt, detections, redactedCount } = buildPrompt(poll, aggregated, textSamples);

  // Flag, don't silently drop: a detected attempt is signal that someone is attacking the session.
  if (detections.length) {
    console.warn(
      `[promptGuard] ${detections.length} injection attempt(s) in open-text answers ` +
      `(${redactedCount} redacted): ` +
      detections.map(d => `${d.severity}:${d.rules.join('+')}`).join(', ')
    );
    if (typeof opts.onInjectionDetected === 'function') {
      try { opts.onInjectionDetected({ detections, redactedCount }); } catch { /* never break insights */ }
    }
  }

  try {
    const model = c.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const parsed = safeJsonParse(text);
    if (!parsed) return null;

    // Output-side clamping. The model just read attacker-controlled text, so treat what comes back
    // as untrusted: enforce types and cap lengths so a successful injection cannot become a huge
    // or malformed payload downstream. (The Angular client renders these via text interpolation,
    // not innerHTML, so this cannot become XSS today -- see promptGuard.js header.)
    return {
      pulse: clampString(parsed.pulse, 300),
      followups: Array.isArray(parsed.followups)
        ? parsed.followups.slice(0, 3).map(f => clampString(f, 200)).filter(Boolean)
        : [],
      outliers: Array.isArray(parsed.outliers)
        ? parsed.outliers.slice(0, 2).map(o => clampString(o, 200)).filter(Boolean)
        : [],
      ...(detections.length ? { injectionAttempts: detections.length } : {})
    };
  } catch (err) {
    console.error('AI insights failed:', err.message);
    return null;
  }
}

module.exports = { generateInsights, buildPrompt };
