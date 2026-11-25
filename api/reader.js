import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const voices = new Set('Kore Puck Charon Aoede Fenrir Leda Zephyr Orus Callirrhoe Autonoe Enceladus Iapetus Umbriel Algieba Despina Erinome Algenib Rasalgethi Laomedeia Achernar Alnilam Schedar Gacrux Pulcherrima Achird Zubenelgenubi Vindemiatrix Sadachbia Sadaltager Sulafat'.split(' '));
const documentTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'text/plain']);
const maxAge = 30 * 86400;
const cookieName = '__Host-reader';
const usage = { minute: 0, count: 0 };

function sign(expiry, secret) {
  return createHmac('sha256', secret).update('reader-session:' + expiry).digest('hex');
}

function equal(a, b) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function signedIn(req, secret) {
  const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const parts = /^(\d{10})\.([a-f0-9]{64})$/.exec(token || '');
  return Boolean(secret && parts && Number(parts[1]) > Date.now() / 1000 && equal(parts[2], sign(parts[1], secret)));
}

function payload(body) {
  if (body.operation === 'speech' && typeof body.text === 'string' && body.text.trim() && body.text.length <= 3000 && voices.has(body.voice)) {
    return {
      model: process.env.READER_SPEECH_MODEL || 'gemini-2.5-flash-preview-tts',
      contents: [{parts: [{text: 'Read this transcript aloud naturally.\n\n' + body.text}]}],
      generationConfig: {responseModalities: ['AUDIO'], speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: body.voice}}}}
    };
  }
  if (body.operation === 'extract' && documentTypes.has(body.mimeType) && typeof body.data === 'string' && body.data.length <= 4194304 && /^[a-zA-Z0-9+/]+={0,2}$/.test(body.data)) {
    return {
      model: process.env.READER_TEXT_MODEL || 'gemini-2.5-flash',
      contents: [{parts: [{inlineData: {mimeType: body.mimeType, data: body.data}}, {text: 'Extract the readable content as clean prose for listening. Preserve the original meaning and reading order. Skip page numbers, repeated headers and layout artifacts. Return only the spoken text.'}]}]
    };
  }
}

export default function reader(req, res) {
  return handleReader(req, res, process.env.GEMINI_API_KEY, process.env.READER_ACCESS_CODE, false);
}

export async function handleReader(req, res, key, secret, local) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => res.status(status).json({error});
  const unlocked = local || signedIn(req, secret);
  if (req.method === 'GET') return res.json({available: Boolean(key && (local || secret)), unlocked});
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return fail(405, 'Unsupported request.'); }
  if (req.headers.origin !== (local ? 'http://' : 'https://') + req.headers.host || !req.headers['content-type']?.startsWith('application/json')) return fail(403, 'Open the reader to continue.');
  if ((!local && !secret) || !key) return fail(503, 'Cloud reading is unavailable.');
  const body = req.body || {};
  if (body.operation === 'unlock') {
    if (!secret || typeof body.code !== 'string' || body.code.length > 256 || !equal(body.code, secret)) return fail(401, 'Check the reader access code.');
    const expiry = String(Math.floor(Date.now() / 1000) + maxAge);
    res.setHeader('Set-Cookie', cookieName + '=' + expiry + '.' + sign(expiry, secret) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge);
    return res.json({unlocked: true});
  }
  if (!unlocked) return fail(401, 'Unlock cloud reading using the access code at the top of the page.');
  const input = payload(body);
  if (!input) return fail(400, 'Use a supported file up to 3 MiB or a shorter text selection.');
  const minute = Math.floor(Date.now() / 60000);
  if (usage.minute !== minute) Object.assign(usage, {minute, count: 0});
  if (++usage.count > 40) return fail(429, 'Voice reader rate limit reached. Try again in a minute.');
  try {
    const {model, ...request} = input;
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': key}, body: JSON.stringify(request), signal: AbortSignal.timeout(115000)
    });
    if (!response.ok) {
      if (response.status === 402) return fail(402, 'Cloud reading is paused because the Gemini project is out of credits.');
      if (response.status === 429) return fail(429, 'Gemini reached its quota or rate limit.');
      return fail(502, 'Gemini could not complete this request.');
    }
    const result = await response.json();
    const parts = result.candidates?.[0]?.content?.parts || [];
    if (body.operation === 'extract') {
      const text = parts.filter(part => !part.thought).map(part => part.text || '').join('').trim();
      return text ? res.json({text}) : fail(422, 'No readable text was found.');
    }
    const data = parts.find(part => part.inlineData?.data)?.inlineData.data;
    if (!data) return fail(422, 'No audio was returned. Try another selection.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.write(Buffer.from(data, 'base64'));
    res.end();
  } catch {
    return fail(502, 'The voice service could not finish. Please try again.');
  }
}
