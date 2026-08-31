import { authenticateAdminRequest } from "./auth.ts";
import type { AppEnv } from "./env.ts";
import { json, methodNotAllowed } from "./http.ts";

export async function handleAdminUiRequest(request: Request, env: AppEnv) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  await authenticateAdminRequest(request, env);
  const pathname = new URL(request.url).pathname;

  if (pathname === "/admin" || pathname === "/admin/") {
    return asset(HTML, "text/html; charset=utf-8", {
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "script-src 'self'",
        "style-src 'self'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
  }

  if (pathname === "/admin/app.js") {
    return asset(JAVASCRIPT, "text/javascript; charset=utf-8");
  }

  if (pathname === "/admin/styles.css") {
    return asset(CSS, "text/css; charset=utf-8");
  }

  return json({ message: "CMS AI管理画面が見つかりません。" }, 404);
}

function asset(body: string, contentType: string, headers: HeadersInit = {}) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      ...headers,
    },
  });
}

const HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CMS AI 権限管理</title>
    <link rel="stylesheet" href="/admin/styles.css">
    <script src="/admin/app.js" defer></script>
  </head>
  <body>
    <main class="shell">
      <header class="page-header">
        <p class="eyebrow">Acecore CMS AI</p>
        <h1>サイト別の利用権限</h1>
        <p>Cloudflare Accessで本人確認した利用者へ、chat・editor・adminを割り当てます。</p>
      </header>

      <section class="card" aria-labelledby="site-title">
        <div class="toolbar">
          <label for="site-select" id="site-title">管理するサイト</label>
          <select id="site-select"></select>
        </div>
        <p id="site-detail" class="muted"></p>
      </section>

      <section class="card" aria-labelledby="grant-title">
        <h2 id="grant-title">権限を追加・変更</h2>
        <form id="membership-form">
          <label>メールアドレス
            <input id="principal-email" name="principalEmail" type="email" autocomplete="off" required maxlength="320">
          </label>
          <label>権限
            <select id="role" name="role" required>
              <option value="chat">chat — 会話のみ</option>
              <option value="editor">editor — 会話とPR作成</option>
              <option value="admin">admin — editor + 権限管理</option>
            </select>
          </label>
          <button type="submit">保存</button>
        </form>
        <p id="form-status" class="status" role="status"></p>
      </section>

      <section class="card" aria-labelledby="members-title">
        <h2 id="members-title">登録済み利用者</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>メール</th><th>権限</th><th>状態</th><th><span class="sr-only">操作</span></th></tr></thead>
            <tbody id="members"></tbody>
          </table>
        </div>
        <p id="empty" class="muted" hidden>登録済みの利用者はいません。</p>
      </section>
    </main>
  </body>
</html>`;

const CSS = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #172033;
  background: #f4f7fb;
}
* { box-sizing: border-box; }
body { margin: 0; }
button, input, select { font: inherit; }
.shell { width: min(68rem, calc(100% - 2rem)); margin: 0 auto; padding: 3rem 0 5rem; }
.page-header { margin-bottom: 1.5rem; }
.page-header h1 { margin: .2rem 0 .55rem; font-size: clamp(1.8rem, 5vw, 2.7rem); }
.page-header p { max-width: 48rem; margin: 0; color: #516078; }
.eyebrow { color: #3158d4 !important; font-size: .75rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.card { margin-top: 1rem; border: 1px solid #d9e1ef; border-radius: .85rem; background: #fff; padding: 1.15rem; box-shadow: 0 .6rem 1.8rem rgb(24 39 75 / 6%); }
.card h2 { margin: 0 0 1rem; font-size: 1.05rem; }
.toolbar { display: flex; align-items: center; gap: 1rem; }
.toolbar label { font-weight: 750; }
.toolbar select { min-width: min(24rem, 100%); }
form { display: grid; grid-template-columns: minmax(15rem, 1fr) minmax(12rem, .65fr) auto; align-items: end; gap: .8rem; }
label { display: grid; gap: .35rem; font-size: .8rem; font-weight: 700; }
input, select { width: 100%; min-height: 2.65rem; border: 1px solid #9dabc1; border-radius: .5rem; background: #fff; padding: .55rem .7rem; color: inherit; }
input:focus, select:focus, button:focus-visible { outline: 3px solid rgb(49 88 212 / 25%); outline-offset: 1px; }
button { min-height: 2.65rem; border: 0; border-radius: .5rem; background: #3158d4; padding: .55rem .9rem; color: #fff; font-weight: 750; cursor: pointer; }
button:hover { background: #2447ba; }
button.secondary { min-height: 2.15rem; background: #eef2ff; padding: .35rem .6rem; color: #2743a2; font-size: .75rem; }
button.danger { background: #fff0f0; color: #a92727; }
button:disabled { cursor: wait; opacity: .6; }
.muted, .status { color: #65738a; font-size: .82rem; }
.status { min-height: 1.25rem; margin-bottom: 0; }
.status.error { color: #af2525; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th, td { border-bottom: 1px solid #e7ebf3; padding: .75rem .55rem; text-align: left; }
th { color: #637087; font-size: .72rem; text-transform: uppercase; }
td.actions { display: flex; justify-content: end; gap: .45rem; }
.badge { display: inline-flex; border-radius: 999px; background: #edf1f8; padding: .22rem .55rem; font-size: .73rem; font-weight: 750; }
.badge.disabled { background: #f5eeee; color: #8c5050; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
@media (max-width: 44rem) {
  .shell { padding-top: 1.5rem; }
  .toolbar, form { display: grid; grid-template-columns: 1fr; }
  .toolbar select { min-width: 0; }
}`;

const JAVASCRIPT = `(() => {
  const siteSelect = document.querySelector('#site-select')
  const siteDetail = document.querySelector('#site-detail')
  const form = document.querySelector('#membership-form')
  const emailInput = document.querySelector('#principal-email')
  const roleInput = document.querySelector('#role')
  const formStatus = document.querySelector('#form-status')
  const members = document.querySelector('#members')
  const empty = document.querySelector('#empty')
  let sites = []

  initialize().catch((error) => setStatus(error.message || '管理情報を読み込めませんでした。', true))

  siteSelect.addEventListener('change', () => loadMemberships().catch(handleError))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const siteId = siteSelect.value
    if (!siteId) return
    setBusy(true)
    setStatus('保存しています。')
    try {
      await api('/admin/api/memberships', {
        body: JSON.stringify({ principalEmail: emailInput.value, role: roleInput.value, siteId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      })
      emailInput.value = ''
      roleInput.value = 'chat'
      setStatus('権限を保存しました。')
      await loadMemberships()
    } catch (error) {
      handleError(error)
    } finally {
      setBusy(false)
    }
  })

  async function initialize() {
    const payload = await api('/admin/api/session')
    sites = Array.isArray(payload.sites) ? payload.sites : []
    siteSelect.replaceChildren()
    if (!sites.length) {
      siteSelect.append(new Option('管理できるサイトがありません', ''))
      siteSelect.disabled = true
      form.querySelectorAll('input, select, button').forEach((element) => { element.disabled = true })
      siteDetail.textContent = 'D1へ初期adminを登録すると、管理対象が表示されます。'
      return
    }
    for (const site of sites) siteSelect.append(new Option(site.displayName, site.id))
    await loadMemberships()
  }

  async function loadMemberships() {
    const site = sites.find((item) => item.id === siteSelect.value)
    if (!site) return
    siteDetail.textContent = site.repository + ' · ' + site.canonicalUrl
    const payload = await api('/admin/api/memberships?siteId=' + encodeURIComponent(site.id))
    renderMembers(Array.isArray(payload.memberships) ? payload.memberships : [])
  }

  function renderMembers(items) {
    members.replaceChildren()
    empty.hidden = items.length !== 0
    for (const item of items) {
      const row = document.createElement('tr')
      const email = document.createElement('td')
      const role = document.createElement('td')
      const state = document.createElement('td')
      const actions = document.createElement('td')
      email.textContent = item.principalEmail || ''
      role.textContent = item.role || ''
      const badge = document.createElement('span')
      badge.className = 'badge' + (item.enabled ? '' : ' disabled')
      badge.textContent = item.enabled ? '有効' : '無効'
      state.append(badge)
      actions.className = 'actions'
      const edit = button('編集', 'secondary', () => {
        emailInput.value = item.principalEmail || ''
        roleInput.value = item.role || 'chat'
        emailInput.focus()
      })
      const revoke = button('無効化', 'secondary danger', () => revokeMember(item.principalEmail))
      revoke.disabled = !item.enabled
      actions.append(edit, revoke)
      row.append(email, role, state, actions)
      members.append(row)
    }
  }

  async function revokeMember(principalEmail) {
    if (!window.confirm(principalEmail + ' のCMS AI権限を無効にしますか？')) return
    setBusy(true)
    try {
      await api('/admin/api/memberships', {
        body: JSON.stringify({ principalEmail, siteId: siteSelect.value }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      })
      setStatus('権限を無効にしました。')
      await loadMemberships()
    } catch (error) {
      handleError(error)
    } finally {
      setBusy(false)
    }
  }

  function button(label, className, listener) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = className
    element.textContent = label
    element.addEventListener('click', listener)
    return element
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : '処理できませんでした。')
    return payload
  }

  function setBusy(value) {
    form.querySelectorAll('input, select, button').forEach((element) => { element.disabled = value })
  }

  function setStatus(message, error = false) {
    formStatus.textContent = message || ''
    formStatus.classList.toggle('error', error)
  }

  function handleError(error) {
    setStatus(error instanceof Error ? error.message : '処理できませんでした。', true)
  }
})()`;
