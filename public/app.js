const state = {
  me: null, customer: null, admin: null, view: 'overview',
  usageFilters: { startAt: '', endAt: '' }, ledgerFilters: { startAt: '', endAt: '' },
  paymentPollTimer: null,
};

const customerNav = [
  ['overview', '总览', '⌂'], ['models', '可用模型', '◇'], ['keys', 'API Key', '⌁'],
  ['docs', '使用说明', '⌘'], ['usage', '计量日志', '▥'], ['billing', '充值与账本', '◈'], ['account', '账号安全', '⚿'],
];
const adminNav = [
  ['overview', '运营总览', '⌂'], ['tenants', '客户管理', '◎'], ['routes', '模型配置', '◇'], ['keys', 'API Key', '⌁'],
  ['pricing', '计费说明', '％'], ['orders', '充值审核', '◈'], ['docs', '使用说明', '⌘'],
];

const $ = (selector) => document.querySelector(selector);
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const formatMoney = (value) => `¥${Number(value || 0).toFixed(2)}`;
const formatPower = (value, digits = 2) => `${(Number(value || 0) / 1_000_000).toFixed(digits)} 电力`;
const formatPowerPrice = (value) => `${Number(value || 0).toFixed(4)} 电力`;
const formatFactor = (value) => Number.isFinite(Number(value)) ? `×${Number(value).toFixed(2)}` : '-';
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

function protocolLabel(protocol) {
  return protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 协议';
}

function pagination(name, pageInfo) {
  const totalPages = Math.max(1, Math.ceil(Number(pageInfo.total || 0) / Number(pageInfo.pageSize || 10)));
  return `<div class="pagination"><span>第 ${pageInfo.page} / ${totalPages} 页 · 共 ${pageInfo.total} 条</span><button class="button secondary small" data-action="${name}-page" data-page="${pageInfo.page - 1}" ${pageInfo.page <= 1 ? 'disabled' : ''}>上一页</button><button class="button secondary small" data-action="${name}-page" data-page="${pageInfo.page + 1}" ${pageInfo.page >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
}

function filterBar(name, filters) {
  return `<div class="filter-bar"><label>开始日期<input id="${name}StartAt" type="date" value="${escapeHtml(filters.startAt)}" /></label><label>结束日期<input id="${name}EndAt" type="date" value="${escapeHtml(filters.endAt)}" /></label><button class="button secondary" data-action="${name}-filter">筛选</button><button class="button secondary" data-action="${name}-export">按时间导出 CSV</button></div>`;
}

function renderNav() {
  const admin = state.me.user.role === 'admin';
  const nav = admin ? adminNav : customerNav;
  $('#roleLabel').textContent = admin ? '管理员后台' : 'API 控制台';
  $('#navList').innerHTML = nav.map(([id, label, icon]) => `
    <button class="nav-item ${state.view === id ? 'active' : ''}" data-view="${id}" type="button"><i>${icon}</i><span>${label}</span></button>
  `).join('');
  $('#noticeBell').classList.toggle('hidden', admin);
  if (!admin) {
    const unread = state.customer?.notices?.some((notice) => !notice.is_read);
    $('#noticeDot').classList.toggle('hidden', !unread);
    $('#noticeBell').classList.toggle('active', state.view === 'notices');
  }
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
    setPageMeta('DASHBOARD', '总览', '<button class="button secondary" data-view="docs">查看使用说明</button>');
    $('#pageContent').innerHTML = `
      <div class="metrics-grid">
        ${metric('账户余额', formatPower(data.tenant.balance_micros, 4), '电力是结算单位', Number(data.tenant.balance_micros) > 0 ? 'green' : 'amber')}
        ${metric('可用服务', data.models.filter((m) => m.active).length, '托管部署与自助模型')}
        ${metric('未读通知', data.notices.filter((n) => !n.is_read).length, '价格发布后保留在控制台')}
        ${metric('累计消耗', formatPower(used, 6), '最近 100 条调用记录')}
      </div>
      <div class="content-grid">
        <section class="panel span-2"><div class="panel-head"><div><h2>快速接入</h2><p>支持 OpenAI 与 Anthropic 原生协议，只需替换地址和 Key。</p></div></div>
          <div class="config-list"><div><span>Base URL</span><code>${escapeHtml(data.publicBaseUrl)}/v1</code></div><div><span>认证方式</span><code>Authorization: Bearer sk-...</code></div><div><span>模型发现</span><code>GET /v1/models</code></div></div>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>账户状态</h2><p>余额检查在网关调用前执行。</p></div>${statusTag(Number(data.tenant.balance_micros) > Number(data.tenant.reserved_micros), '可调用', '需充值')}</div>
          <div class="balance-bar"><span style="width:${Math.min(100, Math.max(4, Number(data.tenant.balance_micros) / 500000))}%"></span></div>
          <p class="panel-note">处理中预留 ${formatPower(data.tenant.reserved_micros, 6)}；请求完成后按实际 Token 和当次价格版本结算。</p>
        </section>
      </div>`;
  },
  models() {
    setPageMeta('MODEL CATALOG', '可用模型');
    const rows = state.customer.models;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>已开通模型</h2><p>调用时使用下方模型 ID；新增模型请联系管理员开通。</p></div></div>
      <div class="model-grid">${rows.length ? rows.map((m) => `<article class="model-item"><span class="model-icon">${m.service_mode === 'managed' ? '托管' : 'API'}</span><div><strong>${escapeHtml(m.display_name)}</strong><code>${escapeHtml(m.public_model_id)}</code><small>${protocolLabel(m.protocol)} · ${m.service_mode === 'managed' ? '托管部署' : '开发者网关'}</small><small>成交价：输入 ${formatPowerPrice(m.customer_input_power_per_million)} · 输出 ${formatPowerPrice(m.customer_output_power_per_million)} / 1M Token</small><small>官方参考：输入 ${formatPowerPrice(m.reference_input_power_per_million)} · 输出 ${formatPowerPrice(m.reference_output_power_per_million)} · V${m.pricing_version}</small></div>${statusTag(m.active)}</article>`).join('') : emptyState('暂未开通服务', '管理员配置后会显示在这里')}</div></section>`;
  },
  keys() {
    setPageMeta('CREDENTIALS', 'API Key', '<button class="button primary" data-action="new-key">生成 Key</button>');
    const rows = state.customer.keys;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>访问密钥</h2><p>页面始终遮盖完整 Key；需要时可直接复制到剪贴板。</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>名称</th><th>Key</th><th>模式 / 模型</th><th>协议</th><th>状态</th><th>最近使用</th><th></th></tr></thead><tbody>${rows.map((k) => `<tr><td><strong>${escapeHtml(k.name)}</strong></td><td><code>${escapeHtml(k.key_prefix)}</code></td><td>${k.access_mode === 'managed' ? '托管部署' : '开发者网关'}<span class="cell-note">${escapeHtml(k.route_name || '模型已失效')} · ${escapeHtml(k.public_model_id || '-')}</span></td><td>${protocolLabel(k.protocol)}</td><td>${statusTag(k.active)}</td><td>${formatDate(k.last_used_at)}</td><td>${k.can_copy ? `<button class="button text" data-action="copy-key" data-id="${k.id}">复制</button>` : '<span class="cell-note">旧 Key 不可恢复</span>'}<button class="button text" data-action="toggle-key" data-id="${k.id}" data-active="${!k.active}">${k.active ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('还没有 API Key', '生成一个 Key 后即可开始调用')}</div></section>`;
  },
  notices() {
    const rows = state.customer.notices;
    setPageMeta('PRICING NOTICES', '价格通知');
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>价格通知</h2><p>每次发布新价格都会保留一条通知，离线期间也不会丢失。</p></div></div><div class="notice-list">${rows.map((n) => `<article class="notice-item ${n.is_read ? '' : 'unread'}"><div><span class="tag ${n.is_read ? 'muted' : 'success'}">${n.is_read ? '已读' : '新通知'}</span><h3>${escapeHtml(n.title)}</h3><p>${escapeHtml(n.body)}</p><small>V${n.pricing_version || '-'} · ${formatDate(n.created_at)}</small></div>${n.is_read ? '' : `<button class="button secondary small" data-action="read-notice" data-id="${n.id}">标记已读</button>`}</article>`).join('') || emptyState('暂无通知', '价格更新后会显示在这里')}</div></section>`;
  },
  legacyDocs() {
    const base = `${state.customer.publicBaseUrl}/v1`;
    setPageMeta('DOCUMENTATION', '接入说明');
    $('#pageContent').innerHTML = `<section class="panel docs"><div class="panel-head"><div><h2>按模型协议接入</h2><p>每枚 Key 绑定一个模型和协议；OpenAI 与 Anthropic 保持各自原生格式，不做跨协议转换。</p></div></div>
      <div class="step"><b>01</b><div><h3>设置 Base URL</h3><code>${escapeHtml(base)}</code></div></div>
      <div class="step"><b>02</b><div><h3>查询模型</h3><pre>curl ${escapeHtml(base)}/models \\\n  -H "Authorization: Bearer sk-your-key"</pre></div></div>
      <div class="step"><b>03</b><div><h3>发送请求</h3><pre>curl ${escapeHtml(base)}/chat/completions \\\n  -H "Authorization: Bearer sk-your-key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"your-model-id","messages":[{"role":"user","content":"你好"}]}'</pre></div></div>
      <div class="step"><b>04</b><div><h3>读取价格与通知</h3><pre>GET ${escapeHtml(base)}/pricing
GET ${escapeHtml(base)}/notices</pre><p class="panel-note">请求使用同一枚 Bearer Key。每次模型响应都会带 <code>X-S-Pricing-Version</code> 及当前成交价、官方参考价响应头。</p></div></div>
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
  docs() {
    const base = `${state.customer.publicBaseUrl}/v1`;
    setPageMeta('USER GUIDE', '使用说明');
    $('#pageContent').innerHTML = `<section class="panel docs"><div class="panel-head"><div><h2>第一次使用，从这里开始</h2><p>你只需要准备三个东西：接口地址（Base URL）、API Key、模型 ID。三项都可以在本控制台找到。</p></div></div>
      <div class="guide-callout"><strong>最重要的规则</strong><span>每枚 Key 已绑定一个模型和一种协议。OpenAI 模型走 OpenAI 接口，Anthropic 模型走 Anthropic 接口，二者请求格式不能混用。</span></div><div class="guide-callout"><strong>微信充值怎么到账？</strong><span>打开“充值与账本”，选择套餐或点击“自定义充值”后使用微信扫码。二维码 15 分钟内有效，支付成功后系统自动增加电力。订单保存创建时的人民币汇率，之后改价不会影响这笔订单。</span></div>
      <div class="step"><b>01</b><div><h3>确认可用模型和协议</h3><p>打开左侧“可用模型”，找到要使用的模型。复制模型卡片中的模型 ID，并记住它标注的是 <strong>OpenAI 协议</strong>还是 <strong>Anthropic 协议</strong>。模型 ID 必须原样填写，不能自己改名。</p></div></div>
      <div class="step"><b>02</b><div><h3>生成或复制 API Key</h3><p>打开“API Key”，点击“生成 Key”，依次填写名称、模式并选择模型。生成后会自动复制；以后也可以点击列表中的“复制”。页面只显示遮盖后的 Key，这是正常的。</p><p class="panel-note">Key 相当于密码，请放进服务器环境变量，不要写进公开代码、截图、群聊或 Git 仓库。怀疑泄露时请立即停用并重新生成。</p></div></div>
      <div class="step"><b>03</b><div><h3>填写统一接口地址</h3><div class="config-list"><div><span>Base URL</span><code>${escapeHtml(base)}</code></div><div><span>API Key</span><code>sk-live-...</code></div><div><span>Model</span><code>从“可用模型”复制的模型 ID</code></div></div><p class="panel-note">大多数第三方软件只需要填写这三项。原来已经支持 OpenAI/Anthropic 自定义地址的软件，一般不需要改业务代码。</p></div></div>
      <div class="step"><b>04</b><div><h3>OpenAI 协议示例</h3><p>OpenAI 模型使用 <code>/chat/completions</code> 或 <code>/responses</code>。下面命令中的 Key 和模型 ID 需要替换成你自己的。</p><pre>curl ${escapeHtml(base)}/chat/completions \\
  -H "Authorization: Bearer sk-your-key" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"your-model-id","messages":[{"role":"user","content":"你好"}]}'</pre></div></div>
      <div class="step"><b>05</b><div><h3>Anthropic 协议示例</h3><p>Anthropic/Claude 模型使用 <code>/messages</code>，并带上 <code>anthropic-version</code> 请求头。</p><pre>curl ${escapeHtml(base)}/messages \\
  -H "x-api-key: sk-your-key" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"your-model-id","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'</pre></div></div>
      <div class="step"><b>06</b><div><h3>查看价格、余额和使用记录</h3><p>“可用模型”显示成交价、官方参考价和价格版本；“计量日志”显示每次请求的 Token、官方参考消耗、综合倍率和实扣电力；“充值与账本”显示余额变化并可按日期导出 CSV。</p><pre>GET ${escapeHtml(base)}/pricing
GET ${escapeHtml(base)}/notices</pre><p class="panel-note">价格有更新时，左下角铃铛会出现红点。成功响应还会带当前价格版本和成交价等 <code>X-S-*</code> 响应头。</p></div></div>
      <div class="step"><b>07</b><div><h3>密码和账号安全</h3><p>左侧“账号安全”可以验证当前密码后设置新密码。怀疑密码泄露时应立即修改；忘记密码则联系管理员重置临时密码。</p></div></div><div class="step"><b>08</b><div><h3>停用本中转站时怎么切换</h3><p>在你的项目中把 Base URL、API Key 和模型 ID 换成新供应商提供的值即可；确认新接口工作后，再回来停用旧 Key。中转站不要求你修改其他业务逻辑。</p></div></div>
      <h3>常见报错</h3><div class="error-grid"><div><strong>400</strong><span>协议或接口用错，按模型标注改用正确端点</span></div><div><strong>401</strong><span>Key 缺失、复制错误、已停用或已过期</span></div><div><strong>402</strong><span>余额不足，请在充值与账本中提交申请</span></div><div><strong>404</strong><span>模型 ID 错误，或该 Key 没有绑定此模型</span></div><div><strong>502</strong><span>上游暂时不可用，稍后重试并保留请求 ID</span></div></div>
      <h3 class="guide-title">几个容易混淆的词</h3><div class="guide-grid"><article><strong>电力</strong><p>账户余额和调用结算使用的统一单位。</p></article><article><strong>成交价</strong><p>实际扣费使用的输入、缓存输入和输出单价。</p></article><article><strong>官方参考价</strong><p>只用于对比展示，不直接决定本次实扣。</p></article><article><strong>综合倍率</strong><p>本次实际费用与官方参考费用的比值。</p></article></div>
    </section>`;
  },
  usage() {
    setPageMeta('USAGE', '计量日志');
    const rows = state.customer.usage;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>调用日志</h2><p>每页 10 条；可按日期筛选并导出。</p></div></div>${filterBar('usage', state.usageFilters)}<div class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>官方参考</th><th>综合对比</th><th>实扣</th><th>价格版本</th><th>结果</th></tr></thead><tbody>${rows.map((u) => `<tr><td>${formatDate(u.created_at)}</td><td><code>${escapeHtml(u.model_id)}</code></td><td>${formatNumber(u.input_tokens)}</td><td>${formatNumber(u.cached_input_tokens)}</td><td>${formatNumber(u.output_tokens)}</td><td>${formatPower(u.official_cost_micros, 6)}</td><td><span class="tag success">${formatFactor(u.effective_billing_factor)}</span></td><td><strong>${formatPower(u.charged_cost_micros, 6)}</strong></td><td>${escapeHtml(u.pricing_label_snapshot || '-')} · V${u.pricing_version_snapshot || '-'}</td><td><span class="tag ${u.status === 'success' ? 'success' : u.status === 'blocked' ? 'warning' : 'danger'}">${{ success: '成功', blocked: '已拦截', failed: '失败' }[u.status]}</span></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('暂无调用记录', '完成首次模型调用后会显示在这里')}</div>${pagination('usage', state.customer.usagePagination)}</section>`;
  },
  billing() {
    const data = state.customer;
    setPageMeta('BILLING', '充值与账本', `<button class="button primary" data-action="custom-recharge" ${data.wechatPayConfigured ? '' : 'disabled'}>自定义充值</button>`);
    $('#pageContent').innerHTML = `<div class="content-grid"><section class="panel span-2"><div class="panel-head"><div><h2>微信扫码充值</h2><p>当前汇率：1 电力 = ${formatMoney(data.rechargeCnyPerPower)}。订单生成后 15 分钟内有效。</p></div><strong class="balance-total">${formatPower(data.tenant.balance_micros, 4)} <small>余额</small></strong></div><div class="plan-grid">${[10, 50, 100, 500].map((amount) => `<button class="plan" data-action="wechat-recharge" data-amount="${amount}" ${data.wechatPayConfigured ? '' : 'disabled'}><strong>${amount} 电力</strong><span>${formatMoney(amount * data.rechargeCnyPerPower)} · 微信扫码</span></button>`).join('')}</div>${data.wechatPayConfigured ? '' : '<p class="panel-note">微信支付尚未完成服务器配置，请联系管理员；人工充值仍可由管理员处理。</p>'}</section>
      <section class="panel"><div class="panel-head"><div><h2>充值订单</h2><p>微信支付成功后自动入账。</p></div></div><div class="ledger">${data.orders.map((o) => { const label = o.status === 'paid' ? '已入账' : o.status === 'cancelled' ? '已失效' : o.payment_channel === 'wechat_native' ? '待支付' : '待确认'; const tone = o.status === 'paid' ? 'success' : o.status === 'cancelled' ? 'muted' : 'warning'; return `<div class="ledger-row"><div><strong>${o.payment_channel === 'wechat_native' ? '微信充值' : '人工充值'} ${formatPower(o.requested_power_micros, 2)}</strong><span>${o.amount_cny ? `${formatMoney(o.amount_cny)} · ` : ''}${o.status === 'paid' ? `实际到账 ${formatPower(o.credited_micros, 4)} · ` : ''}${formatDate(o.created_at)}</span></div><span class="tag ${tone}">${label}</span></div>`; }).join('') || emptyState('暂无充值订单', '选择电力数量生成微信支付二维码')}</div></section>
      <section class="panel span-3"><div class="panel-head"><div><h2>账本流水</h2><p>每页 10 条；可按日期筛选并导出。</p></div></div>${filterBar('ledger', state.ledgerFilters)}<div class="table-wrap"><table><thead><tr><th>时间</th><th>项目</th><th>类型</th><th>变动前</th><th>余额变动</th><th>变动后</th></tr></thead><tbody>${data.ledger.map((l) => `<tr><td>${formatDate(l.created_at)}</td><td>${escapeHtml(l.title)}</td><td>${escapeHtml(l.type)}</td><td>${formatPower(l.balance_before_micros, 6)}</td><td class="${Number(l.amount_micros) > 0 ? 'positive' : 'negative'}">${Number(l.amount_micros) > 0 ? '+' : ''}${formatPower(l.amount_micros, 6)}</td><td>${formatPower(l.balance_after_micros, 6)}</td></tr>`).join('')}</tbody></table>${data.ledger.length ? '' : emptyState('暂无账本流水', '充值或调用后会显示在这里')}</div>${pagination('ledger', data.ledgerPagination)}</section></div>`;
  },
  account() {
    setPageMeta('ACCOUNT SECURITY', '账号安全');
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>登录密码</h2><p>定期修改密码；新密码至少 8 位。</p></div><button class="button primary" data-action="change-password">修改密码</button></div><div class="security-list"><span>当前登录账号：${escapeHtml(state.me.user.email)}</span><span>修改时必须先验证当前密码</span><span>密码只保存安全哈希，管理员无法查看原密码</span></div></section>`;
  },
};

const adminViews = {
  overview() {
    const data = state.admin;
    const balance = data.tenants.reduce((sum, t) => sum + Number(t.balance_micros), 0);
    setPageMeta('OPERATIONS', '运营总览', '<button class="button primary" data-action="new-tenant">新增客户</button>');
    $('#pageContent').innerHTML = `<div class="metrics-grid">${metric('客户账户', data.tenants.length, '多租户独立账本')}${metric('已配置服务', data.routes.filter((r) => r.active).length, '托管部署与开发者网关')}${metric('待审核充值', data.orders.length, '需要确认入账', data.orders.length ? 'amber' : '')}${metric('客户总余额', formatPower(balance, 4), '不含处理中预留')}</div>
      <div class="content-grid"><section class="panel span-2"><div class="panel-head"><div><h2>开通流程</h2><p>供应商 Key 和模型已经合并到同一个添加向导。</p></div></div><div class="ops-list"><div><b>1</b><span><strong>创建使用账户</strong><small>生成独立登录和电力余额</small></span></div><div><b>2</b><span><strong>添加 API 服务</strong><small>一次完成供应商 Key、模型 ID 和价格设置</small></span></div><div><b>3</b><span><strong>生成交付 Key</strong><small>绑定模型后即可交付调用</small></span></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>当前计费</h2><p>每个 API 服务独立定价。</p></div><span class="tag success">电力结算</span></div><div class="security-list"><span>电力是结算单位</span><span>成交价直接计费，官方价只做参考</span><span>供应商成本仅管理员可见</span></div></section></div>`;
  },
  tenants() {
    setPageMeta('TENANTS', '客户管理', '<button class="button primary" data-action="new-tenant">新增客户</button>');
    const rows = state.admin.tenants;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>客户账户</h2><p>每个客户拥有独立登录、电力余额、Key、服务和计量记录。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>登录账号</th><th>电力余额</th><th>已开服务</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td><strong>${escapeHtml(t.name)}</strong></td><td>${escapeHtml(t.owner_account || '-')}</td><td>${formatPower(t.balance_micros, 4)}</td><td>${t.model_count}</td><td>${statusTag(t.active)}</td><td>${formatDate(t.created_at)}</td><td>${t.owner_user_id ? `<button class="button text" data-action="reset-customer-password" data-user-id="${t.owner_user_id}" data-account="${escapeHtml(t.owner_account)}">重置密码</button>` : ''}</td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('还没有客户', '先创建第一个客户账户')}</div></section>`;
  },
  routes() {
    const data = state.admin;
    setPageMeta('MODEL ROUTING', '模型配置', '<button class="button primary" data-action="new-route">添加 API 服务</button>');
    $('#pageContent').innerHTML = `<div class="content-grid"><section class="panel span-3"><div class="panel-head"><div><h2>已上架 API 服务</h2><p>客户价用于实际扣费；官方参考价和倍率只展示；采购成本仅管理员可见。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户 / 模式</th><th>对外服务</th><th>协议 / 供应商模型</th><th>客户价（输入 / 输出）</th><th>官方参考</th><th>版本</th><th>状态</th><th></th></tr></thead><tbody>${data.routes.map((r) => `<tr><td>${escapeHtml(r.tenant_name)}<span class="cell-note">${r.service_mode === 'managed' ? '托管部署' : '开发者网关'}</span></td><td><strong>${escapeHtml(r.display_name)}</strong><code>${escapeHtml(r.public_model_id)}</code></td><td><strong>${protocolLabel(r.protocol)}</strong><code>${escapeHtml(r.upstream_model_id)}</code><span class="cell-note">成本 ${formatPowerPrice(r.upstream_input_power_per_million)} / ${formatPowerPrice(r.upstream_output_power_per_million)}</span></td><td>${formatPowerPrice(r.customer_input_power_per_million)} / ${formatPowerPrice(r.customer_output_power_per_million)}</td><td>${formatPowerPrice(r.reference_input_power_per_million)} / ${formatPowerPrice(r.reference_output_power_per_million)}</td><td>${escapeHtml(r.pricing_label)} · V${r.pricing_version}</td><td>${statusTag(r.active)}</td><td><button class="button text" data-action="edit-route" data-id="${r.id}">发布价格</button><button class="button text" data-action="toggle-route" data-id="${r.id}" data-active="${!r.active}">${r.active ? '下架' : '上架'}</button></td></tr>`).join('')}</tbody></table>${data.routes.length ? '' : emptyState('还没有 API 服务', '录入凭证后为客户添加服务')}</div></section>
      <section class="panel span-3"><div class="panel-head"><div><h2>供应商连接</h2><p>通常每个账户只需要一枚 YYLX Key，可供该账户的多个模型重复使用。</p></div></div><div class="credential-grid">${data.credentials.map((c) => `<article><span>${escapeHtml(c.tenant_name)} · ${Number(c.route_count)} 个服务使用</span><strong>${escapeHtml(c.label)}</strong><code>${escapeHtml(c.base_url)}</code><small>${protocolLabel(c.protocol)} · ${c.active ? '启用' : '停用'}</small><div><button class="button secondary small" data-action="edit-credential" data-id="${c.id}">编辑</button><button class="button text small" data-action="delete-credential" data-id="${c.id}" data-routes="${c.route_count}" ${Number(c.route_count) ? 'disabled title="正在被 API 服务使用，只能先停用"' : ''}>删除</button></div></article>`).join('') || emptyState('还没有供应商连接', '点击“添加 API 服务”时直接粘贴供应商 Key')}</div></section></div>`;
  },
  keys() {
    const rows = state.admin.keys;
    setPageMeta('CREDENTIALS', 'API Key', '<button class="button primary" data-action="new-admin-key">生成 Key</button>');
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>全部访问密钥</h2><p>管理员可直接为托管部署或开发者网关生成、复制和停用 Key，无需切换页面。</p></div></div><div class="table-wrap"><table><thead><tr><th>所属账户</th><th>名称 / Key</th><th>模式</th><th>模型 / 协议</th><th>状态</th><th>最近使用</th><th></th></tr></thead><tbody>${rows.map((k) => `<tr><td><strong>${escapeHtml(k.tenant_name)}</strong></td><td>${escapeHtml(k.name)}<code>${escapeHtml(k.key_prefix)}</code></td><td>${k.access_mode === 'managed' ? '托管部署' : '开发者网关'}</td><td>${escapeHtml(k.route_name || '模型已失效')}<span class="cell-note">${escapeHtml(k.public_model_id || '-')} · ${protocolLabel(k.protocol)}</span></td><td>${statusTag(k.active)}</td><td>${formatDate(k.last_used_at)}</td><td>${k.can_copy ? `<button class="button text" data-action="copy-admin-key" data-id="${k.id}">复制</button>` : '<span class="cell-note">旧 Key 不可恢复</span>'}<button class="button text" data-action="toggle-admin-key" data-id="${k.id}" data-active="${!k.active}">${k.active ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('还没有 API Key', '从这里直接为任意已配置服务生成')}</div></section>`;
  },
  pricing() {
    const data = state.admin;
    setPageMeta('BILLING MODEL', '计费说明');
    $('#pageContent').innerHTML = `<div class="metrics-grid">
      ${metric('计价服务', data.routes.filter((route) => route.active).length, '每个 API 服务独立价格', 'green')}
      ${metric('余额单位', '电力', '电力是结算单位')}
      ${metric('价格通知', '自动生成', '每次发布保留一条持久通知')}
      ${metric('计量来源', 'Token', '供应商响应 usage')}
    </div><div class="content-grid">
      <section class="panel span-3"><div class="panel-head"><div><h2>微信充值汇率</h2><p>当前 1 电力收取的人民币金额；修改只影响之后创建的新订单。</p></div><button class="button primary" data-action="edit-recharge-rate">修改汇率</button></div><div class="formula-box"><div><span>当前汇率</span><strong>1 电力 = ${formatMoney(data.settings.recharge_cny_per_power)}</strong></div><div><span>微信支付配置</span><strong>${data.wechatPayConfigured ? '已配置' : '尚未配置'}</strong></div><div><span>历史订单</span><strong>保留下单时的汇率快照</strong></div></div></section>
      <section class="panel span-2"><div class="panel-head"><div><h2>结算公式</h2><p>成交价直接参与计费，倍率只由成交价与官方参考价推导展示。</p></div></div><div class="formula-box"><div><span>客户实扣</span><strong>输入 Token × 客户输入价 + 输出 Token × 客户输出价</strong></div><div><span>展示倍率</span><strong>客户价 ÷ 官方参考价</strong></div><div><span>价格发布</span><strong>版本 +1 并生成通知</strong></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>商业边界</h2><p>供应商成本不会进入客户 API 和页面。</p></div></div><div class="security-list"><span>客户看到成交价和官方参考价</span><span>供应商采购价仅管理员可见</span><span>每笔日志固化调用时的价格版本</span></div></section>
    </div>`;
  },
  docs() {
    const base = `${state.me.publicBaseUrl}/v1`;
    setPageMeta('ADMIN GUIDE', '管理员使用说明');
    $('#pageContent').innerHTML = `<section class="panel docs"><div class="panel-head"><div><h2>从零开通一个 API 服务</h2><p>推荐顺序：创建使用账户 → 添加 API 服务 → 生成交付 Key → 充值。供应商 Key 和模型已经合并为一个向导。</p></div></div>
      <div class="guide-callout warning"><strong>上线前先检查</strong><span>服务器 <code>PUBLIC_BASE_URL</code> 必须是正式域名，例如 <code>https://api.example.com</code>；供应商 Key、管理员密码和加密密钥不要发给任何客户。</span></div>
      <div class="step"><b>01</b><div><h3>创建客户账户</h3><p>进入“客户管理”，点击“新增客户”。客户名称用于后台识别；登录账号和初始密码用于登录使用控制台。账号不要求是邮箱，使用英文、数字或邮箱均可，至少 3 位且不能包含空格。建议每个公司或独立项目建立一个账户，余额、模型、Key 和日志会按账户隔离。</p><p class="panel-note">初始密码至少 8 位。创建后请通过安全渠道交付，并提醒对方不要多人共用登录密码。</p></div></div>
      <div class="step"><b>02</b><div><h3>一次添加供应商 Key 和模型</h3><p>进入“模型配置”点击“添加 API 服务”。选定账户后，系统会自动复用该账户已有的唯一供应商 Key；没有 Key 时直接在同一个窗口粘贴。YYLX Anthropic 地址和协议已经预填。</p><div class="guide-callout"><strong>一个账户建几枚供应商 Key？</strong><span>通常只需要一枚。YYLX 创建 Key 时已经选择了分组，分组价格由那枚 Key 决定；中转站不需要再次填写分组。同一枚 Key 可以承载该账户的多个模型。</span></div><div class="guide-grid fields"><article><strong>所属账户</strong><p>决定余额、日志、模型和交付 Key 归属。</p></article><article><strong>供应商连接</strong><p>优先复用已有 Key；只有换供应商账号或线路时才新增。</p></article><article><strong>供应商 API Key</strong><p>只在新增连接时粘贴，系统加密保存且不会回显。</p></article><article><strong>Base URL</strong><p>默认 <code>https://app.yylx.io/v1/messages</code>，可按需修改。</p></article><article><strong>协议</strong><p>默认 Anthropic；接 OpenAI 格式模型时再修改。</p></article><article><strong>服务模式</strong><p>自己写代码接入选开发者网关；你负责维护的项目选托管部署。</p></article></div></div></div>
      <div class="step"><b>03</b><div><h3>填写模型和价格</h3><p>同一个向导继续填写模型信息和三组价格，每个输入框下方都有用途说明。</p><div class="guide-grid fields"><article><strong>对外模型 ID</strong><p>交付并写进项目配置的稳定名称，换上游时尽量保持不变。</p></article><article><strong>供应商模型 ID</strong><p>YYLX 模型列表里的精确名称，必须完全一致。</p></article><article><strong>展示名称</strong><p>控制台里便于人阅读，例如“Dumbo Claude”。</p></article><article><strong>价格标签</strong><p>例如“优惠期”“正式价格”，会随日志和通知展示。</p></article></div>
        <h3>三组价格怎么填</h3><div class="guide-grid"><article><strong>客户成交价</strong><p>实际扣除电力的价格。输入、缓存输入、输出分别按每 100 万 Token 填写。</p></article><article><strong>官方参考价</strong><p>仅供客户对比和计算展示倍率，通常填写模型官方公开价格。</p></article><article><strong>供应商采购成本</strong><p>你向上游实际支付的成本，仅管理员可见，用于判断利润，不参与客户扣费。</p></article><article><strong>缓存输入价</strong><p>供应商有独立缓存价格就照填；没有时可留空，系统会使用普通输入价。</p></article></div><div class="guide-callout"><strong>示例</strong><span>官方输入价 1 电力、你给客户的输入价 0.8 电力，展示倍率就是 0.8；如果备用线路成交价改成 1.2 电力，倍率会显示 1.2。充值余额本身不乘倍率。</span></div>
      </div></div>
      <div class="step"><b>04</b><div><h3>生成交付用 API Key</h3><p>进入管理员“API Key”页面，点击“生成 Key”，填写便于识别的名称并选择服务。系统会自动带出所属账户、模式、模型和协议，并将完整 Key 复制到剪贴板。</p><p>页面以后仍可点击“复制”，但始终只显示遮盖后的内容。建议每个项目、环境或设备单独生成一枚 Key，例如“官网生产”“测试环境”，不要多人共用一枚 Key。</p><div class="config-list"><div><span>交付 Base URL</span><code>${escapeHtml(base)}</code></div><div><span>交付 API Key</span><code>管理员页面复制的 sk-live-...</code></div><div><span>交付 Model</span><code>添加模型时填写的对外模型 ID</code></div></div></div></div>
      <div class="step"><b>05</b><div><h3>配置充值和管理密码</h3><p>“计费说明”中设置 1 电力对应多少人民币。修改只影响新订单，已有二维码保留下单金额。微信支付自动到账，使用方也可以输入自定义电力数量。</p><p>“充值审核”只保留人工订单。忘记密码时，在“客户管理”点击“重置密码”设置临时密码；旧登录会话立即失效，并应提醒对方登录后自行修改。</p><p class="panel-note">电力是统一结算单位；人民币汇率只决定购买电力时的应付金额。</p></div></div>
      <div class="step"><b>06</b><div><h3>修改价格和发送通知</h3><p>在“模型配置”找到服务，点击“发布价格”。填写新成交价、官方参考价、采购成本和通知说明后发布。价格版本会自动加 1，新请求立即使用新价格，历史日志保留旧价格快照。</p><p>客户控制台左下角铃铛会出现红点；接入程序也可通过 <code>GET /v1/notices</code> 读取通知。只有发布价格时生成一次通知，不会随每个请求重复推送。</p></div></div>
      <div class="step"><b>07</b><div><h3>日常维护和故障切换</h3><p>上游模型或线路变化时，在管理员后台调整模型/线路；对外模型 ID 保持不变，客户项目通常无需修改。Key 泄露时只停用对应 Key 并重新生成，不影响同账户其他项目。</p><p>OpenAI 与 Anthropic 目前是<strong>原生协议透传</strong>，不做互相翻译。Anthropic 模型必须请求 <code>/v1/messages</code>；OpenAI 模型使用 <code>/v1/chat/completions</code> 或 <code>/v1/responses</code>。协议选错会返回 <code>protocol_mismatch</code>。</p></div></div>
      <h3>上线自查清单</h3><div class="guide-checklist"><span>正式域名和 HTTPS 可访问</span><span><code>PUBLIC_BASE_URL</code> 已改成正式域名</span><span>供应商 Base URL 与协议匹配</span><span>对外模型 ID 已用真实请求测试</span><span>成交价、官方参考价、采购成本没有填反</span><span>账户已有足够电力</span><span>交付的是中转站 Key，不是供应商 Key</span><span>数据库和服务器 <code>.env</code> 已备份</span></div>
    </section>`;
  },
  orders() {
    setPageMeta('RECHARGE REVIEW', '充值审核');
    const rows = state.admin.orders;
    $('#pageContent').innerHTML = `<section class="panel"><div class="panel-head"><div><h2>待确认订单</h2><p>输入实际到账电力和可选的实收人民币；同一订单只能确认一次。</p></div></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>申请电力</th><th>提交时间</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td><strong>${escapeHtml(o.tenant_name)}</strong></td><td>${formatPower(o.requested_power_micros, 2)}</td><td>${formatDate(o.created_at)}</td><td><button class="button primary small" data-action="confirm-order" data-id="${o.id}">确认入账</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : emptyState('没有待审核订单', '新的充值申请会出现在这里')}</div></section>`;
  },
};

function selectOptions(rows, value, label) {
  return rows.map((item) => `<option value="${item[value]}">${escapeHtml(item[label])}</option>`).join('');
}

function queryFor(filters, page = null) {
  const params = new URLSearchParams();
  if (page) params.set('page', page);
  if (filters.startAt) params.set('startAt', filters.startAt);
  if (filters.endAt) params.set('endAt', filters.endAt);
  return params.toString();
}

async function loadPaged(name, page = 1) {
  const filters = name === 'usage' ? state.usageFilters : state.ledgerFilters;
  const result = await api(`/api/customer/${name}?${queryFor(filters, page)}`);
  state.customer[name] = result.data;
  state.customer[`${name}Pagination`] = result.pagination;
  showView(name === 'usage' ? 'usage' : 'billing');
}

function downloadExport(name) {
  const filters = name === 'usage' ? state.usageFilters : state.ledgerFilters;
  const link = document.createElement('a');
  link.href = `/api/customer/export/${name}?${queryFor(filters)}`;
  link.click();
}

async function copySecret(url) {
  const result = await api(url);
  await navigator.clipboard.writeText(result.secret);
  toast('完整 Key 已复制，页面不会显示明文');
}

function openModal({ title, kicker, body, submit = '保存', onSubmit, afterSubmit }) {
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
      const result = await onSubmit(Object.fromEntries(new FormData(event.currentTarget)));
      $('#modal').close();
      await refreshData();
      showView(state.view);
      if (afterSubmit) await afterSubmit(result);
    } catch (error) { $('#modalError').textContent = error.message; }
  };
  $('#modal').showModal();
}

function stopPaymentPolling() {
  if (state.paymentPollTimer) clearTimeout(state.paymentPollTimer);
  state.paymentPollTimer = null;
}

function renderPaymentModal(order) {
  $('#modalTitle').textContent = '微信扫码支付';
  $('#modalKicker').textContent = 'WECHAT PAY';
  $('#modalSubmit').textContent = '关闭';
  $('#modalError').textContent = '';
  const statusText = order.status === 'paid'
    ? '支付成功，电力已经到账'
    : order.status === 'expired'
      ? '订单已失效，请关闭后重新创建'
      : order.status === 'failed' ? '订单创建失败' : '请使用微信扫描二维码付款';
  $('#modalBody').innerHTML = `<div class="payment-box"><div class="payment-summary"><span>${formatPower(order.requestedPowerMicros, 2)}</span><strong>${formatMoney(order.amountCny)}</strong><small>汇率快照：1 电力 = ${formatMoney(order.cnyPerPower)}</small></div>${order.qrCodeDataUrl ? `<img class="payment-qr" src="${escapeHtml(order.qrCodeDataUrl)}" alt="微信支付二维码" />` : ''}<p class="payment-status ${order.status}">${statusText}</p><small>二维码有效期至 ${formatDate(order.expiresAt)}</small></div>`;
  $('#modalForm').onsubmit = (event) => { event.preventDefault(); stopPaymentPolling(); $('#modal').close(); };
}

function showPaymentOrder(order) {
  stopPaymentPolling();
  renderPaymentModal(order);
  $('#modal').showModal();
  state.paymentPollTimer = setTimeout(() => pollPayment(order.id), 2000);
}

async function pollPayment(orderId) {
  try {
    const order = await api(`/api/customer/pay/wechat/orders/${orderId}`);
    renderPaymentModal(order);
    if (order.status === 'paid') {
      stopPaymentPolling();
      await refreshData();
      toast('支付成功，电力已经到账');
      showView('billing');
      return;
    }
    if (['expired', 'failed', 'closed'].includes(order.status)) { stopPaymentPolling(); return; }
  } catch (error) {
    $('#modalError').textContent = error.message;
  }
  state.paymentPollTimer = setTimeout(() => pollPayment(orderId), 2000);
}

function credentialOptionsForTenant(tenantId) {
  const rows = state.admin.credentials.filter((item) => item.tenant_id === tenantId && item.active);
  const existing = rows.map((item) => `<option value="${item.id}">${escapeHtml(item.label)} · ${protocolLabel(item.protocol)}</option>`).join('');
  return `${existing}<option value="">＋粘贴一枚新的 YYLX Key</option>`;
}

function serviceFormBody() {
  const firstTenant = state.admin.tenants[0];
  return `<div class="guide-callout"><strong>最省心的用法</strong><span>一个账户通常只在 YYLX 创建一枚 Key。这枚 Key 可以重复用于该账户的多个模型；只有更换供应商账号或线路时，才需要再粘贴新 Key。</span></div>
    <h3>1. 这项服务给谁用</h3><div class="form-grid"><label>所属账户<select id="serviceTenantId" name="tenantId" required>${selectOptions(state.admin.tenants, 'id', 'name')}</select><small class="field-help">决定余额、日志、模型和交付 Key 归属哪个账户。</small></label><label>服务模式<select name="serviceMode"><option value="self_service">开发者网关</option><option value="managed">托管部署</option></select><small class="field-help">自己写代码接 API 选开发者网关；你负责交付维护的项目选托管部署。</small></label></div>
    <h3>2. 连接供应商</h3><label>使用哪枚供应商 Key<select id="serviceCredentialId" name="credentialId">${credentialOptionsForTenant(firstTenant?.id)}</select><small class="field-help">已有 Key 会自动复用；没有时选择最后一项并粘贴新 Key。</small></label>
    <div id="newServiceCredentialFields"><div class="form-grid"><label>连接名称<input id="serviceCredentialLabel" name="credentialLabel" value="${escapeHtml(firstTenant ? `${firstTenant.name} · YYLX` : 'YYLX Anthropic')}" /><small class="field-help">只供你在后台识别，例如“Dumbo · YYLX”。</small></label><label>协议<select name="credentialProtocol"><option value="anthropic" selected>Anthropic</option><option value="openai">OpenAI</option></select><small class="field-help">YYLX Claude 默认使用 Anthropic；需要接 OpenAI 模型时再改。</small></label></div><label>供应商 Base URL<input name="credentialBaseUrl" value="https://app.yylx.io/v1/messages" /><small class="field-help">已预填 YYLX Anthropic 地址，供应商地址变化时才需要修改。</small></label><label>供应商 API Key<input id="serviceApiKey" name="apiKey" type="password" autocomplete="off" /><small class="field-help">粘贴 YYLX 为这个账户创建的 Key；系统加密保存且不会回显。</small></label></div>
    <h3>3. 填写模型</h3><div class="form-grid"><label>对外模型 ID<input name="publicModelId" placeholder="例如：dumbo-claude" required /><small class="field-help">交付给使用方、写进项目配置的稳定名称；以后换上游时可保持不变。</small></label><label>供应商模型 ID<input name="upstreamModelId" placeholder="粘贴 YYLX 模型列表中的精确名称" required /><small class="field-help">必须与供应商模型列表完全一致，实际请求会使用它。</small></label></div><div class="form-grid"><label>展示名称<input name="displayName" placeholder="例如：Dumbo Claude" required /><small class="field-help">控制台里便于人阅读的名称。</small></label><label>价格标签<input name="pricingLabel" value="当前价格" required /><small class="field-help">例如“优惠期”“正式价格”，会进入日志和价格通知。</small></label></div>
    <h3>4. 设置价格（电力 / 100 万 Token）</h3><p class="form-hint">成交价决定实际扣费；官方参考价只用于展示对比；采购成本只给管理员核算利润。</p><h3>成交价</h3><div class="form-grid three"><label>输入<input name="customerInputPrice" type="number" min="0" step="0.000001" required /></label><label>缓存输入（可选）<input name="customerCachedInputPrice" type="number" min="0" step="0.000001" /></label><label>输出<input name="customerOutputPrice" type="number" min="0" step="0.000001" required /></label></div><h3>官方参考价</h3><div class="form-grid three"><label>输入<input name="referenceInputPrice" type="number" min="0" step="0.000001" required /></label><label>缓存输入（可选）<input name="referenceCachedInputPrice" type="number" min="0" step="0.000001" /></label><label>输出<input name="referenceOutputPrice" type="number" min="0" step="0.000001" required /></label></div><h3>供应商采购成本（仅管理员可见）</h3><div class="form-grid three"><label>输入<input name="upstreamInputPrice" type="number" min="0" step="0.000001" value="0" required /></label><label>缓存输入（可选）<input name="upstreamCachedInputPrice" type="number" min="0" step="0.000001" /></label><label>输出<input name="upstreamOutputPrice" type="number" min="0" step="0.000001" value="0" required /></label></div>`;
}

function syncServiceCredentialFields() {
  const tenantId = $('#serviceTenantId').value;
  const select = $('#serviceCredentialId');
  const existingRows = state.admin.credentials.filter((item) => item.tenant_id === tenantId && item.active);
  select.innerHTML = credentialOptionsForTenant(tenantId);
  select.value = existingRows[0]?.id || '';
  const tenant = state.admin.tenants.find((item) => item.id === tenantId);
  $('#serviceCredentialLabel').value = tenant ? `${tenant.name} · YYLX` : 'YYLX Anthropic';
  toggleNewServiceCredentialFields();
}

function toggleNewServiceCredentialFields() {
  const isNew = !$('#serviceCredentialId').value;
  $('#newServiceCredentialFields').classList.toggle('hidden', !isNew);
  $('#serviceApiKey').required = isNew;
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'close-modal') { stopPaymentPolling(); $('#modal').close(); return; }
  if (action === 'change-password') {
    openModal({ title: '修改登录密码', kicker: 'ACCOUNT SECURITY', body: '<label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required /></label><label>新密码<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required /></label><label>再次输入新密码<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required /></label>', submit: '修改密码', onSubmit: async (values) => {
      if (values.newPassword !== values.confirmPassword) throw new Error('两次输入的新密码不一致');
      const result = await api('/api/me/password', { method: 'PATCH', body: values });
      toast('密码修改成功');
      return result;
    } });
  }
  if (action === 'new-key') {
    const available = state.customer.models.filter((route) => route.active);
    const renderRouteOptions = (mode) => available.filter((route) => route.service_mode === mode).map((route) => `<option value="${route.id}">${escapeHtml(route.display_name)} · ${escapeHtml(route.public_model_id)} · ${protocolLabel(route.protocol)}</option>`).join('');
    openModal({ title: '生成 API Key', kicker: 'NEW CREDENTIAL', body: `<label>名称<input name="name" placeholder="例如：production" required /></label><label>模式<select id="keyAccessMode" name="accessMode"><option value="self_service">开发者网关</option><option value="managed">托管部署</option></select></label><label>使用模型<select id="keyRouteId" name="routeId" required>${renderRouteOptions('self_service')}</select></label><p class="form-hint">Key 只允许调用选中的模型。协议由模型配置决定，OpenAI 与 Anthropic 请求格式不互相转换。</p>`, submit: '生成并复制', onSubmit: async (values) => {
    const result = await api('/api/customer/keys', { method: 'POST', body: values });
    await navigator.clipboard.writeText(result.secret);
    toast('Key 已生成并复制');
    } });
    $('#keyAccessMode').addEventListener('change', (event) => { $('#keyRouteId').innerHTML = renderRouteOptions(event.target.value); });
  }
  if (action === 'copy-key') await copySecret(`/api/customer/keys/${button.dataset.id}/secret`);
  if (action === 'toggle-key') { await api(`/api/customer/keys/${button.dataset.id}`, { method: 'PATCH', body: { active: button.dataset.active === 'true' } }); await refreshData(); showView('keys'); }
  if (action === 'read-notice') { await api(`/api/customer/notices/${button.dataset.id}/read`, { method: 'POST' }); await refreshData(); showView('notices'); }
  if (action === 'wechat-recharge') {
    button.disabled = true;
    try {
      const order = await api('/api/customer/pay/wechat/native', { method: 'POST', body: { requestedPower: Number(button.dataset.amount) } });
      showPaymentOrder(order);
    } finally { button.disabled = false; }
  }
  if (action === 'custom-recharge') {
    const rate = Number(state.customer.rechargeCnyPerPower);
    openModal({ title: '自定义微信充值', kicker: 'CUSTOM RECHARGE', body: `<label>充值电力<input id="customPowerInput" name="requestedPower" type="number" min="0.000001" max="100000" step="0.000001" value="10" required /></label><div class="pricing-preview"><span>预计微信支付</span><strong id="customRechargePreview">${formatMoney(10 * rate)}</strong><small>最终金额由服务端按当前汇率重新计算</small></div>`, submit: '生成微信支付二维码', onSubmit: (values) => api('/api/customer/pay/wechat/native', { method: 'POST', body: { requestedPower: Number(values.requestedPower) } }), afterSubmit: showPaymentOrder });
    $('#customPowerInput').addEventListener('input', (event) => {
      const amount = Number(event.target.value);
      $('#customRechargePreview').textContent = Number.isFinite(amount) && amount > 0 ? formatMoney(amount * rate) : '—';
    });
  }
  if (action === 'usage-filter' || action === 'ledger-filter') {
    const name = action.startsWith('usage') ? 'usage' : 'ledger';
    state[`${name}Filters`] = { startAt: $(`#${name}StartAt`).value, endAt: $(`#${name}EndAt`).value };
    await loadPaged(name, 1);
  }
  if (action === 'usage-page' || action === 'ledger-page') await loadPaged(action.startsWith('usage') ? 'usage' : 'ledger', Number(button.dataset.page));
  if (action === 'usage-export' || action === 'ledger-export') downloadExport(action.startsWith('usage') ? 'usage' : 'ledger');
  if (action === 'new-tenant') openModal({ title: '新增客户', kicker: 'NEW TENANT', body: '<label>客户名称<input name="name" required /></label><div class="form-grid"><label>登录账号<input name="ownerAccount" type="text" minlength="3" autocomplete="off" required /></label><label>初始密码<input name="ownerPassword" type="password" minlength="8" required /></label></div><p class="form-hint">账号不要求是邮箱，至少 3 位且不能包含空格；英文、数字或邮箱均可。</p>', onSubmit: (values) => api('/api/admin/tenants', { method: 'POST', body: values }) });
  if (action === 'edit-credential') {
    const credential = state.admin.credentials.find((item) => item.id === button.dataset.id);
    openModal({ title: '编辑供应商连接', kicker: 'UPSTREAM CONNECTION', body: `<div class="guide-callout"><strong>${escapeHtml(credential.tenant_name)}</strong><span>这枚供应商 Key 正在被 ${Number(credential.route_count)} 个 API 服务使用。修改地址或协议会同时影响这些服务；Key 不更换时必须留空。</span></div><div class="form-grid"><label>连接名称<input name="label" value="${escapeHtml(credential.label)}" required /><small class="field-help">只用于后台识别。</small></label><label>协议<select name="protocol"><option value="anthropic" ${credential.protocol === 'anthropic' ? 'selected' : ''}>Anthropic</option><option value="openai" ${credential.protocol === 'openai' ? 'selected' : ''}>OpenAI</option></select></label></div><label>Base URL<input name="baseUrl" value="${escapeHtml(credential.base_url)}" required /></label><label>更换供应商 API Key<input name="apiKey" type="password" autocomplete="off" placeholder="不修改请留空" /></label><label>状态<select name="active"><option value="true" ${credential.active ? 'selected' : ''}>启用</option><option value="false" ${credential.active ? '' : 'selected'}>停用</option></select></label>`, onSubmit: (values) => api(`/api/admin/credentials/${credential.id}`, { method: 'PATCH', body: { ...values, active: values.active === 'true' } }) });
  }
  if (action === 'delete-credential') {
    if (!window.confirm('确定删除这枚未使用的供应商连接吗？删除后无法恢复。')) return;
    await api(`/api/admin/credentials/${button.dataset.id}`, { method: 'DELETE' });
    toast('供应商连接已删除');
    await refreshData();
    showView('routes');
  }
  if (action === 'reset-customer-password') {
    openModal({ title: '重置登录密码', kicker: 'ADMIN RESET', body: `<div class="form-hint">账号：${escapeHtml(button.dataset.account)}。重置后请通过安全渠道告知对方，并让其登录后立即修改。</div><label>新的临时密码<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required /></label><label>再次输入<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required /></label>`, submit: '确认重置', onSubmit: async (values) => {
      if (values.newPassword !== values.confirmPassword) throw new Error('两次输入的密码不一致');
      const result = await api(`/api/admin/users/${button.dataset.userId}/password`, { method: 'PATCH', body: values });
      toast('临时密码已重置');
      return result;
    } });
  }
  if (action === 'new-admin-key') {
    const routes = state.admin.routes.filter((route) => route.active);
    openModal({ title: '生成 API Key', kicker: 'ADMIN CREDENTIAL', body: `<label>名称<input name="name" placeholder="例如：我的托管项目" required /></label><label>服务与模型<select name="routeId" required>${routes.map((route) => `<option value="${route.id}">${escapeHtml(route.tenant_name)} · ${route.service_mode === 'managed' ? '托管部署' : '开发者网关'} · ${escapeHtml(route.display_name)} · ${protocolLabel(route.protocol)}</option>`).join('')}</select></label><p class="form-hint">所属账户和访问模式会根据选中的服务自动确定。</p>`, submit: '生成并复制', onSubmit: async (values) => { const result = await api('/api/admin/keys', { method: 'POST', body: values }); await navigator.clipboard.writeText(result.secret); toast('Key 已生成并复制'); } });
  }
  if (action === 'copy-admin-key') await copySecret(`/api/admin/keys/${button.dataset.id}/secret`);
  if (action === 'toggle-admin-key') { await api(`/api/admin/keys/${button.dataset.id}`, { method: 'PATCH', body: { active: button.dataset.active === 'true' } }); await refreshData(); showView('keys'); }
  if (action === 'new-route') {
    if (!state.admin.tenants.length) { toast('请先创建一个使用账户'); return; }
    openModal({ title: '添加 API 服务', kicker: 'ONE-STEP SETUP', body: serviceFormBody(), submit: '保存服务', onSubmit: (values) => api('/api/admin/routes', { method: 'POST', body: values }) });
    syncServiceCredentialFields();
    $('#serviceTenantId').addEventListener('change', syncServiceCredentialFields);
    $('#serviceCredentialId').addEventListener('change', toggleNewServiceCredentialFields);
  }
  if (action === 'edit-route') {
    const route = state.admin.routes.find((item) => item.id === button.dataset.id);
    openModal({ title: '发布新价格', kicker: `PRICING V${Number(route.pricing_version) + 1}`, body: `<div class="form-hint">${escapeHtml(route.display_name)} · 发布后立即生效，自动生成客户通知。</div><div class="form-grid"><label>价格标签<input name="pricingLabel" value="${escapeHtml(route.pricing_label)}" required /></label><label>客户通知<input name="notificationBody" placeholder="说明本次价格调整" /></label></div><h3>客户成交价</h3><div class="form-grid three"><label>输入<input name="customerInputPrice" type="number" min="0" step="0.000001" value="${route.customer_input_power_per_million}" required /></label><label>缓存输入<input name="customerCachedInputPrice" type="number" min="0" step="0.000001" value="${route.customer_cached_input_power_per_million}" required /></label><label>输出<input name="customerOutputPrice" type="number" min="0" step="0.000001" value="${route.customer_output_power_per_million}" required /></label></div><h3>官方参考价</h3><div class="form-grid three"><label>输入<input name="referenceInputPrice" type="number" min="0" step="0.000001" value="${route.reference_input_power_per_million}" required /></label><label>缓存输入<input name="referenceCachedInputPrice" type="number" min="0" step="0.000001" value="${route.reference_cached_input_power_per_million}" required /></label><label>输出<input name="referenceOutputPrice" type="number" min="0" step="0.000001" value="${route.reference_output_power_per_million}" required /></label></div><h3>供应商采购成本</h3><div class="form-grid three"><label>输入<input name="upstreamInputPrice" type="number" min="0" step="0.000001" value="${route.upstream_input_power_per_million}" required /></label><label>缓存输入<input name="upstreamCachedInputPrice" type="number" min="0" step="0.000001" value="${route.upstream_cached_input_power_per_million}" required /></label><label>输出<input name="upstreamOutputPrice" type="number" min="0" step="0.000001" value="${route.upstream_output_power_per_million}" required /></label></div>`, submit: '发布并通知客户', onSubmit: (values) => api(`/api/admin/routes/${route.id}`, { method: 'PATCH', body: values }) });
  }
  if (action === 'edit-recharge-rate') {
    openModal({ title: '修改微信充值汇率', kicker: 'RECHARGE RATE', body: `<div class="form-hint">修改只影响新订单；已创建订单继续按原汇率和金额支付。</div><label>1 电力 = 人民币<input name="cnyPerPower" type="number" min="0.000001" max="100000" step="0.000001" value="${state.admin.settings.recharge_cny_per_power}" required /></label>`, submit: '保存新汇率', onSubmit: (values) => api('/api/admin/settings/recharge', { method: 'PATCH', body: values }) });
  }
  if (action === 'toggle-route') { await api(`/api/admin/routes/${button.dataset.id}`, { method: 'PATCH', body: { active: button.dataset.active === 'true' } }); await refreshData(); showView('routes'); }
  if (action === 'confirm-order') {
    const order = state.admin.orders.find((item) => item.id === button.dataset.id);
    const requested = Number(order.requested_power_micros) / 1_000_000;
    openModal({ title: '确认充值入账', kicker: 'POWER CREDIT', body: `<div class="form-hint">${escapeHtml(order.tenant_name)} 申请 ${requested} 电力。</div><label>实际到账电力<input name="creditedPower" type="number" min="0.000001" step="0.000001" value="${requested}" required /></label><label>实收人民币（可选，仅用于订单对账）<input name="amountCny" type="number" min="0.01" step="0.01" /></label>`, submit: '确认入账', onSubmit: (values) => api(`/api/admin/recharge-orders/${order.id}/confirm`, { method: 'POST', body: values }) });
  }
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
