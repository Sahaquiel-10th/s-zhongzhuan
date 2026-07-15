const state = { me: null, customer: null, admin: null, view: 'overview' };

const customerNav = [
  ['overview', '总览', '⌂'], ['models', '可用模型', '◇'], ['keys', 'API Key', '⌁'],
  ['docs', '接入说明', '⌘'], ['usage', '计量日志', '▥'], ['billing', '充值与账本', '¥'],
];
const adminNav = [
  ['overview', '运营总览', '⌂'], ['tenants', '客户管理', '◎'], ['routes', '模型配置', '◇'],
  ['pricing', '折扣设置', '％'], ['orders', '充值审核', '¥'],
];

const $ = (selector) => document.querySelector(selector);
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const formatMoney = (value) => `¥${Number(value || 0).toFixed(2)}`;
const formatMicros = (value, digits = 2) => `¥${(Number(value || 0) / 1_000_000).toFixed(digits)}`;
const formatDiscount = (value) => `${(Number(value || 0) * 10).toFixed(1)} 折`;
const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.error || '请求失败');
  return payload;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function statusTag(active, on = '启用', off = '停用') {
  return `<span class="tag ${active ? 'success' : 'muted'}">${active ? on : off}</span>`;
}

function emptyState(title, text) {
  return `<div class="empty"><strong>${title}</strong><span>${text}</span></div>`;
}

function metric(label, value, note, tone = '') {
  return `<article class="metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function setPageMeta(kicker, title, actions = '') {
  $('#pageKicker').textContent = kicker;
  $('#pageTitle').textContent = title;
  $('#topActions').innerHTML = actions;
}

function renderNav() {
  const admin = state.me.user.role === 'admin';
  const nav = admin ? adminNav : customerNav;
  $('#roleLabel').textContent = admin ? '管理员后台' : '客户控制台';
  $('#navList').innerHTML = nav.map(([id, label, icon]) => `
    <button class="nav-item ${state.view === id ? 'active' : ''}" data-view="${id}" type="button"><i>${icon}</i><span>${label}</span></button>
  `).join('');
}

async function refreshData() {
  if (state.me.user.role === 'admin') state.admin = await api('/api/admin/dashboard');
  else state.customer = await api('/api/customer/dashboard');
}

async function showView(view) {
  state.view = view;
  renderNav();
  const admin = state.me.user.role === 'admin';
  const renderer = admin ? adminViews[view] : customerViews[view];
  if (!renderer) return showView('overview');
  renderer();
}

const customerViews = {
  overview() {
    const data = state.customer;
    const success = data.usage.filter((item) => item.status === 'success');
    const used = success.reduce((sum, item) => sum + Number(item.charged_cost_micros), 0);
    setPageMeta('DASHBOARD', '总览', '<button class="button secondary" data-view="docs">查看接入说明</button>');
    $('#pageContent').innerHTML = `
      <div class="metrics-grid">
        ${metric('账户余额', formatMicros(data.tenant.balance_micros), '人民币余额', Number(data.tenant.balance_micros) > 0 ? 'green' : 'amber')}
        ${metric('可用模型', data.models.filter((m) => m.active).length, '由管理员为当前账号开通')}
        ${metric('当前折扣', formatDiscount(data.customerDiscount), '按模型官网 Token 价格')}
        ${metric('累计消耗', formatMicros(used, 4), '最近 100 条调用记录')}
      </div>
      <div class="content-grid">
        <section class="panel span-2"><div class="panel-head"><div><h2>快速接入</h2><p>兼容 OpenAI 协议，只需替换地址和 Key。</p></div></div>
          <div class="config-list"><div><span>Base URL</span><code>${escapeHtml(data.publicBaseUrl)}/v1</code></div><div><span>认证方式</span><code>Authorization: Bearer sk-...</code></div><div><span>模型发现</span><code>GET /v1/models</code></div></div>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>账户状态</h2><p>余额检查在网关调用前执行。</p></div>${statusTag(Number(data.tenant.balance_micros) > Number(data.tenant.reserved_micros), '可调用', '需充值')}</div>
          <div class="balance-bar"><span style="width:${Math.min(100, Math.max(4, Number(data.tenant.balance_micros) / 500000))}%"></span></div>
          <p class="panel-note">处理中预留 ${formatMicros(data.tenant.reserved_micros, 4)}；请求完成后按供应商返回的实际 Token 用量结算。</p>
        </section>
      </div>`;
  },
  models() {
    setPageMeta('MODEL CATALOG', '可用模型');
    const rows = state.customer.models;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>已开通模型</h2><p>调用时使用下方模型 ID；新增模型请联系管理员开通。</p></div></div>
      <div class="model-grid">${rows.length ? rows.map((m) => `<article class="model-item"><span class="model-icon">AI</span><div><strong>${escapeHtml(m.display_name)}</strong><code>${escapeHtml(m.public_model_id)}</code><small>输入 ${formatMoney(m.official_input_cny_per_million)} · 缓存 ${formatMoney(m.official_cached_input_cny_per_million)} · 输出 ${formatMoney(m.official_output_cny_per_million)} / 1M Token</small></div>${statusTag(m.active)}</article>`).join('') : emptyState('暂未开通模型', '管理员配置后会显示在这里')}</div></section>`;
  },
  keys() {
    setPageMeta('CREDENTIALS', 'API Key', '<button class="button primary" data-action="new-key">生成 Key</button>');
    const rows = state.customer.keys;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>访问密钥</h2><p>完整密钥只在创建时显示一次，请按项目分别创建。</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>名称</th><th>Key</th><th>状态</th><th>最近使用</th><th>创建时间</th><th></th></tr></thead><tbody>${rows.map((k) => `<tr><td><strong>${escapeHtml(k.name)}</strong></td><td><code>${escapeHtml(k.key_prefix)}</code></td><td>${statusTag(k.active)}</td><td>${formatDate(k.last_used_at)}</td><td>${formatDate(k.created_at)}</td><td><button class="button text" data-action="toggle-key" data-id="${k.id}" data-active="${!k.active}">${k.active ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('还没有 API Key', '生成一个 Key 后即可开始调用')}</div></section>`;
  },
  docs() {
    const base = `${state.customer.publicBaseUrl}/v1`;
    setPageMeta('DOCUMENTATION', '接入说明');
    $('#pageContent').innerHTML = `<section class="panel docs"><div class="panel-head"><div><h2>OpenAI 兼容接入</h2><p>先调用模型列表确认当前账号已开通的模型 ID。</p></div></div>
      <div class="step"><b>01</b><div><h3>设置 Base URL</h3><code>${escapeHtml(base)}</code></div></div>
      <div class="step"><b>02</b><div><h3>查询模型</h3><pre>curl ${escapeHtml(base)}/models \\\n  -H "Authorization: Bearer sk-your-key"</pre></div></div>
      <div class="step"><b>03</b><div><h3>发送请求</h3><pre>curl ${escapeHtml(base)}/chat/completions \\\n  -H "Authorization: Bearer sk-your-key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"your-model-id","messages":[{"role":"user","content":"你好"}]}'</pre></div></div>
      <div class="error-grid"><div><strong>401</strong><span>Key 无效或已停用</span></div><div><strong>402</strong><span>账户余额不足</span></div><div><strong>404</strong><span>模型未开通</span></div><div><strong>502</strong><span>模型服务暂不可用</span></div></div>
      <div class="sdk-grid">
        <article><h3>Node.js SDK</h3><pre>import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SUPER_RELAY_API_KEY,
  baseURL: "${escapeHtml(base)}"
});</pre></article>
        <article><h3>Anthropic 兼容接口</h3><pre>curl ${escapeHtml(base)}/messages \\\n  -H "x-api-key: sk-your-key" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json"</pre></article>
      </div>
    </section>`;
  },
  usage() {
    setPageMeta('USAGE', '计量日志');
    const rows = state.customer.usage;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>最近调用</h2><p>计量直接采用供应商响应中的 Token 用量，不保存对话内容。</p></div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>输入 Token</th><th>缓存 Token</th><th>输出 Token</th><th>官网金额</th><th>折扣</th><th>实扣</th><th>结果</th></tr></thead><tbody>${rows.map((u) => `<tr><td>${formatDate(u.created_at)}</td><td><code>${escapeHtml(u.model_id)}</code></td><td>${formatNumber(u.input_tokens)}</td><td>${formatNumber(u.cached_input_tokens)}</td><td>${formatNumber(u.output_tokens)}</td><td>${formatMicros(u.official_cost_micros, 6)}</td><td><span class="tag success">${formatDiscount(u.customer_discount)}</span></td><td><strong>${formatMicros(u.charged_cost_micros, 6)}</strong></td><td><span class="tag ${u.status === 'success' ? 'success' : u.status === 'blocked' ? 'warning' : 'danger'}">${{ success: '成功', blocked: '已拦截', failed: '失败' }[u.status]}</span></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('暂无调用记录', '完成首次模型调用后会显示在这里')}</div></section>`;
  },
  billing() {
    setPageMeta('BILLING', '充值与账本');
    const data = state.customer;
    $('#pageContent').innerHTML = `<div class="content-grid"><section class="panel span-2"><div class="panel-head"><div><h2>充值余额</h2><p>充值金额按人民币 1:1 入账，提交后由管理员确认。</p></div><strong class="balance-total">${formatMicros(data.tenant.balance_micros)} <small>余额</small></strong></div><div class="plan-grid">${[50, 100, 500, 1000].map((amount) => `<button class="plan" data-action="recharge" data-amount="${amount}"><strong>¥${amount}</strong><span>到账 ¥${amount.toFixed(2)}</span></button>`).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>充值订单</h2><p>等待管理员确认后自动入账。</p></div></div><div class="ledger">${data.orders.map((o) => `<div class="ledger-row"><div><strong>${formatMoney(o.amount_cny)}</strong><span>${formatDate(o.created_at)}</span></div><span class="tag ${o.status === 'paid' ? 'success' : 'warning'}">${o.status === 'paid' ? '已入账' : '待确认'}</span></div>`).join('') || emptyState('暂无充值订单', '选择左侧金额提交充值')}</div></section>
      <section class="panel span-3"><div class="panel-head"><div><h2>账本流水</h2><p>每一笔充值和模型调用均可追溯。</p></div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>项目</th><th>类型</th><th>变动前</th><th>余额变动</th><th>变动后</th></tr></thead><tbody>${data.ledger.map((l) => `<tr><td>${formatDate(l.created_at)}</td><td>${escapeHtml(l.title)}</td><td>${escapeHtml(l.type)}</td><td>${formatMicros(l.balance_before_micros, 6)}</td><td class="${Number(l.amount_micros) > 0 ? 'positive' : 'negative'}">${Number(l.amount_micros) > 0 ? '+' : ''}${formatMicros(l.amount_micros, 6)}</td><td>${formatMicros(l.balance_after_micros, 6)}</td></tr>`).join('')}</tbody></table>${data.ledger.length ? '' : emptyState('暂无账本流水', '充值或调用后会显示在这里')}</div></section></div>`;
  },
};

const adminViews = {
  overview() {
    const data = state.admin;
    const balance = data.tenants.reduce((sum, t) => sum + Number(t.balance_micros), 0);
    setPageMeta('OPERATIONS', '运营总览', '<button class="button primary" data-action="new-tenant">新增客户</button>');
    $('#pageContent').innerHTML = `<div class="metrics-grid">${metric('客户账户', data.tenants.length, '多租户独立账本')}${metric('已配置模型', data.routes.filter((r) => r.active).length, '按客户授权')}${metric('待审核充值', data.orders.length, '需要确认入账', data.orders.length ? 'amber' : '')}${metric('客户总余额', formatMicros(balance), '不含处理中预留')}</div>
      <div class="content-grid"><section class="panel span-2"><div class="panel-head"><div><h2>开通流程</h2><p>客户、供应商凭证和模型授权各自独立。</p></div></div><div class="ops-list"><div><b>1</b><span><strong>创建客户账户</strong><small>生成独立租户和客户登录账号</small></span></div><div><b>2</b><span><strong>录入供应商凭证</strong><small>每个客户单独一把供应商 Key，加密保存</small></span></div><div><b>3</b><span><strong>上架客户模型</strong><small>设置客户看到的模型 ID 和供应商真实模型 ID</small></span></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>当前计费</h2><p>各模型官网 Token 单价乘统一折扣。</p></div><span class="tag success">${formatDiscount(data.settings.customer_discount)}</span></div><div class="security-list"><span>供应商 usage 作为 Token 计量来源</span><span>模型配置保存官网输入、缓存和输出价</span><span>充值金额按人民币 1:1 入账</span></div></section></div>`;
  },
  tenants() {
    setPageMeta('TENANTS', '客户管理', '<button class="button primary" data-action="new-tenant">新增客户</button>');
    const rows = state.admin.tenants;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>客户账户</h2><p>每个客户拥有独立登录、余额、Key、模型和计量记录。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>登录邮箱</th><th>余额</th><th>已开模型</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${rows.map((t) => `<tr><td><strong>${escapeHtml(t.name)}</strong></td><td>${escapeHtml(t.owner_email || '-')}</td><td>${formatMicros(t.balance_micros)}</td><td>${t.model_count}</td><td>${statusTag(t.active)}</td><td>${formatDate(t.created_at)}</td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('还没有客户', '先创建第一个客户账户')}</div></section>`;
  },
  routes() {
    const data = state.admin;
    setPageMeta('MODEL ROUTING', '模型配置', '<button class="button secondary" data-action="new-credential">录入供应商 Key</button><button class="button primary" data-action="new-route">添加模型</button>');
    $('#pageContent').innerHTML = `<div class="content-grid"><section class="panel span-3"><div class="panel-head"><div><h2>已上架模型</h2><p>客户只看到对外模型 ID 和官网价格；供应商信息仅管理员可见。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>展示名称</th><th>对外模型 ID</th><th>供应商模型 ID</th><th>官网价（输入 / 缓存 / 输出）</th><th>状态</th><th></th></tr></thead><tbody>${data.routes.map((r) => `<tr><td>${escapeHtml(r.tenant_name)}</td><td>${escapeHtml(r.display_name)}</td><td><code>${escapeHtml(r.public_model_id)}</code></td><td><code>${escapeHtml(r.upstream_model_id)}</code></td><td>${formatMoney(r.official_input_cny_per_million)} / ${formatMoney(r.official_cached_input_cny_per_million)} / ${formatMoney(r.official_output_cny_per_million)}</td><td>${statusTag(r.active)}</td><td><button class="button text" data-action="edit-route" data-id="${r.id}">价格</button><button class="button text" data-action="toggle-route" data-id="${r.id}" data-active="${!r.active}">${r.active ? '下架' : '上架'}</button></td></tr>`).join('')}</tbody></table>${data.routes.length ? '' : emptyState('还没有上架模型', '录入凭证后为客户添加模型')}</div></section>
      <section class="panel span-3"><div class="panel-head"><div><h2>供应商凭证</h2><p>Key 已加密，页面不会回显明文。</p></div></div><div class="credential-grid">${data.credentials.map((c) => `<article><span>${escapeHtml(c.tenant_name)}</span><strong>${escapeHtml(c.label)}</strong><code>${escapeHtml(c.base_url)}</code><small>${escapeHtml(c.protocol)}${c.supplier_group ? ` · ${escapeHtml(c.supplier_group)}` : ''}</small></article>`).join('') || emptyState('还没有凭证', '为客户录入独立的供应商 Key')}</div></section></div>`;
  },
  pricing() {
    const data = state.admin;
    const discount = Number(data.settings.customer_discount);
    setPageMeta('DISCOUNT', '折扣设置', '<button class="button primary" data-action="edit-discount">修改折扣</button>');
    $('#pageContent').innerHTML = `<div class="metrics-grid">
      ${metric('当前折扣', formatDiscount(discount), `官网价 × ${discount.toFixed(2)}`, 'green')}
      ${metric('已定价模型', data.routes.filter((route) => route.active).length, '每个客户模型独立官网价')}
      ${metric('余额单位', '人民币', '充值金额 1:1 入账')}
      ${metric('计量来源', 'Token', '供应商响应 usage')}
    </div><div class="content-grid">
      <section class="panel span-2"><div class="panel-head"><div><h2>结算公式</h2><p>各类 Token 分别按模型官网价计算，再应用统一折扣。</p></div></div><div class="formula-box"><div><span>官网金额</span><strong>输入 + 缓存输入 + 输出</strong></div><div><span>客户实扣</span><strong>官网金额 × ${discount.toFixed(2)}</strong></div><div><span>余额不足</span><strong>请求前由 API 网关直接拦截</strong></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>商业边界</h2><p>供应商成本不会进入客户页面。</p></div></div><div class="security-list"><span>客户只看到官网价与自己的折扣</span><span>供应商采购折扣仅由你掌握</span><span>每笔日志固化调用时的单价和折扣</span></div></section>
    </div>`;
  },
  orders() {
    setPageMeta('RECHARGE REVIEW', '充值审核');
    const rows = state.admin.orders;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>待确认订单</h2><p>确认收款后按人民币金额入账；同一订单只能确认一次。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>付款金额</th><th>到账余额</th><th>提交时间</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td><strong>${escapeHtml(o.tenant_name)}</strong></td><td>${formatMoney(o.amount_cny)}</td><td>${formatMicros(o.credited_micros)}</td><td>${formatDate(o.created_at)}</td><td><button class="button primary small" data-action="confirm-order" data-id="${o.id}">确认入账</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('没有待审核订单', '新的充值申请会出现在这里')}</div></section>`;
  },
};

function selectOptions(rows, value, label) {
  return rows.map((item) => `<option value="${item[value]}">${escapeHtml(item[label])}</option>`).join('');
}

function openModal({ title, kicker, body, submit = '保存', onSubmit }) {
  $('#modalTitle').textContent = title;
  $('#modalKicker').textContent = kicker;
  $('#modalBody').innerHTML = body;
  $('#modalSubmit').textContent = submit;
  $('#modalError').textContent = '';
  $('#modalForm').onsubmit = async (event) => {
    if (event.submitter?.value === 'cancel') {
      event.preventDefault();
      $('#modal').close();
      return;
    }
    event.preventDefault();
    try {
      await onSubmit(Object.fromEntries(new FormData(event.currentTarget)));
      $('#modal').close();
      await refreshData();
      showView(state.view);
    } catch (error) { $('#modalError').textContent = error.message; }
  };
  $('#modal').showModal();
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'new-key') openModal({ title: '生成 API Key', kicker: 'NEW CREDENTIAL', body: '<label>Key 名称<input name="name" placeholder="例如：production" required /></label>', submit: '生成', onSubmit: async (values) => {
    const result = await api('/api/customer/keys', { method: 'POST', body: values });
    await navigator.clipboard.writeText(result.secret).catch(() => {});
    alert(`请立即保存，完整 Key 只显示一次：\n\n${result.secret}`);
  } });
  if (action === 'toggle-key') { await api(`/api/customer/keys/${button.dataset.id}`, { method: 'PATCH', body: { active: button.dataset.active === 'true' } }); await refreshData(); showView('keys'); }
  if (action === 'recharge') { await api('/api/customer/recharge-orders', { method: 'POST', body: { amountCny: Number(button.dataset.amount) } }); toast('充值订单已提交，等待管理员确认'); await refreshData(); showView('billing'); }
  if (action === 'new-tenant') openModal({ title: '新增客户', kicker: 'NEW TENANT', body: '<label>客户名称<input name="name" required /></label><div class="form-grid"><label>登录邮箱<input name="ownerEmail" type="email" required /></label><label>初始密码<input name="ownerPassword" type="password" minlength="8" required /></label></div>', onSubmit: (values) => api('/api/admin/tenants', { method: 'POST', body: values }) });
  if (action === 'new-credential') openModal({ title: '录入供应商凭证', kicker: 'UPSTREAM CREDENTIAL', body: `<label>所属客户<select name="tenantId" required>${selectOptions(state.admin.tenants, 'id', 'name')}</select></label><div class="form-grid"><label>凭证名称<input name="label" placeholder="例如：客户A主线路" required /></label><label>协议<select name="protocol"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label></div><label>Base URL<input name="baseUrl" placeholder="https://example.com/v1" required /></label><label>供应商 API Key<input name="apiKey" type="password" autocomplete="off" required /></label><label>分组/线路（可选）<input name="supplierGroup" /></label>`, onSubmit: (values) => api('/api/admin/credentials', { method: 'POST', body: values }) });
  if (action === 'new-route') openModal({ title: '上架客户模型', kicker: 'MODEL ROUTE', body: `<label>所属客户<select name="tenantId" required>${selectOptions(state.admin.tenants, 'id', 'name')}</select></label><label>供应商凭证<select name="credentialId" required>${state.admin.credentials.map((c) => `<option value="${c.id}">${escapeHtml(c.tenant_name)} · ${escapeHtml(c.label)}</option>`).join('')}</select></label><div class="form-grid"><label>客户看到的模型 ID<input name="publicModelId" placeholder="claude-sonnet" required /></label><label>供应商模型 ID<input name="upstreamModelId" placeholder="控制台中的精确名称" required /></label></div><label>展示名称<input name="displayName" placeholder="例如：Claude Sonnet" required /></label><div class="form-grid"><label>官网输入价（元 / 1M）<input name="inputPrice" type="number" min="0" step="0.0001" required /></label><label>官网缓存输入价（元 / 1M）<input name="cachedInputPrice" type="number" min="0" step="0.0001" required /></label></div><label>官网输出价（元 / 1M）<input name="outputPrice" type="number" min="0" step="0.0001" required /></label><div class="form-hint">价格只用于按供应商返回的 Token 用量计算客户账单。</div>`, submit: '上架模型', onSubmit: (values) => api('/api/admin/routes', { method: 'POST', body: values }) });
  if (action === 'edit-route') {
    const route = state.admin.routes.find((item) => item.id === button.dataset.id);
    openModal({ title: '修改模型官网价', kicker: 'MODEL PRICING', body: `<div class="form-hint">${escapeHtml(route.display_name)} · 每 1M Token 人民币价格</div><div class="form-grid"><label>输入价<input name="inputPrice" type="number" min="0" step="0.0001" value="${Number(route.official_input_cny_per_million)}" required /></label><label>缓存输入价<input name="cachedInputPrice" type="number" min="0" step="0.0001" value="${Number(route.official_cached_input_cny_per_million)}" required /></label></div><label>输出价<input name="outputPrice" type="number" min="0" step="0.0001" value="${Number(route.official_output_cny_per_million)}" required /></label>`, onSubmit: (values) => api(`/api/admin/routes/${route.id}`, { method: 'PATCH', body: values }) });
  }
  if (action === 'toggle-route') { await api(`/api/admin/routes/${button.dataset.id}`, { method: 'PATCH', body: { active: button.dataset.active === 'true' } }); await refreshData(); showView('routes'); }
  if (action === 'edit-discount') openModal({ title: '修改客户折扣', kicker: 'CUSTOMER DISCOUNT', body: `<label>折扣系数<input name="customerDiscount" type="number" min="0.01" max="1" step="0.01" value="${Number(state.admin.settings.customer_discount)}" required /></label><div class="pricing-preview"><span>客户展示</span><strong>${formatDiscount(state.admin.settings.customer_discount)}</strong><small>例如 0.8 表示官网价格的 8 折；你的供应商采购成本不会展示给客户。</small></div>`, onSubmit: (values) => api('/api/admin/settings', { method: 'PATCH', body: values }) });
  if (action === 'confirm-order') { if (!confirm('确认已收款并为客户入账？')) return; await api(`/api/admin/recharge-orders/${button.dataset.id}/confirm`, { method: 'POST' }); toast('订单已确认并完成入账'); await refreshData(); showView('orders'); }
}

document.addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]');
  if (view) showView(view.dataset.view);
  const action = event.target.closest('[data-action]');
  if (action) handleAction(action).catch((error) => toast(error.message));
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/auth/login', { method: 'POST', body: values });
    await boot();
  } catch (error) { $('#loginError').textContent = error.message; }
});

$('#logoutButton').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });

async function boot() {
  try {
    state.me = await api('/api/me');
    await refreshData();
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    const user = state.me.user;
    $('#userName').textContent = user.display_name;
    $('#userEmail').textContent = user.email;
    $('#avatar').textContent = user.display_name.slice(0, 1).toUpperCase();
    state.view = 'overview';
    renderNav();
    showView('overview');
  } catch {
    $('#authScreen').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
  }
}

boot();
