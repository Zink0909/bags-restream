const WebSocket = require('ws');

const BAGS_API_KEY = process.env.BAGS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BAGS_ALPHA_URL = process.env.BAGS_ALPHA_URL || 'https://bags-alpha-pied.vercel.app';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const SEEN_MINTS = new Set();

function extractMint(strings) {
  for (const s of strings) {
    const matches = s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (matches) {
      for (const m of matches) {
        if (m.length >= 32 && m.length <= 44 && !m.includes('http')) {
          return m;
        }
      }
    }
  }
  return null;
}

function extractStrings(buf) {
  const semiIdx = buf.indexOf(';');
  if (semiIdx === -1) return [];
  const payload = buf.slice(semiIdx + 1);
  const strings = [];
  let i = 0;
  while (i < payload.length) {
    if (payload[i] >= 32 && payload[i] < 127) {
      let s = '';
      while (i < payload.length && payload[i] >= 32 && payload[i] < 127) {
        s += String.fromCharCode(payload[i]);
        i++;
      }
      if (s.length > 10) strings.push(s);
    } else {
      i++;
    }
  }
  return strings;
}

async function analyzeToken(mint) {
  try {
    const res = await fetch(`${BAGS_ALPHA_URL}/api/analyze-single?mint=${mint}`);
    const data = await res.json();
    return data.success ? data : null;
  } catch (e) {
    console.error('analyze error:', e.message);
    return null;
  }
}

async function saveToSupabase(mint, data) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/token_snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        mint,
        symbol: data.symbol || '',
        name: data.name || '',
        tag: data.tag,
        potential_score: data.potentialScore,
        attention_score: data.attentionScore,
        conversion_score: data.conversionScore,
        momentum_score: data.momentumScore,
        risk_score: data.riskScore,
        lifetime_fees_sol: data.lifetimeFeesSol,
        captured_at: new Date().toISOString(),
      }),
    });
    console.log('Saved to Supabase:', mint);
  } catch (e) {
    console.error('Supabase error:', e.message);
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

function connect() {
  console.log('Connecting to ReStream...');
  const ws = new WebSocket('wss://restream.bags.fm');

  ws.on('open', () => {
    console.log('Connected!');
    ws.send(JSON.stringify({ type: 'subscribe', event: 'launchpad_launch:BAGS' }));
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  });

  ws.on('message', async (d) => {
    if (!Buffer.isBuffer(d)) return;

    const strings = extractStrings(d);
    const mint = extractMint(strings);
    if (!mint) return;
    if (SEEN_MINTS.has(mint)) return;
    SEEN_MINTS.add(mint);

    console.log('New token launch:', mint);

    // Wait 3 seconds for the token to be indexed
    await new Promise(r => setTimeout(r, 3000));

    const data = await analyzeToken(mint);
    if (!data) return;

    console.log(`Analyzed: ${mint} -> ${data.tag} (${data.potentialScore})`);

    // Save to Supabase
    await saveToSupabase(mint, data);

    // Alert if Breakout
    if (data.tag === 'Breakout' && data.potentialScore >= 60) {
      const msg = [
        `⚡ <b>New Breakout Launch</b> — ${data.symbol || mint.slice(0, 8)}`,
        ``,
        `Signal Score: <b>${data.potentialScore}</b>`,
        `  Attention: ${data.attentionScore}`,
        `  Conversion: ${data.conversionScore}`,
        `  Momentum: ${data.momentumScore}`,
        ``,
        `<a href="https://bags-alpha-pied.vercel.app/token/${mint}">View on Bags Alpha</a>`,
        `<a href="https://bags.fm/${mint}">Trade on Bags.fm</a>`,
      ].join('\n');
      await sendTelegram(msg);
      console.log('Alert sent for:', mint);
    }
  });

  ws.on('error', (e) => console.error('WS error:', e.message));

  ws.on('close', (code, reason) => {
    console.log(`Disconnected: ${code} ${reason}. Reconnecting in 5s...`);
    setTimeout(connect, 5000);
  });
}

connect();
