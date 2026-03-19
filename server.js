// ClouDNext AI Server v2.0 — PostgreSQL storage
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';

config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ──
const PORT          = process.env.PORT || 3002;
const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || 'evolution-internal-key-2024';
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const ELEVENLABS_KEY= process.env.ELEVENLABS_API_KEY || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'cloudnext-ai';
const APP_URL       = process.env.APP_URL || `http://localhost:${PORT}`;
const DEFAULT_VOICE = process.env.VOICE_ID || '';

// ── POSTGRES ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_logs (
      id TEXT PRIMARY KEY,
      ts BIGINT NOT NULL,
      type TEXT,
      direction TEXT,
      phone TEXT,
      content TEXT,
      extra JSONB DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS app_stats (
      key TEXT PRIMARY KEY,
      value BIGINT DEFAULT 0
    );
    INSERT INTO app_stats (key, value) VALUES
      ('totalSent',0),('textSent',0),('audioSent',0),('errors',0),('startTime', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
    ON CONFLICT (key) DO NOTHING;
  `);
}

// ── IN-MEMORY STATE (fast reads, DB-backed writes) ──
const state = {
  config: {
    persona: 'Você é um assistente de vendas profissional e cordial. Responda sempre em português.',
    geminiModel: 'gemini-2.0-flash',
    voiceId: DEFAULT_VOICE,
    delayMin: 1500,
    delayMax: 4000,
    audioRoutingEnabled: !!DEFAULT_VOICE,
    ignoredNumbers: [],
    aiEnabled: true,
    audioDailyLimit: 0,
    audioMode: 'ai',
    audioScheduleStart: '08:00',
    audioScheduleEnd: '18:00',
  },
  stats: { totalSent: 0, textSent: 0, audioSent: 0, errors: 0, startTime: Date.now() },
  _qrBase64: null,
  _connectionState: 'unknown',
  _audioTodayDate: null,
  _audioTodayCount: 0,
};

async function loadConfig() {
  const { rows } = await pool.query('SELECT key, value FROM app_config');
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });

  if (map.persona)              state.config.persona              = map.persona;
  if (map.geminiModel)          state.config.geminiModel          = map.geminiModel;
  if (map.voiceId)              state.config.voiceId              = map.voiceId;
  else if (DEFAULT_VOICE)       state.config.voiceId              = DEFAULT_VOICE;
  if (map.delayMin)             state.config.delayMin             = parseInt(map.delayMin);
  if (map.delayMax)             state.config.delayMax             = parseInt(map.delayMax);
  if (map.audioRoutingEnabled !== undefined) state.config.audioRoutingEnabled = map.audioRoutingEnabled === 'true';
  else if (DEFAULT_VOICE)       state.config.audioRoutingEnabled  = true;
  if (map.ignoredNumbers)       state.config.ignoredNumbers       = JSON.parse(map.ignoredNumbers);
  if (map.aiEnabled !== undefined) state.config.aiEnabled = map.aiEnabled === 'true';
  if (map.audioDailyLimit !== undefined) state.config.audioDailyLimit = parseInt(map.audioDailyLimit) || 0;
  if (map.audioMode)            state.config.audioMode            = map.audioMode;
  if (map.audioScheduleStart)   state.config.audioScheduleStart   = map.audioScheduleStart;
  if (map.audioScheduleEnd)     state.config.audioScheduleEnd     = map.audioScheduleEnd;
}

async function saveConfig() {
  const cfg = state.config;
  const entries = [
    ['persona',              cfg.persona],
    ['geminiModel',          cfg.geminiModel],
    ['voiceId',              cfg.voiceId],
    ['delayMin',             String(cfg.delayMin)],
    ['delayMax',             String(cfg.delayMax)],
    ['audioRoutingEnabled',  String(cfg.audioRoutingEnabled)],
    ['ignoredNumbers',       JSON.stringify(cfg.ignoredNumbers)],
    ['aiEnabled',            String(cfg.aiEnabled)],
    ['audioDailyLimit',      String(cfg.audioDailyLimit || 0)],
    ['audioMode',            cfg.audioMode],
    ['audioScheduleStart',   cfg.audioScheduleStart],
    ['audioScheduleEnd',     cfg.audioScheduleEnd],
  ];
  for (const [key, value] of entries) {
    await pool.query('INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
  }
}

async function loadStats() {
  const { rows } = await pool.query('SELECT key, value FROM app_stats');
  rows.forEach(r => { state.stats[r.key] = Number(r.value); });
}

async function incStat(key) {
  state.stats[key] = (state.stats[key] || 0) + 1;
  await pool.query('UPDATE app_stats SET value = value + 1 WHERE key = $1', [key]);
}

async function addLog(type, direction, phone, content, extra = {}) {
  const id = uuidv4();
  const ts = Date.now();
  await pool.query(
    'INSERT INTO app_logs (id, ts, type, direction, phone, content, extra) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, ts, type, direction, phone, content?.slice(0, 500), JSON.stringify(extra)]
  ).catch(() => {});
  return { id, ts, type, direction, phone, content, extra };
}

// ── EVOLUTION API ──
const evoHeaders = () => ({ 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY });

async function evoRequest(method, endpoint, body = null) {
  const res = await fetch(`${EVOLUTION_URL}${endpoint}`, {
    method, headers: evoHeaders(), body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

async function getInstanceStatus() {
  const r = await evoRequest('GET', '/instance/fetchInstances');
  if (!r.ok) return null;
  const instances = Array.isArray(r.data) ? r.data : [];
  return instances.find(i => i.name === INSTANCE_NAME || i.instance?.instanceName === INSTANCE_NAME) || null;
}

async function createEvolutionInstance() {
  return evoRequest('POST', '/instance/create', {
    instanceName: INSTANCE_NAME,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true, reject_call: false, groupsIgnore: true,
    alwaysOnline: true, readMessages: true, readStatus: false, syncFullHistory: false,
    webhook: {
      url: `${APP_URL}/webhook`, byEvents: false, base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    }
  });
}

async function updateWebhook() {
  const r = await evoRequest('POST', `/webhook/set/${INSTANCE_NAME}`, {
    webhook: {
      enabled: true,
      url: `${APP_URL}/webhook`,
      byEvents: false,
      base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    }
  });
  console.log(`[Webhook Set] status=${r.status} data=${JSON.stringify(r.data).slice(0,200)}`);
  return r;
}

async function sendText(phone, text) {
  return evoRequest('POST', `/message/sendText/${INSTANCE_NAME}`, { number: phone, text });
}

async function sendAudio(phone, audioBase64, mimetype = 'audio/mpeg') {
  return evoRequest('POST', `/message/sendMedia/${INSTANCE_NAME}`, {
    number: phone, mediatype: 'audio', mimetype, media: audioBase64, fileName: 'audio.mp3'
  });
}

// ── HELPERS ──
function getBrazilDate() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getBrazilTimeStr() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false });
}

function brazilNow() {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function shouldSendAudio(rawResponse) {
  const { audioMode, audioRoutingEnabled, voiceId, audioDailyLimit } = state.config;
  if (!audioRoutingEnabled || !ELEVENLABS_KEY || !voiceId) return false;
  const today = getBrazilDate();
  if (state._audioTodayDate !== today) { state._audioTodayDate = today; state._audioTodayCount = 0; }
  if (audioDailyLimit > 0 && state._audioTodayCount >= audioDailyLimit) return false;
  if (audioMode === 'never') return false;
  if (audioMode === 'always') return true;
  if (audioMode === 'schedule') {
    const t = getBrazilTimeStr();
    return t >= state.config.audioScheduleStart && t <= state.config.audioScheduleEnd;
  }
  return rawResponse.startsWith('[AUDIO]');
}

// ── GEMINI ──
async function callGemini(userMessage, persona, model = 'gemini-2.0-flash') {
  const audioInstruction = state.config.audioRoutingEnabled && ELEVENLABS_KEY && state.config.voiceId
    ? `\n\nINSTRUÇÃO DE FORMATO: Inicie SEMPRE cada resposta com [AUDIO] ou [TEXTO].\n- Use [AUDIO] para: saudações, warmup, follow-up pessoal, mensagens curtas.\n- Use [TEXTO] para: preços, links, dados técnicos, listas.\nNUNCA omita esse prefixo.`
    : '';

  const timeCtx = `\n\n[HORA ATUAL EM BRASÍLIA: ${brazilNow()}]`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: persona + timeCtx + audioInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }]
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── ELEVENLABS ──
async function callElevenLabs(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!res.ok) throw new Error(`ElevenLabs error: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ── PROCESS MESSAGE ──
const processingQueue = new Set();

async function processMessage(phone, messageText) {
  if (processingQueue.has(phone)) return;
  if (!state.config.aiEnabled) return;
  processingQueue.add(phone);
  await addLog('message', 'in', phone, messageText);

  try {
    const { persona, geminiModel, voiceId, delayMin, delayMax } = state.config;
    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY não configurada');

    const delay = Math.floor(Math.random() * (delayMax - delayMin)) + delayMin;
    await new Promise(r => setTimeout(r, delay));

    const rawResponse = await callGemini(messageText, persona, geminiModel);
    await addLog('ai', 'system', phone, `Gemini: ${rawResponse.slice(0, 120)}`);

    const isAudio = shouldSendAudio(rawResponse);
    const cleanResponse = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

    if (isAudio) {
      const audioBase64 = await callElevenLabs(cleanResponse, voiceId);
      const r = await sendAudio(phone, audioBase64);
      if (r.ok) {
        state._audioTodayCount++;
        await incStat('audioSent'); await incStat('totalSent');
        await addLog('message', 'out', phone, `[ÁUDIO] ${cleanResponse.slice(0, 80)}`, { format: 'audio' });
      } else throw new Error(`sendAudio failed: ${JSON.stringify(r.data)}`);
    } else {
      const r = await sendText(phone, cleanResponse);
      if (r.ok) {
        await incStat('textSent'); await incStat('totalSent');
        await addLog('message', 'out', phone, cleanResponse.slice(0, 200), { format: 'text' });
      } else throw new Error(`sendText failed: ${JSON.stringify(r.data)}`);
    }
  } catch (err) {
    await incStat('errors');
    await addLog('error', 'system', phone, err.message);
  } finally {
    processingQueue.delete(phone);
  }
}

// ── WEBHOOK ──
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });
  const body = req.body;
  const event = body?.event || body?.type;
  console.log(`[WEBHOOK] event="${event}" instance="${body?.instance}" keys=${Object.keys(body||{}).join(',')}`);
  console.log(`[WEBHOOK RAW] ${JSON.stringify(body).slice(0,400)}`);

  if (event === 'qrcode.updated' || event === 'QRCODE_UPDATED') {
    const qr = body?.data?.qrcode?.base64 || body?.data?.base64;
    if (qr) { state._qrBase64 = qr; await addLog('info', 'system', null, 'QR Code atualizado'); }
    return;
  }
  if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
    const status = body?.data?.state || body?.data?.status;
    state._connectionState = status;
    await addLog('info', 'system', null, `Conexão: ${status}`);
    if (status === 'open') state._qrBase64 = null;
    return;
  }
  if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
    const msg = body?.data?.messages?.[0] || body?.data;
    if (!msg) return;
    if (msg.key?.fromMe || msg.fromMe) return;
    const remoteJid = msg.key?.remoteJid || msg.remoteJid;
    const phone = remoteJid?.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone || remoteJid?.includes('@g.us')) return;
    if (state.config.ignoredNumbers?.includes(phone)) return;
    const messageText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      (msg.message?.audioMessage ? '[O cliente enviou um áudio de voz. Responda de forma natural como se tivesse ouvido o áudio, pedindo para ele repetir por texto se necessário.]' : null);
    if (messageText) processMessage(phone, messageText);
  }
});

// ── API ROUTES ──
app.get('/api/status', async (req, res) => {
  const instance = await getInstanceStatus().catch(() => null);
  res.json({
    instance: instance ? {
      name: INSTANCE_NAME,
      state: instance.instance?.state || instance.connectionStatus || state._connectionState,
      number: instance.instance?.number || null
    } : null,
    connectionState: state._connectionState,
    qrAvailable: !!state._qrBase64,
    uptime: Math.floor((Date.now() - state.stats.startTime) / 1000),
    stats: state.stats
  });
});

app.get('/api/qr', async (req, res) => {
  const r = await evoRequest('GET', `/instance/connect/${INSTANCE_NAME}`).catch(() => null);
  const qrData = r?.data?.base64 || r?.data?.qrcode?.base64 || state._qrBase64;
  if (!qrData) return res.status(404).json({ error: 'QR não disponível.' });
  const dataUrl = qrData.startsWith('data:') ? qrData : `data:image/png;base64,${qrData}`;
  res.json({ qr: dataUrl });
});

app.post('/api/instance/create', async (req, res) => {
  const existing = await getInstanceStatus();
  if (existing) {
    await updateWebhook();
    await addLog('info', 'system', null, `Webhook atualizado para: ${APP_URL}/webhook`);
    return res.json({ ok: true, message: 'Webhook atualizado', instance: existing });
  }
  const r = await createEvolutionInstance();
  await addLog('info', 'system', null, `Instância criada: ${JSON.stringify(r.data).slice(0, 100)}`);
  res.json({ ok: r.ok, data: r.data });
});

app.delete('/api/instance/logout', async (req, res) => {
  const r = await evoRequest('DELETE', `/instance/logout/${INSTANCE_NAME}`);
  state._connectionState = 'close';
  await addLog('info', 'system', null, 'Desconectado manualmente');
  res.json({ ok: r.ok });
});

app.get('/api/config', (req, res) => res.json(state.config));

app.post('/api/config', async (req, res) => {
  const allowed = ['persona','geminiModel','voiceId','delayMin','delayMax','audioRoutingEnabled','ignoredNumbers','aiEnabled','audioDailyLimit','audioMode','audioScheduleStart','audioScheduleEnd'];
  allowed.forEach(k => { if (req.body[k] !== undefined) state.config[k] = req.body[k]; });
  await saveConfig();
  await addLog('info', 'system', null, 'Configuração atualizada');
  res.json({ ok: true, config: state.config });
});

app.get('/api/logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const type  = req.query.type || null;
  const where = type ? `WHERE type = $2` : '';
  const params = type ? [limit, type] : [limit];
  const { rows } = await pool.query(
    `SELECT * FROM app_logs ${where} ORDER BY ts DESC LIMIT $1`, params
  );
  res.json({ total: rows.length, logs: rows });
});

app.delete('/api/logs', async (req, res) => {
  await pool.query('DELETE FROM app_logs');
  res.json({ ok: true });
});

app.post('/api/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
  const r = await sendText(phone, message);
  res.json({ ok: r.ok, data: r.data });
});

app.post('/api/simulate', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
  processMessage(phone, message);
  res.json({ ok: true, message: 'Processando...' });
});

app.post('/api/training-chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages obrigatório' });

  const trainerPrompt = `Você é uma assistente de configuração de agentes de IA para WhatsApp. Ajude o usuário a configurar o agente de vendas conversando em português.

Faça perguntas uma por vez para entender:
1. Nome da empresa e do responsável
2. Produto ou serviço (descrição, diferenciais)
3. Preço e condições de pagamento
4. Público-alvo
5. Tom de comunicação (formal/informal)
6. Como tratar objeções de preço
7. Próximo passo quando cliente demonstra interesse
8. Outras informações importantes

FORMATO OBRIGATÓRIO — sempre responda com:
<RESPONSE>
Sua resposta conversacional aqui
</RESPONSE>
<PERSONA_DRAFT>
Prompt de sistema atualizado com tudo coletado até agora. Escreva como um prompt completo em português (ex: "Você é [nome]..."). Inclua só o que o usuário já informou.
</PERSONA_DRAFT>

Nunca omita essas tags.`;

  try {
    const contents = messages.map(m => ({
      role: m.role === 'ai' ? 'model' : 'user',
      parts: [{ text: m.text }]
    }));
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: trainerPrompt }] }, contents }) }
    );
    const data = await r.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const responseMatch = raw.match(/<RESPONSE>([\s\S]*?)<\/RESPONSE>/);
    const personaMatch  = raw.match(/<PERSONA_DRAFT>([\s\S]*?)<\/PERSONA_DRAFT>/);
    const text    = responseMatch ? responseMatch[1].trim() : raw.trim();
    const persona = personaMatch  ? personaMatch[1].trim()  : null;

    if (persona) {
      state.config.persona = persona;
      await saveConfig();
    }
    const fullHistory = [...messages, { role: 'ai', text }];
    await pool.query(
      'INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      ['trainingHistory', JSON.stringify(fullHistory)]
    );
    res.json({ ok: true, text, persona });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/chat-test', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    const { persona, geminiModel, voiceId, audioRoutingEnabled } = state.config;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada' });
    const rawResponse = await callGemini(message, persona, geminiModel);
    const isAudio = audioRoutingEnabled && rawResponse.startsWith('[AUDIO]') && ELEVENLABS_KEY && voiceId;
    const cleanText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
    if (isAudio) {
      const audioBase64 = await callElevenLabs(cleanText, voiceId);
      return res.json({ ok: true, format: 'audio', text: cleanText, audioBase64, mimeType: 'audio/mpeg' });
    }
    res.json({ ok: true, format: 'text', text: cleanText });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/training-history', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM app_config WHERE key=$1', ['trainingHistory']);
    if (!rows.length) return res.json({ ok: true, history: [] });
    res.json({ ok: true, history: JSON.parse(rows[0].value) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/elevenlabs/credits', async (req, res) => {
  if (!ELEVENLABS_KEY) return res.json({ ok: false, error: 'Sem chave API' });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await r.json();
    console.log('[ElevenLabs user]', JSON.stringify(data).slice(0,300));
    const sub = data.subscription || data;
    res.json({
      ok: true,
      characterCount: sub.character_count ?? data.character_count ?? 0,
      characterLimit: sub.character_limit ?? data.character_limit ?? 0,
      tier: sub.tier ?? data.tier ?? 'unknown'
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── STARTUP ──
app.listen(PORT, async () => {
  console.log(`\n🚀 ClouDNext AI v2.0 rodando na porta ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook: ${APP_URL}/webhook`);

  await initDB();
  console.log('✅ PostgreSQL conectado');

  await loadConfig();
  await loadStats();
  console.log('✅ Config e stats carregados do banco');

  const existing = await getInstanceStatus().catch(() => null);
  if (existing) {
    state._connectionState = existing.instance?.state || existing.connectionStatus || 'unknown';
    console.log(`📱 Instância "${INSTANCE_NAME}" — status: ${state._connectionState}`);
  } else {
    console.log(`⚠️  Instância "${INSTANCE_NAME}" não encontrada. Crie no dashboard.`);
  }
});
