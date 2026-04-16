const express = require('express');
const path    = require('path');
const QRCode  = require('qrcode');
const pino    = require('pino');
const fs      = require('fs');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Estado global ─────────────────────────────────────────────────────────
let qrDataURL   = null;   // imagem base64 do QR Code
let status      = 'desconectado'; // desconectado | gerando_qr | aguardando_scan | conectado
let sock        = null;
let messages    = [];
let autoRules   = [];
let reconnecting = false;

const AUTH = path.join(__dirname, 'sessao');

function limparSessao() {
  try { if (fs.existsSync(AUTH)) fs.rmSync(AUTH, { recursive:true, force:true }); } catch(_){}
}

// ── Inicia WhatsApp ────────────────────────────────────────────────────────
async function iniciar(limpar = false) {
  if (limpar) limparSessao();
  if (sock) { try { sock.ev.removeAllListeners(); sock.end(); } catch(_){} sock = null; }

  status    = 'gerando_qr';
  qrDataURL = null;
  reconnecting = false;

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);

    sock = makeWASocket({
      version,
      auth:  state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,        // mostra no terminal também
      browser: ['WA Automação', 'Chrome', '3.0'],
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (upd) => {
      const { connection, lastDisconnect, qr } = upd;

      // ── QR Code chegou ──
      if (qr) {
        try {
          // QR grande e de boa qualidade
          qrDataURL = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            width: 400,
            margin: 2,
            color: { dark: '#000', light: '#fff' },
          });
          status = 'aguardando_scan';
          console.log('\n📷 QR Code gerado! Escaneie pelo WhatsApp.\n');
        } catch(e) { console.error(e.message); }
      }

      // ── Conectado ──
      if (connection === 'open') {
        status    = 'conectado';
        qrDataURL = null;
        console.log('\n✅ WhatsApp conectado com sucesso!\n');
      }

      // ── Desconectado ──
      if (connection === 'close') {
        const code      = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log(`🔴 Desconectado. Código: ${code}`);
        qrDataURL = null;
        sock      = null;

        if (loggedOut) {
          status = 'desconectado';
          limparSessao();
          console.log('Sessão encerrada. Acesse /conectar para reconectar.');
        } else if (!reconnecting) {
          reconnecting = true;
          status = 'gerando_qr';
          console.log('Reconectando em 4s...');
          setTimeout(() => iniciar(false), 4000);
        }
      }
    });

    // Mensagens recebidas
    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type !== 'notify') return;
      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text || '';
        if (!text) continue;
        const jid    = msg.key.remoteJid;
        const number = jid.replace('@s.whatsapp.net', '');
        const name   = msg.pushName || number;
        const entry  = {
          id:      Date.now() + Math.random(),
          number, name, text,
          time:    new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }),
          in:      true,
          auto:    false,
        };
        messages.unshift(entry);
        if (messages.length > 200) messages.length = 200;
        console.log(`📩 ${name}: ${text}`);

        // Auto-resposta
        for (const r of autoRules) {
          if (!r.ativo) continue;
          if (text.toLowerCase().includes(r.palavra.toLowerCase())) {
            setTimeout(async () => {
              try { await sock.sendMessage(jid, { text: r.resposta }); } catch(_){}
            }, 2000);
            break;
          }
        }
      }
    });

  } catch(e) {
    console.error('Erro ao iniciar:', e.message);
    status = 'desconectado';
  }
}

// ── API ────────────────────────────────────────────────────────────────────

// Status atual
app.get('/status', (_, res) => res.json({ status, conectado: status === 'conectado' }));

// Dados do QR (polling)
app.get('/qr', (_, res) => res.json({ qr: qrDataURL, status }));

// Iniciar nova conexão
app.post('/conectar', (_, res) => {
  if (status === 'conectado') return res.json({ ok: true, msg: 'Já conectado' });
  iniciar(false);
  res.json({ ok: true });
});

// Reconectar do zero (limpa sessão)
app.post('/reconectar', (_, res) => {
  iniciar(true);
  res.json({ ok: true });
});

// Desconectar
app.post('/desconectar', async (_, res) => {
  try { if (sock) { await sock.logout(); sock = null; } } catch(_){}
  limparSessao();
  status    = 'desconectado';
  qrDataURL = null;
  res.json({ ok: true });
});

// Enviar mensagem
app.post('/enviar', async (req, res) => {
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ erro: 'numero e texto obrigatórios' });
  if (!sock || status !== 'conectado') return res.status(400).json({ erro: 'WhatsApp não conectado' });
  try {
    const jid = numero.replace(/\D/g,'') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: texto });
    messages.unshift({ id:Date.now(), number:numero.replace(/\D/g,''), name:numero, text:texto, time:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}), in:false, auto:false });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Mensagens recebidas
app.get('/mensagens', (_, res) => res.json(messages));

// Regras do bot
app.get('/regras',    (_, res) => res.json(autoRules));
app.post('/regras',   (req, res) => { const r={id:Date.now(),...req.body,ativo:true}; autoRules.push(r); res.json(r); });
app.delete('/regras/:id', (req, res) => { autoRules=autoRules.filter(r=>r.id!==+req.params.id); res.json({ok:true}); });

app.get('/health', (_, res) => res.json({ ok:true, status }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Iniciar servidor ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 WA Simples rodando em http://localhost:${PORT}\n`);
  // Inicia automaticamente ao ligar o servidor
  iniciar(false);
});
