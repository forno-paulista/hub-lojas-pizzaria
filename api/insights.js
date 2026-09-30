// Painel /insights: pede senha, lê a planilha (envios, aberturas, cliques) e o GA4 (conversões) e devolve a página pronta.
// Variáveis na Vercel: INSIGHTS_USER, INSIGHTS_PASS, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, SHEET_ID, GA4_PROPERTY_ID.
const crypto = require('crypto');
const { lojas } = require('../lojas.js');

const env = process.env;
const PERIODOS = [7, 30, 90];
const EVENTOS = ['add_to_cart', 'begin_checkout', 'purchase'];
const nomeLoja = Object.fromEntries(lojas.map(l => [l.slug, l.nome]));

// ponytail: usuário e senha únicos; trocar por login Google quando existir a tela de campanhas.
function autorizado(req) {
  if (!env.INSIGHTS_USER || !env.INSIGHTS_PASS) return false;
  const [tipo, b64] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !b64) return false;
  const recebido = Buffer.from(b64, 'base64');
  const esperado = Buffer.from(`${env.INSIGHTS_USER}:${env.INSIGHTS_PASS}`);
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

// Token da conta de serviço (JWT assinado com a chave privada), sem bibliotecas.
async function tokenGoogle() {
  const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const agora = Math.floor(Date.now() / 1000);
  const corpo = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: env.GOOGLE_SA_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/analytics.readonly',
    iat: agora,
    exp: agora + 3600,
  })}`;
  const assinatura = crypto.sign('RSA-SHA256', Buffer.from(corpo), env.GOOGLE_SA_KEY.replace(/\\n/g, '\n')).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corpo}.${assinatura}` }),
  });
  if (!r.ok) throw new Error(`Google token: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function googleJson(url, token, body) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url.split('?')[0]}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Data da planilha: número de série (célula de data) ou texto "dd/MM/yyyy HH:mm[:ss]".
function dataDe(v) {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(String(v || ''));
  return m ? new Date(Date.UTC(m[3], m[2] - 1, m[1], m[4] || 0, m[5] || 0)) : null;
}

// Linhas da aba -> objetos pelo cabeçalho, só dentro do período.
function linhas(valores = [], desde) {
  const [cab = [], ...resto] = valores;
  return resto
    .map(l => Object.fromEntries(cab.map((c, i) => [String(c).trim(), l[i]])))
    .filter(o => { const d = dataDe(o.data_hora ?? o.data_envio); return d && d >= desde; });
}

// Junta planilha e GA4 em uma linha por campanha. Só contagens: nome e e-mail nunca saem daqui.
function montar({ enviados, aberturas, cliques, eventos, sessoes }) {
  const c = {};
  const de = nome => (c[nome || '(sem campanha)'] ??= { enviados: 0, aberturas: 0, cliques: 0, sessoes: 0, receita: 0, lojas: {}, ...Object.fromEntries(EVENTOS.map(e => [e, 0])) });
  for (const l of enviados) if (String(l.status).toLowerCase() === 'enviado') de(l.campanha).enviados++;
  for (const l of aberturas) de(l.campanha).aberturas++;
  for (const l of cliques) { const x = de(l.campanha); x.cliques++; x.lojas[l.loja] = (x.lojas[l.loja] || 0) + 1; }
  for (const r of eventos) de(r.dimensionValues[0].value)[r.dimensionValues[1].value] += Number(r.metricValues[0].value);
  for (const r of sessoes) { const x = de(r.dimensionValues[0].value); x.sessoes += Number(r.metricValues[0].value); x.receita += Number(r.metricValues[1].value); }
  return Object.entries(c).sort((a, b) => b[1].enviados - a[1].enviados || b[1].sessoes - a[1].sessoes);
}

const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const num = n => n.toLocaleString('pt-BR');
const pct = (a, b) => (b ? `${((a / b) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '–');
const brl = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function pagina(campanhas, dias) {
  const linhasTabela = campanhas.map(([nome, x]) => `
    <tr><th scope="row">${esc(nome)}</th><td>${num(x.enviados)}</td><td>${num(x.aberturas)} <small>${pct(x.aberturas, x.enviados)}</small></td>
    <td>${num(x.cliques)} <small>${pct(x.cliques, x.enviados)}</small></td><td>${num(x.sessoes)}</td>
    ${EVENTOS.map(e => `<td>${num(x[e])}</td>`).join('')}<td>${brl(x.receita)}</td></tr>`).join('');
  const porLoja = campanhas.filter(([, x]) => x.cliques).map(([nome, x]) => `
    <h3>${esc(nome)}</h3><ul>${Object.entries(x.lojas).sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<li>${esc(nomeLoja[s] || s || '(sem loja)')}: <b>${num(n)}</b></li>`).join('')}</ul>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Insights · Forno Paulista</title><style>
  body { margin: 0; font-family: Arial, sans-serif; background: #F4F4F5; color: #1D1D1F; }
  header { background: #86201B; color: #fff; padding: 16px; } header h1 { margin: 0; font-size: 1.25rem; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  nav a { display: inline-block; padding: 8px 16px; margin: 0 8px 8px 0; border-radius: 999px; background: #fff; color: #86201B; text-decoration: none; font-weight: bold; }
  nav a[aria-current] { background: #86201B; color: #fff; }
  .tabela { overflow-x: auto; background: #fff; border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid #E4E4E7; white-space: nowrap; }
  th[scope=row], thead th:first-child { text-align: left; } thead th { color: #6B6B70; font-weight: normal; }
  small { color: #6B6B70; } h2 { font-size: 1.1rem; margin: 28px 0 8px; } h3 { font-size: .95rem; margin: 16px 0 4px; }
  ul { margin: 0; padding-left: 20px; } p.nota { color: #6B6B70; font-size: .8rem; }
</style></head><body>
<header><h1>Insights das campanhas de e-mail</h1></header>
<main>
  <nav>${PERIODOS.map(d => `<a href="?dias=${d}"${d === dias ? ' aria-current="page"' : ''}>${d} dias</a>`).join('')}</nav>
  <div class="tabela"><table>
    <thead><tr><th>Campanha</th><th>Enviados</th><th>Aberturas</th><th>Cliques</th><th>Sessões</th><th>add_to_cart</th><th>begin_checkout</th><th>purchase</th><th>Receita</th></tr></thead>
    <tbody>${linhasTabela || '<tr><td colspan="9">Sem dados no período.</td></tr>'}</tbody>
  </table></div>
  <h2>Cliques por loja</h2>${porLoja || '<p>Sem cliques no período.</p>'}
  <p class="nota">Aberturas são aproximadas. Sessões e conversões vêm do GA4 (sessões com utm_medium=email; o dia de hoje pode estar incompleto). % de aberturas e cliques sobre enviados.</p>
</main></body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!autorizado(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="insights", charset="UTF-8"');
    return res.status(401).send('Acesso restrito.');
  }
  try {
    const dias = PERIODOS.includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
    const desde = new Date(Date.now() - dias * 864e5);
    const token = await tokenGoogle();
    const ga = body => googleJson(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}:runReport`, token, {
      dateRanges: [{ startDate: `${dias - 1}daysAgo`, endDate: 'today' }], limit: 1000, ...body,
    });
    const email = { filter: { fieldName: 'sessionMedium', stringFilter: { value: 'email' } } };
    const abas = ['Enviados', 'Aberturas', 'Cliques'].map(a => `ranges=${encodeURIComponent(`${a}!A:Z`)}`).join('&');
    const [planilha, eventos, sessoes] = await Promise.all([
      googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet?${abas}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, token),
      ga({
        dimensions: [{ name: 'sessionCampaignName' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }],
        dimensionFilter: { andGroup: { expressions: [email, { filter: { fieldName: 'eventName', inListFilter: { values: EVENTOS } } }] } },
      }),
      ga({ dimensions: [{ name: 'sessionCampaignName' }], metrics: [{ name: 'sessions' }, { name: 'purchaseRevenue' }], dimensionFilter: email }),
    ]);
    const [enviados, aberturas, cliques] = planilha.valueRanges.map(v => linhas(v.values, desde));
    const campanhas = montar({ enviados, aberturas, cliques, eventos: eventos.rows || [], sessoes: sessoes.rows || [] });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(pagina(campanhas, dias));
  } catch (e) {
    res.status(500).send(`Erro ao montar o painel: ${esc(e.message)}`);
  }
};

module.exports.teste = { dataDe, linhas, montar, esc };
