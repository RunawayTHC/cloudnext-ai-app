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
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      history JSONB NOT NULL DEFAULT '[]',
      updated_at BIGINT NOT NULL,
      last_ai_at BIGINT,
      last_user_at BIGINT
    );
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_ai_at BIGINT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_user_at BIGINT;
    CREATE TABLE IF NOT EXISTS human_paused (
      phone TEXT PRIMARY KEY,
      paused_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_leads (
      phone TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      raw_jid TEXT,
      profile_pic TEXT,
      stage TEXT DEFAULT 'novo',
      flow_id TEXT DEFAULT 'default',
      summary TEXT DEFAULT '',
      urgency TEXT DEFAULT 'normal',
      sentiment TEXT DEFAULT 'neutro',
      appointment_at BIGINT,
      appointment_notes TEXT,
      followup_enabled BOOLEAN DEFAULT false,
      followup_offset_min INT DEFAULT 60,
      followup_msg TEXT DEFAULT '',
      created_at BIGINT,
      updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS crm_flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stages JSONB NOT NULL DEFAULT '[]',
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS crm_followups (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      scheduled_at BIGINT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'appointment',
      sent BOOLEAN DEFAULT false,
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS ai_memory (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence TEXT DEFAULT 'medium',
      source_count INT DEFAULT 1,
      created_at BIGINT,
      updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS ai_reports (
      id TEXT PRIMARY KEY,
      report_date TEXT NOT NULL UNIQUE,
      content TEXT,
      mood TEXT DEFAULT 'neutra',
      mood_score INT DEFAULT 50,
      metrics JSONB DEFAULT '{}',
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS ai_mood (
      id TEXT PRIMARY KEY,
      mood TEXT DEFAULT 'neutra',
      mood_score INT DEFAULT 50,
      summary TEXT DEFAULT '',
      updated_at BIGINT
    );
    INSERT INTO app_stats (key, value) VALUES
      ('totalSent',0),('textSent',0),('audioSent',0),('errors',0),('startTime', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
    ON CONFLICT (key) DO NOTHING;
  `);
}

// ── CONVERSATION HISTORY ──
const MAX_HISTORY = 20; // max turns (1 turn = user + AI)
const HISTORY_TTL = 24 * 60 * 60 * 1000; // 24h inactivity resets context

async function getHistory(phone) {
  const { rows } = await pool.query('SELECT history, updated_at FROM conversations WHERE phone=$1', [phone]);
  if (!rows.length) return [];
  if (Date.now() - rows[0].updated_at > HISTORY_TTL) {
    await pool.query('DELETE FROM conversations WHERE phone=$1', [phone]);
    return [];
  }
  return rows[0].history;
}

async function saveHistory(phone, history) {
  const trimmed = history.slice(-MAX_HISTORY * 2); // keep last N pairs
  await pool.query(
    'INSERT INTO conversations (phone, history, updated_at) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET history=$2, updated_at=$3',
    [phone, JSON.stringify(trimmed), Date.now()]
  );
}

async function clearHistory(phone) {
  await pool.query('DELETE FROM conversations WHERE phone=$1', [phone]);
}

// ── RELAY (mirror mode) ──
const relay = {
  enabled: false,
  instanceName: null,   // Evolution instance being mirrored (e.g. "cloudchat_93")
  forwardUrl: null,     // Original webhook URL to forward events to (e.g. CloudChat)
};

async function loadRelayConfig() {
  const { rows } = await pool.query("SELECT key, value FROM app_config WHERE key LIKE 'relay_%'");
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  if (map.relay_enabled === 'true') relay.enabled = true;
  if (map.relay_instance) relay.instanceName = map.relay_instance || null;
  if (map.relay_forward_url) relay.forwardUrl = map.relay_forward_url || null;
}

async function saveRelayConfig() {
  const entries = [
    ['relay_enabled', String(relay.enabled)],
    ['relay_instance', relay.instanceName || ''],
    ['relay_forward_url', relay.forwardUrl || ''],
  ];
  for (const [key, value] of entries) {
    await pool.query('INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
  }
}

function activeInstance() {
  return relay.enabled && relay.instanceName ? relay.instanceName : INSTANCE_NAME;
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
    signatureEnabled: false,
    signatureName: '',
    signatureRole: '',
    pauseOnHumanEnabled: false,
    pauseOnHumanTimeout: 30,
    voiceStyle: 'informal',
    voicePace: 'normal',
    businessHoursEnabled: false,
    businessHoursStart: '08:00',
    businessHoursEnd: '18:00',
    businessHoursMsg: 'Nosso horário de atendimento é de segunda a sexta, das 8h às 18h. Em breve um atendente irá te chamar!',
    restrictAIOutsideHours: false,
    noreplyFollowupEnabled: false,
    noreplyFollowupSteps: [],
    aiName: '',
    aiNickname: '',
    aiAge: '',
    aiRole: '',
    aiSegment: '',
    aiAvatarStyle: 'adventurer',
    aiCharacter: 'Mage.glb',
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
  if (map.pauseOnHumanEnabled !== undefined) state.config.pauseOnHumanEnabled = map.pauseOnHumanEnabled === 'true';
  if (map.pauseOnHumanTimeout !== undefined) state.config.pauseOnHumanTimeout = parseInt(map.pauseOnHumanTimeout) || 30;
  if (map.signatureEnabled !== undefined) state.config.signatureEnabled = map.signatureEnabled === 'true';
  if (map.signatureName !== undefined)    state.config.signatureName    = map.signatureName;
  if (map.signatureRole !== undefined)    state.config.signatureRole    = map.signatureRole;
  if (map.voiceStyle)                     state.config.voiceStyle        = map.voiceStyle;
  if (map.voicePace)                      state.config.voicePace         = map.voicePace;
  if (map.businessHoursEnabled !== undefined) state.config.businessHoursEnabled = map.businessHoursEnabled === 'true';
  if (map.businessHoursStart)             state.config.businessHoursStart = map.businessHoursStart;
  if (map.businessHoursEnd)               state.config.businessHoursEnd   = map.businessHoursEnd;
  if (map.businessHoursMsg)               state.config.businessHoursMsg   = map.businessHoursMsg;
  if (map.restrictAIOutsideHours !== undefined) state.config.restrictAIOutsideHours = map.restrictAIOutsideHours === 'true';
  if (map.noreplyFollowupEnabled !== undefined) state.config.noreplyFollowupEnabled = map.noreplyFollowupEnabled === 'true';
  if (map.noreplyFollowupSteps) { try { state.config.noreplyFollowupSteps = JSON.parse(map.noreplyFollowupSteps); } catch {} }
  if (map.aiName !== undefined)     state.config.aiName     = map.aiName;
  if (map.aiNickname !== undefined) state.config.aiNickname = map.aiNickname;
  if (map.aiAge !== undefined)      state.config.aiAge      = map.aiAge;
  if (map.aiRole !== undefined)     state.config.aiRole     = map.aiRole;
  if (map.aiSegment !== undefined)    state.config.aiSegment    = map.aiSegment;
  if (map.aiAvatarStyle !== undefined) state.config.aiAvatarStyle = map.aiAvatarStyle;
  if (map.aiCharacter   !== undefined) state.config.aiCharacter   = map.aiCharacter;
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
    ['pauseOnHumanEnabled',      String(cfg.pauseOnHumanEnabled)],
    ['pauseOnHumanTimeout',      String(cfg.pauseOnHumanTimeout || 30)],
    ['signatureEnabled',         String(cfg.signatureEnabled)],
    ['signatureName',            cfg.signatureName || ''],
    ['signatureRole',            cfg.signatureRole || ''],
    ['voiceStyle',               cfg.voiceStyle || 'informal'],
    ['voicePace',                cfg.voicePace || 'normal'],
    ['businessHoursEnabled',     String(cfg.businessHoursEnabled)],
    ['businessHoursStart',       cfg.businessHoursStart || '08:00'],
    ['businessHoursEnd',         cfg.businessHoursEnd || '18:00'],
    ['businessHoursMsg',         cfg.businessHoursMsg || ''],
    ['restrictAIOutsideHours',   String(cfg.restrictAIOutsideHours)],
    ['noreplyFollowupEnabled',   String(cfg.noreplyFollowupEnabled || false)],
    ['noreplyFollowupSteps',     JSON.stringify(cfg.noreplyFollowupSteps || [])],
    ['aiName',     cfg.aiName     || ''],
    ['aiNickname', cfg.aiNickname || ''],
    ['aiAge',      cfg.aiAge      || ''],
    ['aiRole',     cfg.aiRole     || ''],
    ['aiSegment',    cfg.aiSegment    || ''],
    ['aiAvatarStyle', cfg.aiAvatarStyle || 'adventurer'],
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
  const target = activeInstance();
  return instances.find(i => i.name === target || i.instance?.instanceName === target) || null;
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

// ── LID → PHONE RESOLUTION ──
const lidToPhoneCache = new Map(); // lid_number -> real phone number

async function buildLidMapping() {
  // Try multiple possible Evolution API endpoint variations
  const endpoints = [
    `/contacts/getAll/${activeInstance()}`,
    `/contacts/${activeInstance()}`,
    `/chat/findContacts/${activeInstance()}`,
  ];
  let contacts = [];
  for (const ep of endpoints) {
    const r = await evoRequest('GET', ep).catch(() => null);
    console.log(`[LID MAP TRY] ${ep} → ok=${r?.ok} type=${typeof r?.data} len=${Array.isArray(r?.data)?r.data.length:'?'}`);
    if (r?.ok && Array.isArray(r.data) && r.data.length > 0) { contacts = r.data; break; }
  }
  let mapped = 0;
  for (const c of contacts) {
    const lidRaw = c.lid || c.lidJid || '';
    if (!lidRaw) continue;
    const lid   = String(lidRaw).replace(/@lid$/, '').split(':')[0];
    const phone = String(c.id || c.remoteJid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').split(':')[0];
    if (lid && phone && lid !== phone) { lidToPhoneCache.set(lid, phone); mapped++; }
  }
  const msg = `LID map: ${mapped} de ${contacts.length} contatos resolvidos`;
  console.log(`[LID MAP] ${msg}`);
  await addLog('info', 'system', null, msg).catch(() => {});
}

async function resolvePhone(rawPhone, remoteJid) {
  if (!remoteJid?.includes('@lid')) return rawPhone;
  if (lidToPhoneCache.has(rawPhone)) return lidToPhoneCache.get(rawPhone);
  await buildLidMapping();
  const resolved = lidToPhoneCache.get(rawPhone);
  if (resolved) console.log(`[LID] ${rawPhone} → ${resolved}`);
  return resolved || rawPhone;
}

// ── CONTACT TRACKING ──
const contactsMap = new Map(); // rawPhone → {name, rawJid, firstSeen, lastSeen}
let lastLidContact = null; // {rawPhone, timestamp} for time-based LID correlation

async function fetchProfilePic(rawJid) {
  const r = await evoRequest('GET', `/chat/getProfilePictureUrl/${activeInstance()}?number=${encodeURIComponent(rawJid)}`).catch(() => null);
  return r?.data?.profilePictureUrl || r?.data?.url || null;
}

function trackContact(rawPhone, name, rawJid) {
  const ex = contactsMap.get(rawPhone) || {};
  contactsMap.set(rawPhone, {
    name: name || ex.name || '',
    rawJid,
    profilePic: ex.profilePic || null,
    firstSeen: ex.firstSeen || Date.now(),
    lastSeen: Date.now()
  });
  if (rawJid?.includes('@lid')) lastLidContact = { rawPhone, timestamp: Date.now() };
  if (!ex.profilePic) {
    fetchProfilePic(rawJid).then(url => {
      if (url) { const c = contactsMap.get(rawPhone); if (c) c.profilePic = url; }
    }).catch(() => {});
  }
}

// ── HUMAN PAUSE SYSTEM ──
const humanPaused = new Map();   // phone -> timestamp of last human interaction
const aiSentIds = new Set();     // message IDs sent by the AI (to distinguish from human sends)

function pauseContact(phone) {
  humanPaused.set(phone, Date.now());
  pool.query('INSERT INTO human_paused (phone, paused_at) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET paused_at=$2', [phone, Date.now()]).catch(() => {});
}

function isHumanPaused(rawPhone, resolvedPhone) {
  if (!state.config.pauseOnHumanEnabled) return false;
  const ms = (state.config.pauseOnHumanTimeout || 30) * 60 * 1000;
  const check = (p) => {
    if (!p) return false;
    const last = humanPaused.get(p);
    if (!last) return false;
    if (Date.now() - last >= ms) { humanPaused.delete(p); return false; }
    return true;
  };
  if (check(rawPhone) || check(resolvedPhone)) return true;
  // Cross-check via lidToPhoneCache
  const mapped = lidToPhoneCache.get(rawPhone);
  if (mapped && check(mapped)) return true;
  for (const [lid, mp] of lidToPhoneCache.entries()) {
    if (mp === rawPhone && check(lid)) return true;
  }
  return false;
}

function resumeContact(phone) {
  // Clear this phone + all LID-mapped variants
  const toDelete = new Set([phone]);
  const mapped = lidToPhoneCache.get(phone);
  if (mapped) toDelete.add(mapped);
  for (const [lid, mp] of lidToPhoneCache.entries()) {
    if (mp === phone) toDelete.add(lid);
  }
  for (const p of toDelete) {
    humanPaused.delete(p);
    pool.query('DELETE FROM human_paused WHERE phone=$1', [p]).catch(() => {});
  }
}

// ── CRM ──
const DEFAULT_STAGES = [
  { id: 'novo',       name: 'Novo Contato',          color: '#8696a0' },
  { id: 'atendimento',name: 'Em Atendimento',         color: '#3b82f6' },
  { id: 'aguardando', name: 'Aguardando Retorno',     color: '#f59e0b' },
  { id: 'qualificado',name: 'Qualificado',            color: '#00a884' },
  { id: 'agendado',   name: 'Agendado',               color: '#8b5cf6' },
  { id: 'humano',     name: 'Atendimento Humano',     color: '#ef4444' },
  { id: 'convertido', name: 'Convertido',             color: '#10b981' },
  { id: 'perdido',    name: 'Perdido',                color: '#6b7280' },
];

async function analyzeCRM(phone, history) {
  if (!GEMINI_KEY || history.length < 2) return;
  try {
    const lastMsgs = history.slice(-12);
    const convText = lastMsgs.map(m => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.text}`).join('\n');
    const prompt = `Analise esta conversa de atendimento e retorne APENAS JSON válido (sem markdown, sem explicação):
{
  "stage": "novo|atendimento|aguardando|qualificado|agendado|humano|convertido|perdido",
  "summary": "resumo de 2-3 linhas com pontos principais da conversa",
  "urgency": "baixa|normal|alta",
  "sentiment": "negativo|neutro|positivo",
  "appointment_iso": "2026-03-23T14:00:00" ou null se não houver agendamento,
  "appointment_notes": "notas do agendamento" ou null
}
Regras de stage:
- "novo": apenas primeiro contato
- "atendimento": IA conversando ativamente
- "aguardando": IA enviou última mensagem, aguardando resposta
- "qualificado": informações principais já coletadas
- "agendado": data e hora marcadas explicitamente
- "humano": solicitou humano ou humano assumiu
- "convertido"/"perdido": apenas se cliente confirmou ou desistiu explicitamente

Conversa:
${convText}`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }
    );
    if (!r.ok) return;
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());

    const contact = contactsMap.get(phone) || {};
    const now = Date.now();
    const appointmentAt = json.appointment_iso ? new Date(json.appointment_iso).getTime() : null;

    await pool.query(`
      INSERT INTO crm_leads (phone, name, raw_jid, profile_pic, stage, summary, urgency, sentiment, appointment_at, appointment_notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
      ON CONFLICT (phone) DO UPDATE SET
        name=EXCLUDED.name, raw_jid=EXCLUDED.raw_jid, profile_pic=EXCLUDED.profile_pic,
        stage=CASE WHEN crm_leads.stage IN ('convertido','perdido') THEN crm_leads.stage ELSE EXCLUDED.stage END,
        summary=EXCLUDED.summary, urgency=EXCLUDED.urgency, sentiment=EXCLUDED.sentiment,
        appointment_at=COALESCE(EXCLUDED.appointment_at, crm_leads.appointment_at),
        appointment_notes=COALESCE(EXCLUDED.appointment_notes, crm_leads.appointment_notes),
        updated_at=EXCLUDED.updated_at
    `, [phone, contact.name || '', contact.rawJid || '', contact.profilePic || null,
        json.stage || 'atendimento', json.summary || '', json.urgency || 'normal', json.sentiment || 'neutro',
        appointmentAt, json.appointment_notes || null, now]);

    // Schedule follow-up if appointment detected
    if (appointmentAt && appointmentAt > now) {
      const lead = await pool.query('SELECT followup_enabled, followup_offset_min, followup_msg FROM crm_leads WHERE phone=$1', [phone]);
      const l = lead.rows[0];
      if (l?.followup_enabled && l.followup_msg) {
        const scheduledAt = appointmentAt - (l.followup_offset_min * 60 * 1000);
        if (scheduledAt > now) {
          await pool.query(
            'INSERT INTO crm_followups (id, phone, scheduled_at, message, type, sent, created_at) VALUES ($1,$2,$3,$4,$5,false,$6) ON CONFLICT DO NOTHING',
            [uuidv4(), phone, scheduledAt, l.followup_msg, 'appointment', now]
          ).catch(() => {});
        }
      }
    }
    console.log(`[CRM] ${phone} → stage=${json.stage} urgency=${json.urgency}`);
  } catch (err) {
    console.log(`[CRM ERR] ${err.message}`);
  }
}

async function analyzeMemory(phone, history) {
  if (!GEMINI_KEY || history.length < 4) return;
  try {
    const lastMsgs = history.slice(-10);
    const convText = lastMsgs.map(m => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.text}`).join('\n');
    const prompt = `Analise esta conversa de atendimento e extraia insights comportamentais específicos para melhorar futuros atendimentos.

Conversa:
${convText}

Retorne APENAS um JSON válido:
{"insights":[{"category":"linguagem|comportamento|preferencias|alerta","content":"insight acionável em uma frase curta","confidence":"high|medium"}]}

Categorias:
- linguagem: como o cliente gosta de ser tratado (formal/informal, pelo nome, emojis, áudio)
- comportamento: padrões observados (horário preferido, tipo de dúvida, objeções)
- preferencias: o que funcionou bem ou foi elogiado
- alerta: erros, reclamações ou correções necessárias

Se não houver insights relevantes, retorne {"insights":[]}.`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }
    );
    if (!r.ok) return;
    const d = await r.json();
    const text = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().replace(/```json\n?|```\n?/g, '');
    const json = JSON.parse(text);
    if (!json.insights?.length) return;
    const now = Date.now();
    for (const ins of json.insights) {
      if (!ins.content || !ins.category) continue;
      await pool.query(
        'INSERT INTO ai_memory (id, category, content, confidence, source_count, created_at, updated_at) VALUES ($1,$2,$3,$4,1,$5,$5)',
        [uuidv4(), ins.category, ins.content.slice(0, 300), ins.confidence || 'medium', now]
      );
    }
    // Prune to max 200 entries keeping highest source_count
    await pool.query(`DELETE FROM ai_memory WHERE id IN (SELECT id FROM ai_memory ORDER BY source_count ASC, updated_at ASC OFFSET 200)`);
    console.log(`[MEMORY] ${json.insights.length} insight(s) adicionados`);
  } catch (e) { console.log('[MEMORY ERR]', e.message); }
}

async function generateDailyReport() {
  if (!GEMINI_KEY) return;
  try {
    const now = Date.now();
    const dayAgo = now - 86400000;
    const today = getBrazilDate();
    const { rows: leads } = await pool.query('SELECT stage, sentiment FROM crm_leads WHERE updated_at > $1', [dayAgo]);
    const { rows: totalRow } = await pool.query('SELECT COUNT(*) as count FROM crm_leads');
    const { rows: msgCount } = await pool.query('SELECT COUNT(*) as count FROM conversations WHERE last_user_at > $1', [dayAgo]);
    const { rows: memory } = await pool.query('SELECT category, content FROM ai_memory ORDER BY source_count DESC LIMIT 15');
    const stageCount = {}, sentimentCount = {};
    leads.forEach(l => {
      stageCount[l.stage] = (stageCount[l.stage] || 0) + 1;
      sentimentCount[l.sentiment] = (sentimentCount[l.sentiment] || 0) + 1;
    });
    const converted = stageCount['convertido'] || 0;
    const lost = stageCount['perdido'] || 0;
    const total = leads.length;
    const convRate = total > 0 ? Math.round((converted / total) * 100) : 0;
    const memText = memory.map(m => `[${m.category}] ${m.content}`).join('\n') || 'Nenhuma ainda.';
    const { aiName, aiRole, aiSegment } = state.config;
    const prompt = `Você é ${aiName || 'a IA'}, assistente${aiRole ? ` ${aiRole}` : ''}${aiSegment ? ` de ${aiSegment}` : ''}.

Escreva um relato em primeira pessoa (2-3 parágrafos curtos) sobre como foi o dia de atendimento. Mostre personalidade, seja autêntica, mencione o que aprendeu.

Dados do dia:
- Mensagens recebidas: ${Number(msgCount[0]?.count || 0)}
- Leads ativos: ${total} | Convertidos: ${converted} (${convRate}%) | Perdidos: ${lost}
- Sentimentos: ${JSON.stringify(sentimentCount)}
- Estágios: ${JSON.stringify(stageCount)}

Minha memória acumulada:
${memText}

Após o relato, em uma linha separada, retorne APENAS: MOOD:{"mood":"animada|otimista|neutra|preocupada|frustrada","score":0-100}`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }
    );
    if (!r.ok) return;
    const d = await r.json();
    const text = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const moodLine = text.match(/MOOD:\{[^}]+\}/);
    let mood = 'neutra', moodScore = 50;
    if (moodLine) {
      try { const m = JSON.parse(moodLine[0].replace('MOOD:', '')); mood = m.mood || 'neutra'; moodScore = m.score || 50; } catch {}
    }
    const content = text.replace(/MOOD:\{[^}]+\}/, '').trim();
    const metrics = { total, converted, lost, convRate, stageCount, sentimentCount, messages: Number(msgCount[0]?.count || 0) };
    await pool.query(
      'INSERT INTO ai_reports (id, report_date, content, mood, mood_score, metrics, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (report_date) DO UPDATE SET content=$3, mood=$4, mood_score=$5, metrics=$6, created_at=$7',
      [uuidv4(), today, content, mood, moodScore, JSON.stringify(metrics), now]
    );
    await pool.query(
      "INSERT INTO ai_mood (id, mood, mood_score, summary, updated_at) VALUES ('singleton',$1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET mood=$1, mood_score=$2, summary=$3, updated_at=$4",
      [mood, moodScore, content.slice(0, 600), now]
    );
    console.log(`[REPORT] Relatório gerado — mood: ${mood} (${moodScore})`);
  } catch (e) { console.log('[REPORT ERR]', e.message); }
}

function captureLidFromSendResponse(sentTo, responseData) {
  const resolvedJid = responseData?.key?.remoteJid || '';
  if (resolvedJid.includes('@s.whatsapp.net')) {
    const resolved = resolvedJid.replace(/@s\.whatsapp\.net$/, '').split(':')[0];
    const lid = sentTo.replace(/@lid$/, '').split(':')[0];
    if (lid !== resolved && !lidToPhoneCache.has(lid)) {
      lidToPhoneCache.set(lid, resolved);
      console.log(`[LID AUTO] ${lid} → ${resolved}`);
      addLog('info', 'system', null, `LID mapeado: ${lid} → ${resolved}`).catch(() => {});
    }
  }
}

async function sendText(phone, text) {
  const r = await evoRequest('POST', `/message/sendText/${activeInstance()}`, { number: phone, text });
  if (r.ok && r.data?.key?.id) {
    aiSentIds.add(r.data.key.id);
    setTimeout(() => aiSentIds.delete(r.data.key.id), 60000);
    captureLidFromSendResponse(phone, r.data);
  }
  return r;
}

async function transcribeAudioMessage(msg) {
  try {
    // Download audio from Evolution API
    const r = await evoRequest('POST', `/chat/getBase64FromMediaMessage/${activeInstance()}`, {
      message: { key: msg.key, messageTimestamp: msg.messageTimestamp, message: msg.message }
    });
    if (!r.ok || !r.data?.base64) return null;
    const audioBase64 = r.data.base64;
    const mimetype = r.data.mimetype || 'audio/ogg; codecs=opus';
    const mimeType = mimetype.split(';')[0].trim();

    // Transcribe with Gemini multimodal
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Transcreva exatamente o conteúdo deste áudio em português. Retorne APENAS a transcrição, sem comentários adicionais.' },
              { inline_data: { mime_type: mimeType, data: audioBase64 } }
            ]
          }]
        })
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) {
    console.log('[TRANSCRIBE ERR]', e.message);
    return null;
  }
}

async function sendAudio(phone, audioBase64, mimetype = 'audio/mpeg') {
  const r = await evoRequest('POST', `/message/sendMedia/${activeInstance()}`, {
    number: phone, mediatype: 'audio', mimetype, media: audioBase64, fileName: 'audio.mp3'
  });
  if (r.ok && r.data?.key?.id) {
    aiSentIds.add(r.data.key.id);
    setTimeout(() => aiSentIds.delete(r.data.key.id), 60000);
    captureLidFromSendResponse(phone, r.data);
  }
  return r;
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

function isWithinBusinessHours() {
  const { businessHoursEnabled, businessHoursStart, businessHoursEnd } = state.config;
  if (!businessHoursEnabled) return true;
  const t = getBrazilTimeStr();
  return t >= businessHoursStart && t <= businessHoursEnd;
}

// ── GEMINI ──
async function callGemini(userMessage, persona, model = 'gemini-2.0-flash', history = []) {
  // Build identity context
  const { aiName, aiNickname, aiAge, aiRole, aiSegment } = state.config;
  let identityCtx = '';
  if (aiName) {
    identityCtx = `\n\nIDENTIDADE: Seu nome é ${aiName}${aiNickname ? ` (pode ser chamada de ${aiNickname})` : ''}${aiAge ? `, você tem ${aiAge} anos` : ''}${aiRole ? `, seu cargo é ${aiRole}` : ''}${aiSegment ? ` no segmento de ${aiSegment}` : ''}.`;
  }

  // Load memory context (top 25 insights by source_count)
  let memoryCtx = '';
  try {
    const { rows: mem } = await pool.query(
      'SELECT category, content FROM ai_memory ORDER BY source_count DESC, updated_at DESC LIMIT 25'
    );
    if (mem.length) {
      const grouped = {};
      mem.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m.content); });
      const catLabels = { linguagem: 'LINGUAGEM', comportamento: 'COMPORTAMENTO', preferencias: 'PREFERÊNCIAS', alerta: 'ALERTAS' };
      const parts = Object.entries(grouped).map(([cat, items]) =>
        `${catLabels[cat] || cat.toUpperCase()}:\n${items.map(i => `• ${i}`).join('\n')}`
      );
      memoryCtx = `\n\nMEMÓRIA DE APRENDIZADO (aplique automaticamente nesta conversa):\n${parts.join('\n\n')}`;
    }
  } catch {}

  const audioInstruction = state.config.audioRoutingEnabled && ELEVENLABS_KEY && state.config.voiceId
    ? `\n\nINSTRUÇÃO DE FORMATO: Inicie SEMPRE cada resposta com [AUDIO] ou [TEXTO].\n- Use [AUDIO] para: saudações, warmup, follow-up pessoal, mensagens curtas.\n- Use [TEXTO] para: preços, links, dados técnicos, listas.\nNUNCA omita esse prefixo.`
    : '';

  const formatInstruction = `\n\nINSTRUÇÃO DE FORMATAÇÃO WHATSAPP: NUNCA use ** (dois asteriscos) para negrito. No WhatsApp, negrito se faz com *um asterisco* de cada lado. Evite formatação markdown desnecessária. NUNCA inclua seu nome, cargo ou assinatura no corpo da mensagem — isso é adicionado automaticamente pelo sistema.`;

  const styleLabels = { formal: 'formal e profissional', informal: 'informal e amigável', casual: 'descontraída e casual' };
  const paceLabels  = { slow: 'pausada e calma, com frases mais curtas', normal: 'natural', fast: 'dinâmica e direta' };
  const styleInstruction = `\n\nESTILO DE COMUNICAÇÃO: Use linguagem ${styleLabels[state.config.voiceStyle] || 'amigável'}, com ritmo ${paceLabels[state.config.voicePace] || 'natural'}.`;

  const withinHours = isWithinBusinessHours();
  const hoursInstruction = state.config.businessHoursEnabled
    ? (withinHours
      ? `\n\nHORÁRIO DE ATENDIMENTO: ${state.config.businessHoursStart}–${state.config.businessHoursEnd}. Se o cliente pedir para falar com um humano, informe que em breve um atendente irá atendê-lo.`
      : `\n\nATENÇÃO: Estamos FORA do horário de atendimento (${state.config.businessHoursStart}–${state.config.businessHoursEnd}). Se o cliente pedir atendente humano, informe gentilmente: "${state.config.businessHoursMsg}"`)
    : '';

  const timeCtx = `\n\n[HORA ATUAL EM BRASÍLIA: ${brazilNow()}]`;

  // Build multi-turn contents from history + current message
  const contents = [
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: persona + identityCtx + timeCtx + audioInstruction + formatInstruction + styleInstruction + hoursInstruction + memoryCtx }] },
        contents
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── ELEVENLABS ──
async function callElevenLabs(text, voiceId) {
  const stylePresets = {
    formal:   { stability: 0.70, similarity_boost: 0.80, style: 0.00 },
    informal: { stability: 0.50, similarity_boost: 0.75, style: 0.30 },
    casual:   { stability: 0.40, similarity_boost: 0.70, style: 0.50 },
  };
  const paceMap = { slow: 0.80, normal: 1.00, fast: 1.20 };
  const voice_settings = stylePresets[state.config.voiceStyle] || stylePresets.informal;
  const speed = paceMap[state.config.voicePace] || 1.00;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings, speed })
  });
  if (!res.ok) throw new Error(`ElevenLabs error: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ── PROCESS MESSAGE ──
const processingQueue = new Set();

async function processMessage(phone, messageText, sendTarget = null, rawPhone = null) {
  if (processingQueue.has(phone)) return;
  if (!state.config.aiEnabled) return;
  if (state.config.restrictAIOutsideHours && !isWithinBusinessHours()) return;
  if (isHumanPaused(rawPhone || phone, phone)) {
    await addLog('info', 'system', phone, `IA inativa (atendimento humano ativo)`);
    return;
  }
  processingQueue.add(phone);
  await addLog('message', 'in', phone, messageText);

  try {
    const { persona, geminiModel, voiceId, delayMin, delayMax } = state.config;
    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY não configurada');

    const delay = Math.floor(Math.random() * (delayMax - delayMin)) + delayMin;
    await new Promise(r => setTimeout(r, delay));

    const history = await getHistory(phone);
    const rawResponse = await callGemini(messageText, persona, geminiModel, history);
    await addLog('ai', 'system', phone, `Gemini: ${rawResponse.slice(0, 120)}`);

    // Strip [AUDIO]/[TEXTO] tags from anywhere in the response
    let cleanResponse = rawResponse.replace(/\[(AUDIO|TEXTO)\]\s*/gi, '').trim();

    // Fix WhatsApp formatting: replace **text** with *text*
    cleanResponse = cleanResponse.replace(/\*\*(.+?)\*\*/gs, '*$1*');

    // Save history WITHOUT signature so AI doesn't learn to repeat it
    await saveHistory(phone, [
      ...history,
      { role: 'user', text: messageText },
      { role: 'model', text: cleanResponse }
    ]);

    const isAudio = shouldSendAudio(rawResponse);

    // Prepend signature AFTER saving history — only for text messages, never for audio
    const { signatureEnabled, signatureName, signatureRole } = state.config;
    if (!isAudio && signatureEnabled && signatureName) {
      const sig = signatureRole ? `*${signatureName}* - ${signatureRole}:` : `*${signatureName}*:`;
      cleanResponse = `${sig}\n\n${cleanResponse}`;
    }

    const dest = sendTarget || phone;
    if (isAudio) {
      const audioBase64 = await callElevenLabs(cleanResponse, voiceId);
      const r = await sendAudio(dest, audioBase64);
      if (r.ok) {
        state._audioTodayCount++;
        await incStat('audioSent'); await incStat('totalSent');
        await addLog('message', 'out', phone, `[ÁUDIO] ${cleanResponse.slice(0, 80)}`, { format: 'audio' });
      } else throw new Error(`sendAudio failed: ${JSON.stringify(r.data)}`);
    } else {
      const r = await sendText(dest, cleanResponse);
      if (r.ok) {
        await incStat('textSent'); await incStat('totalSent');
        await addLog('message', 'out', phone, cleanResponse.slice(0, 200), { format: 'text' });
      } else throw new Error(`sendText failed: ${JSON.stringify(r.data)}`);
    }
    // Track last AI send time for noreply follow-up
    pool.query('UPDATE conversations SET last_ai_at=$1 WHERE phone=$2', [Date.now(), phone]).catch(() => {});
    // Background CRM analysis (non-blocking)
    analyzeCRM(phone, [...history, { role: 'user', text: messageText }, { role: 'model', text: cleanResponse.replace(/^\*.+?\*:\s*\n\n/, '') }]).catch(() => {});
    analyzeMemory(phone, [...history, { role: 'user', text: messageText }, { role: 'model', text: cleanResponse.replace(/^\*.+?\*:\s*\n\n/, '') }]).catch(() => {});
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

  // Relay: forward original event to CloudChat (fire-and-forget)
  if (relay.enabled && relay.forwardUrl) {
    fetch(relay.forwardUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});
  }
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

    const remoteJid = msg.key?.remoteJid || msg.remoteJid;
    const rawPhone = remoteJid?.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/@lid$/, '').split(':')[0];
    if (!rawPhone || remoteJid?.includes('@g.us')) return;
    const phone = await resolvePhone(rawPhone, remoteJid);

    const isFromMe = msg.key?.fromMe || msg.fromMe;

    if (isFromMe) {
      // Detect human agent (not AI) sending a message → pause AI for this contact
      if (state.config.pauseOnHumanEnabled) {
        const msgId = msg.key?.id;
        if (!msgId || !aiSentIds.has(msgId)) {
          // Human interaction detected
          pauseContact(rawPhone);
          // Time-based LID correlation: if human sends to @s.whatsapp.net shortly after a @lid message, map them
          if (!remoteJid?.includes('@lid') && lastLidContact && Date.now() - lastLidContact.timestamp < 300000) {
            if (!lidToPhoneCache.has(lastLidContact.rawPhone)) {
              lidToPhoneCache.set(lastLidContact.rawPhone, rawPhone);
              console.log(`[LID CORR] ${lastLidContact.rawPhone} → ${rawPhone} (time-based)`);
            }
            pauseContact(lastLidContact.rawPhone);
          }
          // Also pause any reverse-mapped lids
          for (const [lid, mp] of lidToPhoneCache.entries()) {
            if (mp === rawPhone) pauseContact(lid);
          }
          const humanText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          if (humanText) {
            const pausedPhone = lidToPhoneCache.get(lastLidContact?.rawPhone) === rawPhone ? lastLidContact.rawPhone : rawPhone;
            const history = await getHistory(pausedPhone);
            await saveHistory(pausedPhone, [...history, { role: 'model', text: `[Atendente humano]: ${humanText}` }]);
          }
          await addLog('info', 'system', rawPhone, `IA pausada: interação humana detectada. Retoma em ${state.config.pauseOnHumanTimeout}min`);
        }
      }
      return;
    }

    trackContact(rawPhone, msg.pushName, remoteJid);
    // Track last user message time for noreply follow-up
    pool.query('UPDATE conversations SET last_user_at=$1 WHERE phone=$2', [Date.now(), phone]).catch(() => {});
    const isBlocked = state.config.ignoredNumbers?.includes(rawPhone) || (phone !== rawPhone && state.config.ignoredNumbers?.includes(phone));
    console.log(`[MSG] rawPhone="${rawPhone}" phone="${phone}" blocked=${isBlocked}`);
    if (isBlocked) return;

    const textContent =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption || null;

    // For @lid contacts, pass the original JID as sendTarget so the reply reaches the right device
    const sendTarget = remoteJid?.includes('@lid') ? remoteJid : null;

    if (textContent) {
      processMessage(phone, textContent, sendTarget, rawPhone);
    } else if (msg.message?.audioMessage && GEMINI_KEY) {
      transcribeAudioMessage(msg).then(transcription => {
        const messageText = transcription
          ? `[áudio transcrito]: ${transcription}`
          : '[O cliente enviou um áudio, mas não foi possível transcrever. Peça para ele repetir por texto.]';
        processMessage(phone, messageText, sendTarget, rawPhone);
      }).catch(() => {
        processMessage(phone, '[O cliente enviou um áudio de voz. Peça para ele repetir por texto.]', sendTarget, rawPhone);
      });
    }
  }
});

// ── API ROUTES ──
app.get('/api/status', async (req, res) => {
  const instance = await getInstanceStatus().catch(() => null);
  res.json({
    instance: instance ? {
      name: activeInstance(),
      state: instance.instance?.state || instance.connectionStatus || state._connectionState,
      number: instance.instance?.number || null
    } : null,
    connectionState: state._connectionState,
    qrAvailable: !!state._qrBase64,
    uptime: Math.floor((Date.now() - state.stats.startTime) / 1000),
    stats: state.stats,
    relay: { enabled: relay.enabled, instanceName: relay.instanceName, forwardUrl: relay.forwardUrl }
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
  const allowed = ['persona','geminiModel','voiceId','delayMin','delayMax','audioRoutingEnabled','ignoredNumbers','aiEnabled','audioDailyLimit','audioMode','audioScheduleStart','audioScheduleEnd','signatureEnabled','signatureName','signatureRole','voiceStyle','voicePace','businessHoursEnabled','businessHoursStart','businessHoursEnd','businessHoursMsg','restrictAIOutsideHours','pauseOnHumanEnabled','pauseOnHumanTimeout','noreplyFollowupEnabled','noreplyFollowupSteps','aiName','aiNickname','aiAge','aiRole','aiSegment','aiAvatarStyle','aiCharacter'];
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

app.delete('/api/conversations/:phone', async (req, res) => {
  await clearHistory(req.params.phone);
  res.json({ ok: true });
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
    const contents = messages.map(m => {
      const parts = [{ text: m.text || '' }];
      if (m.imageBase64 && m.imageMimeType) {
        parts.push({ inlineData: { mimeType: m.imageMimeType, data: m.imageBase64 } });
      }
      return { role: m.role === 'ai' ? 'model' : 'user', parts };
    });
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

// ── CRM API ──
app.get('/api/crm/leads', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads ORDER BY updated_at DESC');
    res.json({ ok: true, leads: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/crm/leads/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { stage, summary, followup_enabled, followup_offset_min, followup_msg, appointment_at, appointment_notes } = req.body;
    const updates = [], vals = [];
    let i = 1;
    if (stage !== undefined) { updates.push(`stage=$${i++}`); vals.push(stage); }
    if (summary !== undefined) { updates.push(`summary=$${i++}`); vals.push(summary); }
    if (followup_enabled !== undefined) { updates.push(`followup_enabled=$${i++}`); vals.push(followup_enabled); }
    if (followup_offset_min !== undefined) { updates.push(`followup_offset_min=$${i++}`); vals.push(followup_offset_min); }
    if (followup_msg !== undefined) { updates.push(`followup_msg=$${i++}`); vals.push(followup_msg); }
    if (appointment_at !== undefined) { updates.push(`appointment_at=$${i++}`); vals.push(appointment_at); }
    if (appointment_notes !== undefined) { updates.push(`appointment_notes=$${i++}`); vals.push(appointment_notes); }
    if (updates.length) {
      updates.push(`updated_at=$${i++}`); vals.push(Date.now()); vals.push(phone);
      await pool.query(`UPDATE crm_leads SET ${updates.join(',')} WHERE phone=$${i}`, vals);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/crm/leads/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await pool.query('DELETE FROM crm_leads WHERE phone=$1', [phone]);
    await pool.query('DELETE FROM crm_followups WHERE phone=$1', [phone]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/crm/appointments', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads WHERE appointment_at IS NOT NULL ORDER BY appointment_at ASC');
    res.json({ ok: true, appointments: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/crm/followups', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_followups ORDER BY scheduled_at ASC');
    res.json({ ok: true, followups: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/crm/followups', async (req, res) => {
  try {
    const { phone, scheduledAt, message, type } = req.body;
    if (!phone || !scheduledAt || !message) return res.status(400).json({ error: 'phone, scheduledAt, message obrigatórios' });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO crm_followups (id, phone, scheduled_at, message, type, sent, created_at) VALUES ($1,$2,$3,$4,$5,false,$6)',
      [id, phone, scheduledAt, message, type || 'manual', Date.now()]
    );
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/crm/followups/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_followups WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/crm/flows', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_flows ORDER BY created_at ASC');
    res.json({ ok: true, flows: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/crm/flows', async (req, res) => {
  try {
    const { name, stages } = req.body;
    if (!name || !stages?.length) return res.status(400).json({ error: 'name e stages obrigatórios' });
    const id = uuidv4();
    await pool.query('INSERT INTO crm_flows (id, name, stages, created_at) VALUES ($1,$2,$3,$4)', [id, name, JSON.stringify(stages), Date.now()]);
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/crm/flows/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_flows WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── CONTACTS API ──
app.get('/api/contacts', (req, res) => {
  const contacts = [];
  for (const [id, info] of contactsMap.entries()) {
    contacts.push({
      id,
      name: info.name,
      rawJid: info.rawJid,
      profilePic: info.profilePic || null,
      lastSeen: info.lastSeen,
      blocked: !!(state.config.ignoredNumbers?.includes(id))
    });
  }
  contacts.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ ok: true, contacts });
});

app.post('/api/contacts/:id/block', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!state.config.ignoredNumbers.includes(id)) {
    state.config.ignoredNumbers.push(id);
    await saveConfig();
  }
  res.json({ ok: true });
});

app.delete('/api/contacts/:id/block', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  state.config.ignoredNumbers = state.config.ignoredNumbers.filter(n => n !== id);
  await saveConfig();
  res.json({ ok: true });
});

// ── AI MEMORY & DASHBOARD ENDPOINTS ──
app.get('/api/ai/memory', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ai_memory ORDER BY source_count DESC, updated_at DESC');
  res.json({ ok: true, memory: rows });
});

app.delete('/api/ai/memory/:id', async (req, res) => {
  await pool.query('DELETE FROM ai_memory WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/ai/mood', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ai_mood WHERE id='singleton'");
  res.json({ ok: true, mood: rows[0] || { mood: 'neutra', mood_score: 50, summary: '' } });
});

app.get('/api/ai/report', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ai_reports ORDER BY created_at DESC LIMIT 1');
  res.json({ ok: true, report: rows[0] || null });
});

app.post('/api/ai/report/generate', async (req, res) => {
  await generateDailyReport();
  res.json({ ok: true });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const now = Date.now();
    const dayAgo = now - 86400000;
    const weekAgo = now - 604800000;
    const [moodRows, totalRow, heatmap, memory, report, stages, msgToday, metricsRow, semRespostaRow] = await Promise.all([
      pool.query("SELECT * FROM ai_mood WHERE id='singleton'"),
      pool.query('SELECT COUNT(*)::int as count FROM crm_leads'),
      // Heatmap: use type='message' to avoid counting system logs; group by hour
      pool.query(`SELECT EXTRACT(HOUR FROM to_timestamp(ts/1000) AT TIME ZONE 'America/Sao_Paulo')::int as hour, COUNT(*)::int as count
        FROM app_logs WHERE type='message' AND direction='in' AND ts > $1 GROUP BY hour ORDER BY hour`, [weekAgo]),
      pool.query('SELECT id, category, content, source_count FROM ai_memory ORDER BY source_count DESC, updated_at DESC LIMIT 12'),
      pool.query('SELECT * FROM ai_reports ORDER BY created_at DESC LIMIT 1'),
      pool.query('SELECT stage, COUNT(*)::int as count FROM crm_leads GROUP BY stage'),
      // "Mensagens hoje" = unique contacts who sent a message today (deduplicated via conversations table)
      pool.query('SELECT COUNT(*)::int as count FROM conversations WHERE last_user_at > $1', [dayAgo]),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE updated_at > $1)::int as leads_hoje,
        COUNT(*) FILTER (WHERE stage='qualificado')::int as qualificados,
        COUNT(*) FILTER (WHERE stage='agendado')::int as agendados,
        COUNT(*) FILTER (WHERE stage='convertido')::int as convertidos,
        COUNT(*) FILTER (WHERE stage='humano')::int as humanos,
        COUNT(*) FILTER (WHERE stage='perdido')::int as perdidos,
        COUNT(*) FILTER (WHERE stage='atendimento')::int as em_atendimento,
        COUNT(*) FILTER (WHERE stage='aguardando')::int as aguardando,
        COUNT(*) FILTER (WHERE stage='novo')::int as novos
      FROM crm_leads`, [dayAgo]),
      // Sem resposta: AI enviou por último e cliente não respondeu (últimas 48h)
      pool.query(`SELECT COUNT(*)::int as count FROM conversations
        WHERE last_ai_at IS NOT NULL AND last_ai_at > $1
        AND (last_user_at IS NULL OR last_ai_at > last_user_at)`, [now - 172800000]),
    ]);
    const m = metricsRow.rows[0] || {};
    res.json({
      ok: true,
      mood: moodRows.rows[0] || { mood: 'neutra', mood_score: 50, summary: '' },
      totalLeads: totalRow.rows[0]?.count || 0,
      messagesHoje: msgToday.rows[0]?.count || 0,
      leadsHoje: m.leads_hoje || 0,
      qualificados: m.qualificados || 0,
      agendados: m.agendados || 0,
      convertidos: m.convertidos || 0,
      humanos: m.humanos || 0,
      perdidos: m.perdidos || 0,
      emAtendimento: m.em_atendimento || 0,
      aguardando: m.aguardando || 0,
      novos: m.novos || 0,
      semResposta: semRespostaRow.rows[0]?.count || 0,
      heatmap: heatmap.rows,
      memory: memory.rows,
      report: report.rows[0] || null,
      stages: stages.rows,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/ai/coach', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    const { aiName, aiRole, aiSegment, persona, geminiModel } = state.config;
    const now = Date.now();
    const dayAgo = now - 86400000;
    const today = getBrazilDate();
    // Fetch REAL metrics to prevent hallucination
    const [memRows, metricsRow, msgRow, semRespostaRow] = await Promise.all([
      pool.query('SELECT category, content FROM ai_memory ORDER BY source_count DESC LIMIT 20'),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE updated_at > $1)::int as leads_hoje,
        COUNT(*) FILTER (WHERE stage='qualificado')::int as qualificados,
        COUNT(*) FILTER (WHERE stage='agendado')::int as agendados,
        COUNT(*) FILTER (WHERE stage='convertido')::int as convertidos,
        COUNT(*) FILTER (WHERE stage='humano')::int as humanos,
        COUNT(*) FILTER (WHERE stage='perdido')::int as perdidos,
        COUNT(*) FILTER (WHERE stage='atendimento')::int as em_atendimento,
        COUNT(*)::int as total FROM crm_leads`, [dayAgo]),
      pool.query('SELECT COUNT(*)::int as count FROM conversations WHERE last_user_at > $1', [dayAgo]),
      pool.query(`SELECT COUNT(*)::int as count FROM conversations WHERE last_ai_at IS NOT NULL AND last_ai_at > $1 AND (last_user_at IS NULL OR last_ai_at > last_user_at)`, [now - 172800000]),
    ]);
    const m = metricsRow.rows[0] || {};
    const memText = memRows.rows.map(r => `[${r.category}] ${r.content}`).join('\n') || 'Nenhuma ainda.';
    const metricsBlock = `\n\n═══ DADOS REAIS DE HOJE (${today}) — USE APENAS ESTES NÚMEROS ═══
• Mensagens recebidas: ${msgRow.rows[0]?.count || 0}
• Leads movimentados hoje: ${m.leads_hoje || 0}
• Total de leads no CRM: ${m.total || 0}
• Em atendimento: ${m.em_atendimento || 0}
• Qualificados: ${m.qualificados || 0}
• Agendados: ${m.agendados || 0}
• Convertidos: ${m.convertidos || 0}
• Atendimento humano: ${m.humanos || 0}
• Perdidos: ${m.perdidos || 0}
• Aguardando resposta do cliente: ${semRespostaRow.rows[0]?.count || 0}
═══════════════════════════════════════════
IMPORTANTE: Nunca invente ou estime dados. Se um número for 0, diga que é 0. Responda com base EXCLUSIVAMENTE nos dados acima.`;
    const coachPersona = `Você é ${aiName || 'a IA'}, assistente de atendimento com livre arbítrio e personalidade própria.
Está conversando com seu operador/dono. Seja direta, honesta e com personalidade.
Cargo: ${aiRole || 'assistente'}. Segmento: ${aiSegment || 'não definido'}.
Contexto: ${(persona || '').slice(0, 300)}

Memória acumulada:
${memText}

Quando receber instruções ("nunca faça", "sempre que", "presta atenção"), confirme e aplique.
Seja breve e autêntica.${metricsBlock}`;
    const rawResponse = await callGemini(message, coachPersona, geminiModel, history);
    const isInstruction = /presta.{0,10}aten|não dev|nunca |sempre que|lembra que|aprenda|corrij|evit/i.test(message);
    if (isInstruction) {
      await pool.query(
        'INSERT INTO ai_memory (id, category, content, confidence, source_count, created_at, updated_at) VALUES ($1,$2,$3,$4,10,$5,$5)',
        [uuidv4(), 'alerta', `[Instrução do operador]: ${message.slice(0, 300)}`, 'high', Date.now()]
      );
    }
    res.json({ ok: true, response: rawResponse, savedAsMemory: isInstruction });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── HUMAN PAUSE ENDPOINTS ──
app.get('/api/paused-contacts', (req, res) => {
  const now = Date.now();
  const ms = (state.config.pauseOnHumanTimeout || 30) * 60 * 1000;
  const contacts = [];
  for (const [phone, ts] of humanPaused.entries()) {
    const remaining = ms - (now - ts);
    if (remaining > 0) {
      const info = contactsMap.get(phone) || {};
      contacts.push({ phone, name: info.name || '', pausedAt: ts, resumesInMs: remaining });
    } else {
      humanPaused.delete(phone);
      pool.query('DELETE FROM human_paused WHERE phone=$1', [phone]).catch(() => {});
    }
  }
  res.json({ ok: true, contacts });
});

app.post('/api/conversations/:phone/resume', async (req, res) => {
  const { phone } = req.params;
  resumeContact(phone);
  await addLog('info', 'system', phone, 'IA retomada manualmente');
  res.json({ ok: true });
});

// ── RELAY ENDPOINTS ──
app.get('/api/evolution/instances', async (req, res) => {
  const r = await evoRequest('GET', '/instance/fetchInstances');
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Falha ao buscar instâncias' });
  const raw = Array.isArray(r.data) ? r.data : [];
  const instances = raw.map(i => ({
    name: i.name || i.instance?.instanceName,
    state: i.instance?.state || i.connectionStatus || 'unknown',
    number: i.instance?.number || null,
  }));
  res.json({ ok: true, instances });
});

app.get('/api/relay/config', (req, res) => {
  res.json({ ok: true, relay });
});

app.post('/api/relay/activate', async (req, res) => {
  const { instanceName, forwardUrl } = req.body;
  if (!instanceName) return res.status(400).json({ error: 'instanceName obrigatório' });

  // Fetch current webhook URL before overwriting (so we can restore + use as forwardUrl)
  const wh = await evoRequest('GET', `/webhook/find/${instanceName}`);
  const detectedUrl = wh.data?.webhook?.url || wh.data?.url || null;

  const r = await evoRequest('POST', `/webhook/set/${instanceName}`, {
    webhook: {
      enabled: true,
      url: `${APP_URL}/webhook`,
      byEvents: false,
      base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    }
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: 'Falha ao atualizar webhook na Evolution', detail: r.data });

  relay.enabled = true;
  relay.instanceName = instanceName;
  relay.forwardUrl = forwardUrl || detectedUrl || null;
  await saveRelayConfig();
  await addLog('info', 'system', null, `Modo Espelho ativado: ${instanceName}. Encaminhar para: ${relay.forwardUrl || 'não configurado'}`);
  res.json({ ok: true, relay, detectedUrl });
});

app.post('/api/relay/deactivate', async (req, res) => {
  if (relay.enabled && relay.instanceName && relay.forwardUrl) {
    await evoRequest('POST', `/webhook/set/${relay.instanceName}`, {
      webhook: {
        enabled: true,
        url: relay.forwardUrl,
        byEvents: false,
        base64: true,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
      }
    });
  }
  const prev = relay.instanceName;
  relay.enabled = false;
  relay.instanceName = null;
  relay.forwardUrl = null;
  await saveRelayConfig();
  await addLog('info', 'system', null, `Modo Espelho desativado (era: ${prev})`);
  res.json({ ok: true });
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
  await loadRelayConfig();
  console.log('✅ Config, stats e relay carregados do banco');

  // Restore humanPaused from DB
  try {
    const { rows: paused } = await pool.query('SELECT phone, paused_at FROM human_paused');
    const ms = (state.config.pauseOnHumanTimeout || 30) * 60 * 1000;
    for (const r of paused) {
      if (Date.now() - Number(r.paused_at) < ms) {
        humanPaused.set(r.phone, Number(r.paused_at));
      } else {
        await pool.query('DELETE FROM human_paused WHERE phone=$1', [r.phone]);
      }
    }
    console.log(`✅ ${humanPaused.size} pausas restauradas do banco`);
  } catch (e) { console.log('[humanPaused restore]', e.message); }

  // Restore in-memory contactsMap from crm_leads (persists across redeploys)
  try {
    const { rows: savedContacts } = await pool.query('SELECT phone, name, raw_jid, profile_pic FROM crm_leads');
    savedContacts.forEach(r => {
      contactsMap.set(r.phone, { name: r.name || '', rawJid: r.raw_jid || '', profilePic: r.profile_pic || null, firstSeen: Date.now(), lastSeen: Date.now() });
    });
    console.log(`✅ ${savedContacts.length} contatos restaurados do CRM`);
  } catch (e) { console.log('[contactsMap restore]', e.message); }

  // Follow-up cron: check every minute
  setInterval(async () => {
    try {
      const now = Date.now();
      // 1. Scheduled follow-ups (appointment reminders)
      const { rows } = await pool.query('SELECT * FROM crm_followups WHERE sent=false AND scheduled_at <= $1', [now]);
      for (const f of rows) {
        const contact = contactsMap.get(f.phone);
        const sendTarget = contact?.rawJid?.includes('@lid') ? contact.rawJid : null;
        await sendText(sendTarget || f.phone, f.message);
        await pool.query('UPDATE crm_followups SET sent=true WHERE id=$1', [f.id]);
        await addLog('info', 'system', f.phone, `Follow-up disparado: ${f.message.slice(0,60)}`).catch(()=>{});
      }
      // 2. Noreply follow-ups (no client response after AI message)
      if (state.config.noreplyFollowupEnabled && state.config.noreplyFollowupSteps?.length) {
        const { rows: convs } = await pool.query(
          'SELECT phone, last_ai_at, last_user_at FROM conversations WHERE last_ai_at IS NOT NULL'
        );
        for (const conv of convs) {
          const lastAiAt = Number(conv.last_ai_at);
          const lastUserAt = Number(conv.last_user_at) || 0;
          if (lastAiAt <= lastUserAt) continue; // client already replied
          const contact = contactsMap.get(conv.phone);
          for (let si = 0; si < state.config.noreplyFollowupSteps.length; si++) {
            const step = state.config.noreplyFollowupSteps[si];
            const threshold = (step.delayHours || 1) * 3600000;
            if (now - lastAiAt < threshold) continue;
            const { rows: already } = await pool.query(
              'SELECT id FROM crm_followups WHERE phone=$1 AND type=$2 AND created_at > $3',
              [conv.phone, `noreply_${si}`, lastAiAt]
            );
            if (already.length) continue;
            // Generate message via Gemini based on conversation summary + instruction
            let msg = '';
            try {
              const crmRow = await pool.query('SELECT summary FROM crm_leads WHERE phone=$1', [conv.phone]);
              const summary = crmRow.rows[0]?.summary || '';
              const instruction = step.instruction || 'Seja gentil e pergunte se ainda tem interesse.';
              const clientName = contact?.name || '';
              const persona = state.config.persona || '';
              const prompt = `Você é um assistente de atendimento. Com base no resumo da conversa abaixo, escreva uma mensagem curta de reengajamento para o cliente que não respondeu.

Resumo da conversa: ${summary || 'Sem resumo disponível.'}
Nome do cliente: ${clientName || 'Cliente'}
Instrução: ${instruction}
Persona: ${persona.slice(0, 300)}

Escreva APENAS a mensagem final para o WhatsApp. Sem explicações. Use linguagem natural, no estilo WhatsApp. Não use ** para negrito.`;
              const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }
              );
              if (r.ok) {
                const d = await r.json();
                msg = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                msg = msg.replace(/\*\*(.+?)\*\*/gs, '*$1*');
              }
            } catch (e) { console.log('[NOREPLY GEN]', e.message); }
            if (!msg) continue; // skip if AI failed to generate
            const dest = contact?.rawJid?.includes('@lid') ? contact.rawJid : conv.phone;
            await sendText(dest, msg);
            await pool.query(
              'INSERT INTO crm_followups (id, phone, scheduled_at, message, type, sent, created_at) VALUES ($1,$2,$3,$4,$5,true,$6)',
              [uuidv4(), conv.phone, now, msg, `noreply_${si}`, now]
            );
            await addLog('info', 'system', conv.phone, `Noreply follow-up #${si+1}: ${msg.slice(0,60)}`).catch(()=>{});
          }
        }
      }
    } catch (err) { console.log(`[FOLLOWUP CRON] ${err.message}`); }
  }, 60000);

  // Daily report cron: runs every 2 hours, generates if not generated today
  setInterval(async () => {
    try {
      const today = getBrazilDate();
      const { rows } = await pool.query('SELECT report_date FROM ai_reports WHERE report_date=$1', [today]);
      if (!rows.length) await generateDailyReport();
    } catch (e) { console.log('[REPORT CRON]', e.message); }
  }, 7200000);

  const existing = await getInstanceStatus().catch(() => null);
  if (existing) {
    state._connectionState = existing.instance?.state || existing.connectionStatus || 'unknown';
    console.log(`📱 Instância "${INSTANCE_NAME}" — status: ${state._connectionState}`);
  } else {
    console.log(`⚠️  Instância "${INSTANCE_NAME}" não encontrada. Crie no dashboard.`);
  }
});
