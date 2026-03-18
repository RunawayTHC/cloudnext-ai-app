// ClouDNext AI Server v1.0
// Webhook receiver + Gemini AI + ElevenLabs TTS + Evolution API sender

import express from 'express';
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIG
// ============================================================
const PORT           = process.env.PORT || 3002;
const EVOLUTION_URL  = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_KEY  = process.env.EVOLUTION_API_KEY || 'evolution-internal-key-2024';
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
const INSTANCE_NAME  = process.env.INSTANCE_NAME || 'cloudnext-ai';
const APP_URL        = process.env.APP_URL || `http://localhost:${PORT}`;

// ============================================================
// IN-MEMORY STATE (persisted to data.json)
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!existsSync(DATA_FILE)) return {
    config: {
      persona: 'Você é um assistente de vendas profissional e cordial. Responda sempre em português.',
      geminiModel: 'gemini-2.0-flash',
      voiceId: '',
      delayMin: 1500,
      delayMax: 4000,
      audioRoutingEnabled: false,
      ignoredNumbers: [],
    },
    logs: [],
    stats: { totalSent: 0, audioSent: 0, textSent: 0, errors: 0, startTime: Date.now() }
  };
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return loadData(); }
}

function saveData() {
  try { writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch {}
}

let state = loadData();

// Trim logs to last 500
function addLog(type, direction, phone, content, extra = {}) {
  const entry = {
    id: uuidv4(),
    ts: Date.now(),
    type,       // 'message' | 'error' | 'info' | 'ai'
    direction,  // 'in' | 'out' | 'system'
    phone,
    content,
    ...extra
  };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs = state.logs.slice(0, 500);
  saveData();
  return entry;
}

// ============================================================
// EVOLUTION API HELPERS
// ============================================================
const evoHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': EVOLUTION_KEY
});

async function evoRequest(method, endpoint, body = null) {
  const res = await fetch(`${EVOLUTION_URL}${endpoint}`, {
    method,
    headers: evoHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

async function getInstanceStatus() {
  const r = await evoRequest('GET', `/instance/fetchInstances`);
  if (!r.ok) return null;
  const instances = Array.isArray(r.data) ? r.data : [];
  return instances.find(i => i.name === INSTANCE_NAME || i.instance?.instanceName === INSTANCE_NAME) || null;
}

async function createInstance() {
  return evoRequest('POST', `/instance/create`, {
    instanceName: INSTANCE_NAME,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    reject_call: false,
    groupsIgnore: true,
    alwaysOnline: true,
    readMessages: true,
    readStatus: false,
    syncFullHistory: false,
    webhook: {
      url: `${APP_URL}/webhook`,
      byEvents: false,
      base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    }
  });
}

async function sendText(phone, text) {
  return evoRequest('POST', `/message/sendText/${INSTANCE_NAME}`, {
    number: phone,
    text
  });
}

async function sendAudio(phone, audioBase64, mimetype = 'audio/mpeg') {
  return evoRequest('POST', `/message/sendMedia/${INSTANCE_NAME}`, {
    number: phone,
    mediatype: 'audio',
    mimetype,
    media: audioBase64,
    fileName: 'audio.mp3'
  });
}

// ============================================================
// GEMINI AI
// ============================================================
async function callGemini(userMessage, persona, model = 'gemini-2.0-flash') {
  const audioInstruction = state.config.audioRoutingEnabled && ELEVENLABS_KEY && state.config.voiceId
    ? `\n\nINSTRUÇÃO DE FORMATO: Inicie SEMPRE cada resposta com [AUDIO] ou [TEXTO].
- Use [AUDIO] para: saudações, warmup, follow-up pessoal, mensagens curtas e emocionais.
- Use [TEXTO] para: preços, links, dados técnicos, listas.
NUNCA omita esse prefixo.`
    : '';

  const systemPrompt = `${persona}${audioInstruction}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }]
      })
    }
  );

  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ============================================================
// ELEVENLABS TTS
// ============================================================
async function callElevenLabs(text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs error: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ============================================================
// PROCESS INCOMING MESSAGE
// ============================================================
const processingQueue = new Set(); // prevent duplicate processing

async function processMessage(phone, messageText) {
  if (processingQueue.has(phone)) return;
  processingQueue.add(phone);

  addLog('message', 'in', phone, messageText);

  try {
    const { persona, geminiModel, voiceId, delayMin, delayMax, audioRoutingEnabled } = state.config;

    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY não configurada');

    // Random human-like delay
    const delay = Math.floor(Math.random() * (delayMax - delayMin)) + delayMin;
    await new Promise(r => setTimeout(r, delay));

    // Call Gemini
    const rawResponse = await callGemini(messageText, persona, geminiModel);
    addLog('ai', 'system', phone, `Gemini: ${rawResponse.slice(0, 120)}...`);

    const isAudio = audioRoutingEnabled && rawResponse.startsWith('[AUDIO]') && ELEVENLABS_KEY && voiceId;
    const cleanResponse = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

    if (isAudio) {
      // Generate TTS and send audio
      const audioBase64 = await callElevenLabs(cleanResponse, voiceId);
      const r = await sendAudio(phone, audioBase64);

      if (r.ok) {
        state.stats.audioSent++;
        state.stats.totalSent++;
        addLog('message', 'out', phone, `[ÁUDIO] ${cleanResponse.slice(0, 80)}`, { format: 'audio' });
      } else {
        throw new Error(`sendAudio failed: ${JSON.stringify(r.data)}`);
      }
    } else {
      // Send text
      const r = await sendText(phone, cleanResponse);

      if (r.ok) {
        state.stats.textSent++;
        state.stats.totalSent++;
        addLog('message', 'out', phone, cleanResponse.slice(0, 200), { format: 'text' });
      } else {
        throw new Error(`sendText failed: ${JSON.stringify(r.data)}`);
      }
    }

    saveData();
  } catch (err) {
    state.stats.errors++;
    addLog('error', 'system', phone, err.message);
    saveData();
  } finally {
    processingQueue.delete(phone);
  }
}

// ============================================================
// WEBHOOK — receives events from Evolution API
// ============================================================
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  const body = req.body;
  const event = body?.event || body?.type;

  // QR code updated
  if (event === 'qrcode.updated' || event === 'QRCODE_UPDATED') {
    const qr = body?.data?.qrcode?.base64 || body?.data?.base64;
    if (qr) {
      state._qrBase64 = qr;
      state._qrTs = Date.now();
      addLog('info', 'system', null, 'QR Code atualizado — escaneie no dashboard');
    }
    return;
  }

  // Connection state
  if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
    const status = body?.data?.state || body?.data?.status;
    state._connectionState = status;
    addLog('info', 'system', null, `Conexão: ${status}`);
    if (status === 'open') { state._qrBase64 = null; saveData(); }
    return;
  }

  // New message
  if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
    const msg = body?.data?.messages?.[0] || body?.data;
    if (!msg) return;

    // Ignore outgoing (messages sent by the bot)
    const fromMe = msg.key?.fromMe || msg.fromMe;
    if (fromMe) return;

    const remoteJid = msg.key?.remoteJid || msg.remoteJid;
    const phone = remoteJid?.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone) return;

    // Ignore groups
    if (remoteJid?.includes('@g.us')) return;

    // Ignore numbers in blocklist
    if (state.config.ignoredNumbers?.includes(phone)) return;

    // Extract text
    const messageText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      (msg.message?.audioMessage ? '[O cliente enviou um áudio de voz. Responda de forma natural como se tivesse ouvido o áudio, pedindo para ele repetir por texto se necessário.]' : null) ||
      null;

    if (!messageText) return;

    processMessage(phone, messageText);
  }
});

// ============================================================
// API ROUTES — used by dashboard
// ============================================================

// GET /api/status — instance + server status
app.get('/api/status', async (req, res) => {
  const instance = await getInstanceStatus().catch(() => null);
  const connectionState = state._connectionState || 'unknown';
  const qrAvailable = !!state._qrBase64;

  res.json({
    instance: instance ? {
      name: INSTANCE_NAME,
      state: instance.instance?.state || instance.connectionStatus || connectionState,
      number: instance.instance?.number || null
    } : null,
    connectionState,
    qrAvailable,
    uptime: Math.floor((Date.now() - state.stats.startTime) / 1000),
    stats: state.stats
  });
});

// GET /api/qr — get QR code as base64 PNG
app.get('/api/qr', async (req, res) => {
  // Try to get fresh QR from Evolution directly
  const r = await evoRequest('GET', `/instance/connect/${INSTANCE_NAME}`).catch(() => null);
  const evoQr = r?.data?.base64 || r?.data?.qrcode?.base64;

  const qrData = evoQr || state._qrBase64;

  if (!qrData) {
    return res.status(404).json({ error: 'QR não disponível. A instância pode já estar conectada.' });
  }

  // If already a data URL, return as-is; else wrap
  const dataUrl = qrData.startsWith('data:') ? qrData : `data:image/png;base64,${qrData}`;
  res.json({ qr: dataUrl });
});

// POST /api/instance/create — create or reconnect instance
app.post('/api/instance/create', async (req, res) => {
  const existing = await getInstanceStatus();
  if (existing) {
    // Already exists, try to get QR
    return res.json({ ok: true, message: 'Instância já existe', instance: existing });
  }
  const r = await createInstance();
  addLog('info', 'system', null, `Instância criada: ${JSON.stringify(r.data).slice(0, 100)}`);
  res.json({ ok: r.ok, data: r.data });
});

// DELETE /api/instance/logout — disconnect
app.delete('/api/instance/logout', async (req, res) => {
  const r = await evoRequest('DELETE', `/instance/logout/${INSTANCE_NAME}`);
  state._connectionState = 'close';
  addLog('info', 'system', null, 'Desconectado manualmente');
  saveData();
  res.json({ ok: r.ok });
});

// GET /api/config — get AI config
app.get('/api/config', (req, res) => {
  res.json(state.config);
});

// POST /api/config — save AI config
app.post('/api/config', (req, res) => {
  const allowed = ['persona', 'geminiModel', 'voiceId', 'delayMin', 'delayMax', 'audioRoutingEnabled', 'ignoredNumbers'];
  allowed.forEach(k => {
    if (req.body[k] !== undefined) state.config[k] = req.body[k];
  });
  saveData();
  addLog('info', 'system', null, 'Configuração atualizada');
  res.json({ ok: true, config: state.config });
});

// GET /api/logs — paginated logs
app.get('/api/logs', (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 50;
  const type = req.query.type || null;
  let logs = state.logs;
  if (type) logs = logs.filter(l => l.type === type);
  res.json({
    total: logs.length,
    page,
    logs: logs.slice(page * limit, (page + 1) * limit)
  });
});

// DELETE /api/logs — clear logs
app.delete('/api/logs', (req, res) => {
  state.logs = [];
  saveData();
  res.json({ ok: true });
});

// POST /api/test — send a test message
app.post('/api/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
  const r = await sendText(phone, message);
  res.json({ ok: r.ok, data: r.data });
});

// POST /api/simulate — simulate incoming message (test AI response)
app.post('/api/simulate', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
  processMessage(phone, message);
  res.json({ ok: true, message: 'Processando... veja os logs.' });
});

// ============================================================
// STARTUP
// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🚀 ClouDNext AI rodando na porta ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook: ${APP_URL}/webhook`);
  console.log(`🤖 Instância Evolution: ${INSTANCE_NAME}\n`);

  // Check if instance already exists on startup
  const existing = await getInstanceStatus().catch(() => null);
  if (existing) {
    const s = existing.instance?.state || existing.connectionStatus || 'unknown';
    state._connectionState = s;
    console.log(`📱 Instância "${INSTANCE_NAME}" encontrada — status: ${s}`);
  } else {
    console.log(`⚠️  Instância "${INSTANCE_NAME}" não encontrada. Crie no dashboard.`);
  }
});
