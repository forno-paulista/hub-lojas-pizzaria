// Checagem rápida da lógica do painel: node teste-insights.js
const assert = require('assert');
const { dataDe, linhas, montar, esc } = require('./api/insights.js').teste;

assert.equal(dataDe('30/09/2026 14:05:10').toISOString(), '2026-09-30T14:05:00.000Z');
assert.equal(dataDe(46295.5).toISOString(), '2026-09-30T12:00:00.000Z');
assert.equal(dataDe('lixo'), null);

const desde = new Date('2026-09-01');
const env = linhas([['nome', 'email', 'data_envio', 'status', 'campanha'],
  ['Ana', 'a@x', '30/09/2026 10:00', 'enviado', 'promo_a'],
  ['Bia', 'b@x', '30/09/2026 10:01', 'erro', 'promo_a'],
  ['Caio', 'c@x', '01/08/2026 10:00', 'enviado', 'promo_a']], desde);
assert.equal(env.length, 2); // a de agosto fica fora do período

const r = montar({
  enviados: env,
  aberturas: [{ campanha: 'promo_a' }],
  cliques: [{ campanha: 'promo_a', loja: 'fornopaulistasul' }],
  eventos: [{ dimensionValues: [{ value: 'promo_a' }, { value: 'purchase' }], metricValues: [{ value: '2' }] }],
  sessoes: [{ dimensionValues: [{ value: 'promo_a' }], metricValues: [{ value: '5' }, { value: '99.8' }] }],
});
const [nome, x] = r[0];
assert.deepEqual([nome, x.enviados, x.aberturas, x.cliques, x.purchase, x.sessoes, x.receita, x.lojas.fornopaulistasul],
  ['promo_a', 1, 1, 1, 2, 5, 99.8, 1]);
assert.ok(!JSON.stringify(r).includes('a@x')); // e-mails nunca chegam ao painel
assert.equal(esc('<script>'), '&#60;script&#62;');
console.log('ok');
